/**
 * The feed shows 15 days and no more (rows are deleted only after 45), and a group is read quickly: stale messages never get in, repeats are filed in bulk,
 * and a daily clear removes whatever has aged out together with everything derived from it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { adminToken } from './fixtures.js';
import { purgeStaleMarketData } from '../../src/core/market/retention.js';
import { importGroupExport } from '../../src/core/market/feed.js';

let app: ReturnType<typeof createApp>;
let token = '';
const marker = `itestfresh${Date.now()}`;
const day = (ago: number) => {
  const d = new Date(Date.now() - ago * 86_400_000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
const line = (ago: number, who: string, text: string) => `${day(ago)}, 10:15 am - ${who}: ${text}`;
const chat = [
  line(2, 'Fresh Dealer', `Plot for sale sector 91 ${marker} 250 sq yd demand 3 cr call 9811100001`),
  line(1, 'Fresh Dealer', `Plot for sale sector 92 ${marker} 300 sq yd demand 4 cr call 9811100001`),
  line(60, 'Old Dealer', `Plot for sale sector 93 ${marker} 200 sq yd demand 2 cr call 9811100002`),
  line(200, 'Ancient Dealer', `Plot for sale sector 94 ${marker} 150 sq yd demand 1 cr call 9811100003`),
].join('\n');

beforeAll(async () => {
  app = createApp(); token = await adminToken(app);
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestfresh%'`);
});
afterAll(async () => {
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestfresh%'`);
  await db.query(`DELETE FROM ipy_market_group WHERE name = $1`, [`Fresh ${marker}`]);
});

describe('the feed keeps 15 days and no more', () => {
  it('never stores a message older than that, and says how many it left out', async () => {
    const outcome = await importGroupExport(`Fresh ${marker}`, chat, '00000000-0000-0000-0000-000000000000');
    expect(outcome.newDeals).toBe(2);
    expect(outcome.skippedOld).toBe(2);
    const stored = await db.query(`SELECT body FROM ipy_market_post WHERE body ILIKE $1`, [`%${marker}%`]);
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.some((row) => /sector 93|sector 94/.test(String(row.body)))).toBe(false);
  });

  it('files a re-dropped group in bulk and counts each repeat once', async () => {
    const again = await importGroupExport(`Fresh ${marker}`, chat, '00000000-0000-0000-0000-000000000000');
    expect(again.newDeals).toBe(0);
    const third = await importGroupExport(`Fresh ${marker}-second`, chat, '00000000-0000-0000-0000-000000000000');
    // Same two deals seen in another group: a repeat each, and now posted in two groups.
    expect(third.repeats).toBe(2);
    const row = await db.queryOne<{ groups: string[]; seen_count: number }>(`SELECT groups, seen_count FROM ipy_market_post WHERE body ILIKE $1 AND body ILIKE '%sector 91%'`, [`%${marker}%`]);
    expect(row?.groups).toHaveLength(2);
    expect(row?.seen_count).toBeGreaterThanOrEqual(2);
    await db.query(`DELETE FROM ipy_market_group WHERE name = $1`, [`Fresh ${marker}-second`]);
  });

  it('clears what has aged out, with everything derived from it, and leaves the rest', async () => {
    // A deal that was fresh when stored and has since aged past the window, with a property row and a sighting.
    const old = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_market_post (fingerprint, body, groups, first_posted_at, last_posted_at, created_at)
       VALUES ($1, $2, ARRAY['G'], now() - interval '50 days', now() - interval '50 days', now() - interval '50 days') RETURNING id`, [`${marker}-old`, `${marker} aged out`]);
    await db.query(`INSERT INTO ipy_market_listing (post_id, ord, kind, summary) VALUES ($1, 0, 'have', 'aged')`, [old!.id]);
    await db.query(`INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender) VALUES ($1, 'G', now() - interval '50 days', 'x')`, [old!.id]);

    const report = await purgeStaleMarketData();
    expect(report.posts).toBeGreaterThanOrEqual(1);
    expect((await db.query(`SELECT 1 FROM ipy_market_post WHERE id = $1`, [old!.id])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM ipy_market_listing WHERE post_id = $1`, [old!.id])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM ipy_market_post_seen WHERE post_id = $1`, [old!.id])).rowCount).toBe(0);
    // What is inside the window is untouched.
    expect((await db.query(`SELECT 1 FROM ipy_market_post WHERE body ILIKE $1`, [`%sector 91%${marker}%`])).rowCount).toBe(1);
  });

  it('lists every group once, and the route answers', async () => {
    const res = await request(app).get('/api/market/groups').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const names = (res.body.groups as Array<{ name: string }>).map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(`Fresh ${marker}`);
  });
});
