/**
 * One WhatsApp number per agent: who may send from which number, what an admin can do,
 * and that history is never re-attributed.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { assertNotPaused, assignNumber, chooseNumber, listNumbers, setDefaultNumber, setPaused } from '../../src/integrations/whatsapp/business/waNumbers.js';
import { SEEDED, adminToken, authUser, signIn } from './fixtures.js';

const stamp = Date.now();
const NAMES = [`t-company-${stamp}`, `t-aisha-${stamp}`, `t-vikram-${stamp}`];
let app: ReturnType<typeof createApp>;
let admin = '';
let agent = '';
let aisha = '';
let vikram = '';
let adminId = '';
let ids: string[] = [];
let previousDefault: string | null = null;
let previousAssignments: { id: string; user_id: string }[] = [];

beforeAll(async () => {
  app = createApp();
  admin = await adminToken(app);
  agent = await signIn(app, SEEDED.executiveA);
  aisha = (await authUser(SEEDED.executiveA)).id;
  vikram = (await authUser(SEEDED.executiveB)).id;
  adminId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE is_admin ORDER BY created_at, id LIMIT 1`))!.id;
  previousDefault = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_wa_number WHERE is_default`))?.id ?? null;
  previousAssignments = (await db.query<{ id: string; user_id: string }>(`SELECT id, user_id FROM ipy_wa_number WHERE user_id IS NOT NULL`)).rows;
  await db.query(`UPDATE ipy_wa_number SET user_id = NULL, is_default = false`);
  for (const name of NAMES) {
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_wa_number (session_name, session_id, status) VALUES ($1, $1, 'ready') RETURNING id`, [name],
    );
    ids.push(row!.id);
  }
  await setDefaultNumber(ids[0]);
  await assignNumber(ids[1], aisha);
  await assignNumber(ids[2], vikram);
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_wa_number WHERE id = ANY($1::uuid[])`, [ids]);
  if (previousDefault) await db.query(`UPDATE ipy_wa_number SET is_default = true WHERE id = $1`, [previousDefault]);
  for (const a of previousAssignments) await db.query(`UPDATE ipy_wa_number SET user_id = $2 WHERE id = $1`, [a.id, a.user_id]);
});

describe('who sends from which number', () => {
  it('an agent always sends from their own number', async () => {
    const pick = await chooseNumber({ userId: aisha, isAdmin: false, recordOwnerId: vikram });
    expect(pick.number.sessionName).toBe(NAMES[1]);
  });

  it('an agent cannot ask for somebody else\'s number', async () => {
    await expect(chooseNumber({ userId: aisha, isAdmin: false, requestedId: ids[2] })).rejects.toThrow(/your own/i);
  });

  it('an agent with no number is told so, and nothing falls back to the company number', async () => {
    await assignNumber(ids[1], null);
    await expect(chooseNumber({ userId: aisha, isAdmin: false })).rejects.toThrow(/No WhatsApp number is assigned/);
    await assignNumber(ids[1], aisha);
  });

  it('an admin defaults to the lead owner\'s number, may pick another, and falls back to the company number', async () => {
    expect((await chooseNumber({ userId: adminId, isAdmin: true, recordOwnerId: vikram })).number.sessionName).toBe(NAMES[2]);
    expect((await chooseNumber({ userId: adminId, isAdmin: true, recordOwnerId: vikram, requestedId: ids[1] })).number.sessionName).toBe(NAMES[1]);
    const noNumberOwner = await chooseNumber({ userId: adminId, isAdmin: true, recordOwnerId: adminId });
    expect(noNumberOwner.number.sessionName).toBe(NAMES[0]);
    expect(noNumberOwner.fallbackNote).toMatch(/company number/);
  });

  it('a paused number refuses to send', async () => {
    const paused = await setPaused(ids[1], true, adminId);
    expect(() => assertNotPaused(paused)).toThrow(/paused/);
    await setPaused(ids[1], false, adminId);
  });

  it('one agent holds one number: giving a second releases the first', async () => {
    await assignNumber(ids[2], aisha);
    const list = await listNumbers();
    expect(list.find((n) => n.id === ids[1])?.userId).toBeNull();
    expect(list.find((n) => n.id === ids[2])?.userId).toBe(aisha);
    await assignNumber(ids[2], vikram);
    await assignNumber(ids[1], aisha);
  });
});

describe('the master screen\'s API', () => {
  it('is admin-only for everything but "mine"', async () => {
    expect((await request(app).get('/api/whatsapp-numbers').set('Authorization', `Bearer ${agent}`)).status).toBe(401);
    expect((await request(app).put(`/api/whatsapp-numbers/${ids[1]}/pause`).set('Authorization', `Bearer ${agent}`).send({ paused: true })).status).toBe(401);
    expect((await request(app).get('/api/whatsapp-numbers').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
  });

  it('an agent sees only their own number, an admin sees all', async () => {
    const mine = await request(app).get('/api/whatsapp-numbers/mine').set('Authorization', `Bearer ${agent}`);
    expect(mine.body.mine.sessionName).toBe(NAMES[1]);
    expect(mine.body.numbers).toEqual([]);
    const all = await request(app).get('/api/whatsapp-numbers/mine').set('Authorization', `Bearer ${admin}`);
    expect(all.body.numbers.length).toBeGreaterThanOrEqual(3);
  });

  it('pausing and resuming through the API is remembered', async () => {
    const r = await request(app).put(`/api/whatsapp-numbers/${ids[2]}/pause`).set('Authorization', `Bearer ${admin}`).send({ paused: true });
    expect(r.body.paused).toBe(true);
    const back = await request(app).put(`/api/whatsapp-numbers/${ids[2]}/pause`).set('Authorization', `Bearer ${admin}`).send({ paused: false });
    expect(back.body.paused).toBe(false);
  });
});

describe('history is never re-attributed', () => {
  it('re-assigning a number keeps the number each message went through', async () => {
    const conv = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_conversation (channel, handle, lane) VALUES ('whatsapp', $1, 'chat') RETURNING id`, [`9${String(stamp).slice(-9)}`],
    );
    await db.query(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status, provider, route, number_id)
       VALUES ($1, 'outbound', 'whatsapp', 'text', 'old', 'sent', 'whatsapp_openwa', 'business', $2)`,
      [conv!.id, ids[1]],
    );
    await assignNumber(ids[1], vikram);
    const msg = await db.queryOne<{ number_id: string }>(`SELECT number_id FROM ipy_message WHERE conversation_id = $1`, [conv!.id]);
    expect(msg!.number_id).toBe(ids[1]);
    await db.query(`DELETE FROM ipy_message WHERE conversation_id = $1`, [conv!.id]);
    await db.query(`DELETE FROM ipy_conversation WHERE id = $1`, [conv!.id]);
  });
});

describe('the admin inbox number filter', () => {
  it('lists only chats that went through the chosen number', async () => {
    const { listConversations } = await import('../../src/integrations/whatsapp/business/inbox.js');
    const handle = `8${String(stamp).slice(-9)}`;
    const conv = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_conversation (channel, handle, lane) VALUES ('whatsapp', $1, 'chat') RETURNING id`, [handle],
    );
    await db.query(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status, provider, route, number_id)
       VALUES ($1, 'inbound', 'whatsapp', 'text', 'hi', 'delivered', 'whatsapp_openwa', 'business', $2)`, [conv!.id, ids[2]],
    );
    const mine = await listConversations({ userId: adminId, isAdmin: true, filter: 'all', route: 'chat', numberId: ids[2] });
    const other = await listConversations({ userId: adminId, isAdmin: true, filter: 'all', route: 'chat', numberId: ids[1] });
    expect(mine.some((c) => c.id === conv!.id)).toBe(true);
    expect(other.some((c) => c.id === conv!.id)).toBe(false);
    await db.query(`DELETE FROM ipy_message WHERE conversation_id = $1`, [conv!.id]);
    await db.query(`DELETE FROM ipy_conversation WHERE id = $1`, [conv!.id]);
  });
});

describe('an agent linking their own number', () => {
  it('can only ever reach their own number, and an agent with none is told so', async () => {
    await assignNumber(ids[1], aisha);
    const own = await request(app).get('/api/whatsapp-numbers/mine').set('Authorization', `Bearer ${agent}`);
    expect(own.status).toBe(200);
    expect(own.body.mine?.sessionName).toBe(NAMES[1]);
    // an agent cannot pass somebody else's number: the route takes no id at all
    const start = await request(app).post('/api/whatsapp-numbers/mine/start').set('Authorization', `Bearer ${agent}`).send({ action: 'stop' });
    expect([400, 422]).toContain(start.status); // only start / restart are allowed
    await assignNumber(ids[1], null);
    const none = await request(app).get('/api/whatsapp-numbers/mine/qr').set('Authorization', `Bearer ${agent}`);
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body)).toMatch(/No WhatsApp number is assigned/);
    await assignNumber(ids[1], aisha);
  });
});
