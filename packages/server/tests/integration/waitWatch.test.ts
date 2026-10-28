/**
 * Waiting-for-reply alerts, against a real database. Nothing here sends a message to anybody: the feature has no
 * send path, and every assertion is about rows in `ipy_notification`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { runWaitWatchOnce } from '../../src/integrations/whatsapp/business/waitWatch.js';
import { SEEDED, authUser } from './fixtures.js';

const stamp = String(Date.now()).slice(-7);
let repId = '';
const created: string[] = [];
let savedHours: unknown = null;
let savedSettings: Record<string, unknown> = {};

async function chat(label: string, opts: { minutesAgo: number; assignedTo?: string | null; status?: string }): Promise<{ id: string; name: string }> {
  const name = `WW ${label} ${stamp}`;
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, contact_name, assigned_to, status, last_inbound_at, last_inbound_seen_at)
     VALUES ('whatsapp', $1, $2, $3, $4, now() - ($5 || ' minutes')::interval, now() - ($5 || ' minutes')::interval) RETURNING id`,
    [`+91${stamp}${created.length}`.slice(0, 15), name, opts.assignedTo ?? null, opts.status ?? 'open', String(opts.minutesAgo)],
  );
  created.push(row!.id);
  return { id: row!.id, name };
}

const alertsFor = async (name: string): Promise<{ user_id: string }[]> =>
  (await db.query(`SELECT user_id FROM ipy_notification WHERE kind = 'whatsapp_wait' AND title = $1`, [`${name} is waiting for a reply`])).rows as { user_id: string }[];

beforeAll(async () => {
  repId = (await authUser(SEEDED.executiveA)).id;
  savedHours = (await db.queryOne<{ value: unknown }>(`SELECT value FROM ipy_setting WHERE key = 'business_hours'`))?.value ?? null;
  const rows = await db.query<{ key: string; value: unknown }>(`SELECT key, value FROM ipy_setting WHERE key LIKE 'whatsapp.wait_watch.%'`);
  savedSettings = Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
  // Always open, so the tests do not depend on the hour they run at.
  await db.query(
    `INSERT INTO ipy_setting (key, value, category, label) VALUES ('business_hours', $1::jsonb, 'general', 'Business Hours')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6], timezone: 'Asia/Kolkata' })],
  );
  for (const [key, value] of [['enabled', true], ['first_minutes', 15], ['second_minutes', 60]] as const) {
    await db.query(`UPDATE ipy_setting SET value = $2::jsonb WHERE key = $1`, [`whatsapp.wait_watch.${key}`, JSON.stringify(value)]);
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_notification WHERE kind = 'whatsapp_wait' AND title LIKE $1`, [`WW % ${stamp} is waiting%`]);
  await db.query(`DELETE FROM ipy_conversation WHERE id = ANY($1)`, [created]);
  if (savedHours !== null) await db.query(`UPDATE ipy_setting SET value = $1::jsonb WHERE key = 'business_hours'`, [JSON.stringify(savedHours)]);
  for (const [key, value] of Object.entries(savedSettings)) await db.query(`UPDATE ipy_setting SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);
});

describe('the first alert goes to the person who holds the chat, once', () => {
  it('tells the holder only, and not again however many passes run', async () => {
    const c = await chat('held', { minutesAgo: 20, assignedTo: repId });
    await runWaitWatchOnce();
    const first = await alertsFor(c.name);
    expect(first.map((a) => a.user_id)).toEqual([repId]);
    await runWaitWatchOnce();
    await runWaitWatchOnce();
    expect(await alertsFor(c.name)).toHaveLength(1);
  });

  it('two passes at the same moment still alert once', async () => {
    const c = await chat('race', { minutesAgo: 25, assignedTo: repId });
    await Promise.all([runWaitWatchOnce(), runWaitWatchOnce(), runWaitWatchOnce()]);
    expect(await alertsFor(c.name)).toHaveLength(1);
  });

  it('a new customer message re-arms it', async () => {
    const c = await chat('rearm', { minutesAgo: 20, assignedTo: repId });
    await runWaitWatchOnce();
    expect(await alertsFor(c.name)).toHaveLength(1);
    // In real life the second message arrives after the first alert; the clock here is compressed, so move the alert back.
    await db.query(`UPDATE ipy_conversation SET wait_nudge_1_at = now() - interval '40 minutes', last_inbound_at = now() - interval '20 minutes', last_inbound_seen_at = now() - interval '19 minutes' WHERE id = $1`, [c.id]);
    await runWaitWatchOnce();
    expect(await alertsFor(c.name)).toHaveLength(2);
  });
});

describe('who is not alerted about', () => {
  it('a chat that was answered, but not one whose only reply failed', async () => {
    const answered = await chat('answered', { minutesAgo: 30, assignedTo: repId });
    await db.query(`INSERT INTO ipy_message (conversation_id, direction, channel, status) VALUES ($1, 'outbound', 'whatsapp', 'sent')`, [answered.id]);
    const failed = await chat('failedreply', { minutesAgo: 30, assignedTo: repId });
    await db.query(`INSERT INTO ipy_message (conversation_id, direction, channel, status) VALUES ($1, 'outbound', 'whatsapp', 'failed')`, [failed.id]);
    await runWaitWatchOnce();
    expect(await alertsFor(answered.name)).toHaveLength(0);
    expect(await alertsFor(failed.name)).toHaveLength(1);
  });

  it('a resolved chat, a chat waiting under the limit, and one older than the floor', async () => {
    const resolved = await chat('resolved', { minutesAgo: 30, assignedTo: repId, status: 'resolved' });
    const fresh = await chat('fresh', { minutesAgo: 5, assignedTo: repId });
    const stale = await chat('stale', { minutesAgo: 450, assignedTo: repId });
    await runWaitWatchOnce();
    for (const c of [resolved, fresh, stale]) expect(await alertsFor(c.name), c.name).toHaveLength(0);
  });
});

describe('a chat nobody holds, and the second limit', () => {
  it('goes to the admins, and a chat already past the second limit gets that alert only', async () => {
    const unheld = await chat('unheld', { minutesAgo: 20 });
    const late = await chat('late', { minutesAgo: 90, assignedTo: repId });
    await runWaitWatchOnce();
    const admins = new Set((await db.query<{ id: string }>(`SELECT id FROM ipy_user WHERE is_admin AND is_active`)).rows.map((r) => r.id));
    const toUnheld = (await alertsFor(unheld.name)).map((a) => a.user_id);
    expect(toUnheld.length).toBeGreaterThan(0);
    expect(toUnheld.every((id) => admins.has(id))).toBe(true);
    const toLate = (await alertsFor(late.name)).map((a) => a.user_id);
    expect(toLate.every((id) => admins.has(id)) && !toLate.includes(repId)).toBe(true);
  });
});

describe('it can be switched off', () => {
  it('does nothing while disabled', async () => {
    await db.query(`UPDATE ipy_setting SET value = 'false'::jsonb WHERE key = 'whatsapp.wait_watch.enabled'`);
    const c = await chat('off', { minutesAgo: 20, assignedTo: repId });
    expect(await runWaitWatchOnce()).toBe(0);
    expect(await alertsFor(c.name)).toHaveLength(0);
    await db.query(`UPDATE ipy_setting SET value = 'true'::jsonb WHERE key = 'whatsapp.wait_watch.enabled'`);
  });
});
