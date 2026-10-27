/**
 * Dealer groups read live from the linked number, against a real database and a pretend OpenWA.
 *
 * What this proves that a unit test cannot: a group nobody switched on keeps nothing; a switched-on group's
 * messages reach the same feed an uploaded export fills, once; the history job fills in what came before
 * and can be pressed twice; and only an administrator can choose or read any of it.
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { __resetOpenWaCaches, OPENWA_PROVIDER } from '../../src/integrations/whatsapp/business/openwa.js';
import { flush, historyJobStatus } from '../../src/core/market/liveGroups.js';
import { SEEDED, adminToken, signIn } from './fixtures.js';
import { startFakeOpenWa, type FakeOpenWa } from '../fakes/fakeOpenWa.js';

const SECRET = 'integration-webhook-secret-123456';
const marker = `itestwag${String(Date.now()).slice(-6)}`;
const DEALER_GROUP = `1203${String(Date.now()).slice(-9)}01@g.us`;
const FAMILY_GROUP = `1203${String(Date.now()).slice(-9)}02@g.us`;
const DEALER_NAME = `Dealers ${marker}`;
const FAMILY_NAME = `Family ${marker}`;

let app: ReturnType<typeof createApp>;
let admin = '';
let rep = '';
let fake: FakeOpenWa;
const previouslyActive: string[] = [];
let counter = 0;

const dealText = (n: number): string => `3 BHK available in ${marker} Greenfields, 1.45 Cr, call 98110${String(10000 + n).slice(-5)} unit ${n}`;

function groupWebhook(groupId: string, groupName: string, body: string) {
  counter += 1;
  const data = {
    id: `3EBG${marker}${counter}`, from: groupId, chatId: groupId, body, type: 'chat', isGroup: true, kind: 'group',
    fromMe: false, groupName, author: '919811111111@c.us', contact: { pushName: 'Ramesh Dealer' },
    timestamp: Math.floor(Date.now() / 1000),
  };
  const raw = JSON.stringify({ event: 'message.received', timestamp: new Date().toISOString(), sessionId: 'company', data });
  return request(app).post('/api/webhooks/whatsapp/openwa').set('content-type', 'application/json')
    .set('x-openwa-signature', `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`).send(raw);
}

/** The server answers 200 before it works (providers retry slow answers), so wait for the work to show. */
async function settled(groupId: string, seen: number): Promise<void> {
  const end = Date.now() + 4000;
  for (;;) {
    const row = await db.queryOne<{ messages_seen: number }>(`SELECT messages_seen FROM ipy_wa_group WHERE id = $1`, [groupId]);
    if ((row?.messages_seen ?? 0) >= seen) return;
    if (Date.now() > end) throw new Error('the group message never reached the group');
    await new Promise((r) => setTimeout(r, 30));
  }
}

const posts = (): Promise<{ rows: Record<string, unknown>[] }> =>
  db.query(`SELECT id, groups FROM ipy_market_post WHERE body ILIKE $1`, [`%${marker}%`]) as never;

beforeAll(async () => {
  app = createApp();
  admin = await adminToken(app);
  rep = await signIn(app, SEEDED.executiveA);
  fake = await startFakeOpenWa({ sessionName: 'company' });
  fake.groups = [{ id: DEALER_GROUP, name: DEALER_NAME }, { id: FAMILY_GROUP, name: FAMILY_NAME }];

  const active = await db.query(`SELECT provider FROM ipy_integration WHERE provider LIKE 'whatsapp\\_%' AND is_active`);
  previouslyActive.push(...active.rows.map((r) => String((r as { provider: string }).provider)));
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider LIKE 'whatsapp\\_%'`);
  await saveIntegration(OPENWA_PROVIDER, {
    config: { baseUrl: fake.baseUrl, sessionName: 'company' },
    credentials: { apiKey: fake.apiKey, webhookSecret: SECRET },
    isActive: true,
  });
  await reloadIntegrations();
  __resetOpenWaCaches();
});

afterAll(async () => {
  await fake.close();
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE $1`, [`%${marker}%`]);
  await db.query(`DELETE FROM ipy_market_group WHERE name = ANY($1)`, [[DEALER_NAME, FAMILY_NAME]]);
  await db.query(`DELETE FROM ipy_wa_group WHERE id = ANY($1)`, [[DEALER_GROUP, FAMILY_GROUP]]);
  await db.query(`DELETE FROM ipy_wa_webhook_event WHERE provider = $1`, [OPENWA_PROVIDER]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = $1`, [OPENWA_PROVIDER]);
  for (const provider of previouslyActive) {
    if (provider !== OPENWA_PROVIDER) await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = $1`, [provider]);
  }
  await reloadIntegrations();
});

