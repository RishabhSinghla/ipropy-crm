/**
 * The two ends of the n8n wire.
 *
 * Both halves have a failure mode that is invisible from the outside, which is
 * why they are tested here rather than trusted:
 *
 *  * **Outbound.** If the handoff ever throws or blocks, a rep standing outside
 *    a building loses the ability to close a site visit. The call must fail
 *    quietly and return, whatever n8n does — including not existing.
 *  * **Inbound.** `/api/webhooks/n8n/content-ready` sits on the router mounted
 *    *ahead* of requireAuth, so it is reachable by anyone who finds the URL. It
 *    raises notifications. An unset secret must therefore refuse everything; the
 *    tempting default — no secret configured means no check — turns it into a
 *    megaphone for strangers.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createServer } from 'node:http';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { createApp } from '../../src/app.js';
import { adminContext } from './fixtures.js';
import { createRecord } from '../../src/core/entity/recordService.js';
import * as settings from '../../src/core/settings/integrations.js';

const SECRET = 'n8n-test-secret-value';

let app: ReturnType<typeof createApp>;
let propertyId: string;
let ownerId: string;

/** Overlay just the automation block; everything else keeps its real value. */
function withAutomation(over: Partial<{ n8nWebhookUrl: string; n8nCallbackSecret: string }>) {
  const real = settings.getSettings();
  vi.spyOn(settings, 'getSettings').mockReturnValue({
    ...real,
    automation: { n8nWebhookUrl: '', n8nCallbackSecret: '', ...over },
  } as ReturnType<typeof settings.getSettings>);
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const ctx = await adminContext();
  ownerId = ctx.user!.id;
  const rec = await createRecord(ctx, 'properties', {
    name: `n8n handoff test ${Date.now()}`,
  });
  propertyId = rec.id as string;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await db.query(`DELETE FROM ipy_record WHERE id = $1`, [propertyId]).catch(() => undefined);
});

