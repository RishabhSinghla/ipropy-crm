/**
 * A WhatsApp number dropping, and OpenWA itself going away, each tell the admins once; coming back tells them once.
 * A pretend OpenWA stands in, so no real number is touched. "Time" is the `now` argument, not a sleep.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/pool.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { __resetOpenWaCaches, OPENWA_PROVIDER } from '../../src/integrations/whatsapp/business/openwa.js';
import { GRACE_MS, runNumberWatch } from '../../src/integrations/whatsapp/business/numberAlerts.js';
import { SEEDED } from './fixtures.js';
import { startFakeOpenWa, type FakeOpenWa } from '../fakes/fakeOpenWa.js';

vi.mock('../../src/integrations/email/service.js', () => ({ sendEmail: vi.fn(async () => ({ id: '', status: 'suppressed' })) }));

const SESSION = `alerttest${String(Date.now()).slice(-6)}`;
let fake: FakeOpenWa;
let repId = '';
let adminCount = 0;
const previouslyActive: string[] = [];
const t0 = new Date();
const after = (ms: number): Date => new Date(t0.getTime() + ms);

const card = async (baseUrl: string): Promise<void> => {
  await saveIntegration(OPENWA_PROVIDER, {
    config: { baseUrl, sessionName: SESSION },
    credentials: { apiKey: fake.apiKey, webhookSecret: 'integration-webhook-secret-123456' },
    isActive: true,
  });
  await reloadIntegrations();
  __resetOpenWaCaches();
};

const sent = async (kind: string, like: string): Promise<number> =>
  Number((await db.queryOne<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ipy_notification WHERE kind = $1 AND title LIKE $2`, [kind, like],
  ))?.n ?? 0);

beforeAll(async () => {
  fake = await startFakeOpenWa({ sessionName: SESSION });
  const active = await db.query(`SELECT provider FROM ipy_integration WHERE provider LIKE 'whatsapp\\_%' AND is_active`);
  previouslyActive.push(...active.rows.map((r) => String((r as { provider: string }).provider)));
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider LIKE 'whatsapp\\_%'`);
  await card(fake.baseUrl);
  repId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = $1`, [SEEDED.executiveA]))!.id;
  adminCount = Number((await db.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ipy_user WHERE is_admin AND is_active AND deleted_at IS NULL`))!.n);
  await db.query(`UPDATE ipy_wa_number SET user_id = NULL WHERE user_id = $1`, [repId]);
  await db.query(`INSERT INTO ipy_wa_number (session_name, user_id, status, status_since) VALUES ($1, $2, 'ready', $3)`, [SESSION, repId, t0]);
  await db.query(`DELETE FROM ipy_setting WHERE key = 'whatsapp.openwa_service'`);
});

afterAll(async () => {
  await fake.close();
  await db.query(`DELETE FROM ipy_wa_number WHERE session_name = $1`, [SESSION]);
  await db.query(`DELETE FROM ipy_notification WHERE kind IN ('whatsapp_down','whatsapp_back') AND (title LIKE $1 OR title LIKE '%OpenWA%')`, [`%${SESSION}%`]);
  await db.query(`DELETE FROM ipy_setting WHERE key = 'whatsapp.openwa_service'`);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = $1`, [OPENWA_PROVIDER]);
  for (const provider of previouslyActive) {
    if (provider !== OPENWA_PROVIDER) await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = $1`, [provider]);
  }
  await reloadIntegrations();
});

describe('a WhatsApp number disconnecting', () => {
  it('stays quiet while healthy and for a short blip, then tells every admin once, then says it is back', async () => {
    await runNumberWatch(after(1000));
    expect(await sent('whatsapp_down', `%${SESSION}%`)).toBe(0);

    fake.status = 'disconnected';
    await runNumberWatch(after(10_000)); // status flips; the clock starts now
    const flipped = await db.queryOne<{ status: string; status_since: Date }>(`SELECT status, status_since FROM ipy_wa_number WHERE session_name = $1`, [SESSION]);
    expect(flipped!.status).toBe('disconnected');
    expect(await sent('whatsapp_down', `%${SESSION}%`)).toBe(0); // inside the grace period

    // Pretend the outage started GRACE_MS + a bit ago.
    await db.query(`UPDATE ipy_wa_number SET status_since = now() - interval '5 minutes' WHERE session_name = $1`, [SESSION]);
    await runNumberWatch(new Date());
    expect(await sent('whatsapp_down', `%${SESSION}%`)).toBe(adminCount);
    expect((await db.queryOne<{ a: Date | null }>(`SELECT alerted_at AS a FROM ipy_wa_number WHERE session_name = $1`, [SESSION]))!.a).not.toBeNull();

    // No spam: the next checks add nothing.
    await runNumberWatch(new Date(Date.now() + 60_000));
    await runNumberWatch(new Date(Date.now() + 120_000));
    expect(await sent('whatsapp_down', `%${SESSION}%`)).toBe(adminCount);

    fake.status = 'ready';
    await runNumberWatch(new Date(Date.now() + 180_000));
    expect(await sent('whatsapp_back', `%${SESSION}%`)).toBe(adminCount);
    expect((await db.queryOne<{ a: Date | null }>(`SELECT alerted_at AS a FROM ipy_wa_number WHERE session_name = $1`, [SESSION]))!.a).toBeNull();

    await runNumberWatch(new Date(Date.now() + 240_000));
    expect(await sent('whatsapp_back', `%${SESSION}%`)).toBe(adminCount); // recovery is also once
  });
});

describe('OpenWA itself being unreachable', () => {
  it('alerts once after the grace period and says when the service is back', async () => {
    await card('http://127.0.0.1:1'); // nothing listens here
    await runNumberWatch(after(0));
    expect(await sent('whatsapp_down', '%OpenWA%')).toBe(0);
    await runNumberWatch(after(GRACE_MS + 5_000));
    expect(await sent('whatsapp_down', '%OpenWA%')).toBe(adminCount);
    await runNumberWatch(after(GRACE_MS + 65_000));
    expect(await sent('whatsapp_down', '%OpenWA%')).toBe(adminCount);

    await card(fake.baseUrl);
    await runNumberWatch(after(GRACE_MS + 125_000));
    expect(await sent('whatsapp_back', '%OpenWA%')).toBe(adminCount);
  });
});