describe('who may manage group sync', () => {
  it('refuses a rep on every route, on the server', async () => {
    const as = (method: 'get' | 'post' | 'put', path: string) => request(app)[method](`/api/whatsapp-business${path}`).set('Authorization', `Bearer ${rep}`).send({ enabled: true });
    for (const [method, path] of [['get', '/groups'], ['post', '/groups/refresh'], ['post', '/groups/enable-all'], ['put', `/groups/${DEALER_GROUP}`], ['post', '/groups/import-history']] as const) {
      expect((await as(method, path)).status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('a group nobody switched on', () => {
  it('shows in the list, switched off, and keeps nothing', async () => {
    const refreshed = await request(app).post('/api/whatsapp-business/groups/refresh').set('Authorization', `Bearer ${admin}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.added).toBeGreaterThanOrEqual(2);

    expect((await groupWebhook(FAMILY_GROUP, FAMILY_NAME, dealText(1))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    await flush(FAMILY_GROUP);
    expect((await posts()).rows).toHaveLength(0);

    const list = await request(app).get('/api/whatsapp-business/groups').set('Authorization', `Bearer ${admin}`);
    const family = list.body.groups.find((g: { id: string }) => g.id === FAMILY_GROUP);
    expect(family).toMatchObject({ name: FAMILY_NAME, enabled: false, messagesSeen: 0 });
  });
});

describe('a switched-on group', () => {
  it('feeds the dealer groups once, however many times it is told', async () => {
    const on = await request(app).put(`/api/whatsapp-business/groups/${encodeURIComponent(DEALER_GROUP)}`)
      .set('Authorization', `Bearer ${admin}`).send({ enabled: true });
    expect(on.status).toBe(200);

    await groupWebhook(DEALER_GROUP, DEALER_NAME, dealText(2));
    await groupWebhook(DEALER_GROUP, DEALER_NAME, 'ok thanks');          // chatter: not a deal
    await settled(DEALER_GROUP, 2);
    await flush(DEALER_GROUP);
    const first = await posts();
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]!.groups).toEqual([DEALER_NAME]);

    // The same words again from another webhook delivery are the same deal, not a second one.
    await groupWebhook(DEALER_GROUP, DEALER_NAME, dealText(2));
    await settled(DEALER_GROUP, 3);
    await flush(DEALER_GROUP);
    expect((await posts()).rows).toHaveLength(1);

    // And the family group stays untouched even though the same number is in both.
    await groupWebhook(FAMILY_GROUP, FAMILY_NAME, dealText(3));
    await new Promise((r) => setTimeout(r, 300));
    await flush(FAMILY_GROUP);
    expect((await posts()).rows).toHaveLength(1);
  });

  it('can be switched off again, and what was waiting is dropped', async () => {
    await groupWebhook(DEALER_GROUP, DEALER_NAME, dealText(4));
    await settled(DEALER_GROUP, 4);
    await request(app).put(`/api/whatsapp-business/groups/${encodeURIComponent(DEALER_GROUP)}`)
      .set('Authorization', `Bearer ${admin}`).send({ enabled: false });
    await flush(DEALER_GROUP);
    expect((await posts()).rows).toHaveLength(1);
    await request(app).put(`/api/whatsapp-business/groups/${encodeURIComponent(DEALER_GROUP)}`)
      .set('Authorization', `Bearer ${admin}`).send({ enabled: true });
  });
});

describe('reading history', () => {
  it('fills in what came before, and pressing it twice changes nothing', async () => {
    const at = Math.floor(Date.now() / 1000) - 3600;
    fake.groupHistory.set(DEALER_GROUP, [
      { id: `true_${DEALER_GROUP}_H1${marker}`, body: dealText(10), type: 'chat', timestamp: at, author: '919822222222@c.us', contact: { pushName: 'Sita Realty' } },
      { id: `true_${DEALER_GROUP}_H2${marker}`, body: dealText(11), type: 'chat', timestamp: at + 60, author: '919822222222@c.us', contact: { pushName: 'Sita Realty' } },
      { id: `true_${DEALER_GROUP}_H3${marker}`, body: 'photo', type: 'image', timestamp: at + 90, author: '919822222222@c.us' },
    ]);
    const before = (await posts()).rows.length;

    const run = async (): Promise<void> => {
      const started = await request(app).post('/api/whatsapp-business/groups/import-history').set('Authorization', `Bearer ${admin}`).send({ groupId: DEALER_GROUP });
      expect(started.body.started).toBe(true);
      const end = Date.now() + 8000;
      while (historyJobStatus().running && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(historyJobStatus().running).toBe(false);
    };
    await run();
    expect((await posts()).rows).toHaveLength(before + 2);
    const row = await db.queryOne<{ history_state: string }>(`SELECT history_state FROM ipy_wa_group WHERE id = $1`, [DEALER_GROUP]);
    expect(row?.history_state).toBe('done');

    await run();
    expect((await posts()).rows).toHaveLength(before + 2);
  });
});