describe('POST /api/webhooks/n8n/content-ready', () => {
  it('refuses everything when no secret is configured', async () => {
    withAutomation({ n8nCallbackSecret: '' });
    const res = await request(app)
      .post('/api/webhooks/n8n/content-ready')
      .send({ propertyId });
    expect(res.status, 'an unconfigured callback must not be open').toBe(401);
  });

  it('refuses a wrong secret', async () => {
    withAutomation({ n8nCallbackSecret: SECRET });
    const res = await request(app)
      .post('/api/webhooks/n8n/content-ready')
      .set('X-N8N-Secret', 'not-the-secret')
      .send({ propertyId });
    expect(res.status).toBe(401);
  });

  it('refuses a secret of a different length without leaking that fact', async () => {
    // timingSafeEqual throws on a length mismatch; hashing both sides first is
    // what stops that throw becoming a 500 that says "wrong length".
    withAutomation({ n8nCallbackSecret: SECRET });
    const res = await request(app)
      .post('/api/webhooks/n8n/content-ready')
      .set('X-N8N-Secret', 'x')
      .send({ propertyId });
    expect(res.status, 'must be a clean 401, never a 500').toBe(401);
  });

  it('notifies the property owner when the secret is right', async () => {
    withAutomation({ n8nCallbackSecret: SECRET });
    const before = await countNotifications();

    const res = await request(app)
      .post('/api/webhooks/n8n/content-ready')
      .set('X-N8N-Secret', SECRET)
      .send({ propertyId, summary: '9 of 31 photos shortlisted' });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBeGreaterThan(0);

    const rows = await db.query<{ title: string; body: string; link: string }>(
      `SELECT title, body, link FROM ipy_notification
        WHERE record_id = $1 ORDER BY created_at DESC LIMIT 1`, [propertyId],
    );
    expect(await countNotifications()).toBeGreaterThan(before);
    expect(rows.rows[0].body).toBe('9 of 31 photos shortlisted');
    expect(rows.rows[0].link).toBe(`/properties/${propertyId}`);
  });

  it('still tells somebody when the run failed', async () => {
    withAutomation({ n8nCallbackSecret: SECRET });
    await request(app)
      .post('/api/webhooks/n8n/content-ready')
      .set('X-N8N-Secret', SECRET)
      .send({ propertyId, ok: false, summary: 'the model refused every photo' })
      .expect(200);

    const row = await db.queryOne<{ title: string }>(
      `SELECT title FROM ipy_notification WHERE record_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [propertyId],
    );
    expect(row!.title, 'silence is indistinguishable from not started').toMatch(/problem/i);
  });

  it('404s on a property that does not exist rather than notifying nobody quietly', async () => {
    withAutomation({ n8nCallbackSecret: SECRET });
    await request(app)
      .post('/api/webhooks/n8n/content-ready')
      .set('X-N8N-Secret', SECRET)
      .send({ propertyId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
  });
});

describe('the outbound handoff', () => {
  it('does nothing, and says so, when no URL is configured', async () => {
    withAutomation({ n8nWebhookUrl: '' });
    const { notifyPropertyFinished, isConfigured } = await import('../../src/integrations/automation/n8n.js');
    expect(isConfigured()).toBe(false);
    const out = await notifyPropertyFinished(propertyId);
    expect(out.sent).toBe(false);
    expect(out.reason).toMatch(/no n8n webhook URL/i);
  });

  it('never throws when n8n is unreachable', async () => {
    // Port 9 is discard: refused instantly rather than hanging for the timeout.
    withAutomation({ n8nWebhookUrl: 'http://127.0.0.1:9/webhook/nope' });
    const { notifyPropertyFinished } = await import('../../src/integrations/automation/n8n.js');

    const out = await notifyPropertyFinished(propertyId);
    expect(out.sent, 'a dead n8n must not stop a site visit closing').toBe(false);
    expect(typeof out.reason).toBe('string');
  });

  it('skips a property with no folder instead of guessing one', async () => {
    withAutomation({ n8nWebhookUrl: 'http://127.0.0.1:9/webhook/nope' });
    const { notifyPropertyFinished } = await import('../../src/integrations/automation/n8n.js');
    const out = await notifyPropertyFinished(randomUUID());
    expect(out.sent).toBe(false);
    expect(out.reason).toMatch(/no storage folder/i);
  });

  it('sends the folder n8n needs, and nothing it does not', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      await db.query(
        `INSERT INTO ipy_property_storage (record_id, folder_key, status, provisioned_driver)
         VALUES ($1, $2, 'ready', 'onedrive')
         ON CONFLICT (record_id) DO UPDATE SET folder_key = EXCLUDED.folder_key, status = 'ready'`,
        [propertyId, 'IPROPY-PROPERTIES/GREENFIELD/TEST-B12'],
      );

      withAutomation({ n8nWebhookUrl: `http://127.0.0.1:${port}/webhook/shoot` });
      const { notifyPropertyFinished } = await import('../../src/integrations/automation/n8n.js');
      const out = await notifyPropertyFinished(propertyId);

      expect(out.sent).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0].body).toMatchObject({
        propertyId,
        folder: 'IPROPY-PROPERTIES/GREENFIELD/TEST-B12',
      });
      // The shoot session is gone; n8n is told the property and the folder,
      // and works the folder out from there.
      expect(seen[0].body).not.toHaveProperty('sessionId');
      // n8n calls us back, so it must be told where we are.
      expect(String(seen[0].body.crmBaseUrl)).toMatch(/^https?:\/\//);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('will not hand off a folder that is not ready yet', async () => {
    await db.query(`UPDATE ipy_property_storage SET status = 'pending' WHERE record_id = $1`, [propertyId]);
    withAutomation({ n8nWebhookUrl: 'http://127.0.0.1:9/webhook/nope' });
    const { notifyPropertyFinished } = await import('../../src/integrations/automation/n8n.js');
    const out = await notifyPropertyFinished(propertyId);
    expect(out.sent, 'n8n would find an empty folder').toBe(false);
    expect(out.reason).toMatch(/pending|not ready/i);
  });
});

async function countNotifications(): Promise<number> {
  const row = await db.queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM ipy_notification WHERE record_id = $1`, [propertyId],
  );
  return Number(row!.n);
}
