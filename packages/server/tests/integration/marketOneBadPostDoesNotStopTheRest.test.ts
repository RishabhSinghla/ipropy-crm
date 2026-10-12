/**
 * 13 October 2026, the owner: the live Dealer groups page and every Associate's four tabs were
 * empty after the listings release.
 *
 * Everything already in the feed becomes listings in a background pass. One message in it —
 * a broker's list with "132.45 Sq. Yds." — carried a size with a decimal point, and size is a
 * whole-number column: the insert was refused, the pass threw, and because it takes the newest
 * posts first and had not moved past the bad one, it threw again at every visit and nothing was
 * ever read. Unit tests passed because none of them ever put that size into a database.
 *
 * Two promises, both pinned here: a size with a decimal is a size, and one post the database
 * refuses can never stop the others.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { reReadOldPosts } from '../../src/core/market/enrich.js';
import { importGroupExport } from '../../src/core/market/feed.js';

const marker = `itestbad${Date.now()}`;
const day = (() => {
  const now = new Date();
  return `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
})();
let adminId = '';

beforeAll(async () => {
  await registry.warmup();
  adminId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com'`))!.id;
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestbad%'`);
  await db.query(`DELETE FROM ipy_market_group WHERE name = 'ITESTBAD Group'`);
});
afterAll(async () => { await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestbad%'`); });

describe('a size with a decimal point', () => {
  const list = [
    'AVAILABLE FOR SALE – PREMIUM BUILDER PROJECTS',
    '📍 Honour Homes – Sector 89', '• Sizes: 132.45 & 137 Sq. Yds.',
    '📍 BPTP Parkland – Sector 85', '• Size: 250.5 Sq. Yds.', '💰 ₹4.5 Cr',
    `📞 9811100099 ${marker}`,
  ].join('\n');

  it('is read, stored and listed, instead of failing the insert', async () => {
    const outcome = await importGroupExport('ITESTBAD Group', `${day}, 9:00 am - Broker: ${list}`, adminId);
    expect(outcome.newDeals).toBe(1);
    expect(outcome.listings).toBeGreaterThanOrEqual(1);
    const sizes = await db.query<{ size_sqyd: number }>(`SELECT l.size_sqyd FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id WHERE p.body ILIKE '%${marker}%'`);
    expect(sizes.rows.length).toBeGreaterThanOrEqual(1);
    expect(sizes.rows.every((row) => Number.isInteger(row.size_sqyd) || row.size_sqyd === null)).toBe(true);
  });
});

describe('one post the database refuses', () => {
  beforeAll(async () => {
    // A rule only this test's poison word breaks, so nothing else sharing the database can be touched.
    await db.query(`ALTER TABLE ipy_market_listing DROP CONSTRAINT IF EXISTS itest_poison`);
    await db.query(`ALTER TABLE ipy_market_listing ADD CONSTRAINT itest_poison CHECK (summary NOT LIKE '%ITESTPOISON%') NOT VALID`);
  });
  afterAll(async () => { await db.query(`ALTER TABLE ipy_market_listing DROP CONSTRAINT IF EXISTS itest_poison`); });

  it('does not stop an upload: the others are stored and the refused one is counted', async () => {
    const outcome = await importGroupExport('ITESTBAD Group', [
      `${day}, 10:00 am - Good One: 250 gaj plot for sale Sector 81 ${marker} 3 cr call 9811100001`,
      `${day}, 10:02 am - Bad One: 250 gaj plot for sale Sector 83 ITESTPOISON ${marker} 3 cr call 9811100003`,
      `${day}, 10:05 am - Good Two: 3 BHK for sale Sector 82 ${marker} 1.2 cr call 9811100002`,
    ].join('\n'), adminId);
    expect(outcome.newDeals).toBe(3);
    const goods = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id WHERE p.body ILIKE '%${marker}%' AND p.body NOT ILIKE '%ITESTPOISON%'`);
    expect(goods?.n).toBeGreaterThanOrEqual(2);
  });

  it('does not stop the background re-read: every message is moved past, the bad one included', async () => {
    await db.query(`UPDATE ipy_market_post SET read_version = 0 WHERE body ILIKE '%${marker}%'`);
    await db.query(`DELETE FROM ipy_market_listing WHERE post_id IN (SELECT id FROM ipy_market_post WHERE body ILIKE '%${marker}%' AND body NOT ILIKE '%ITESTPOISON%')`);
    const read = await reReadOldPosts(100);
    expect(read).toBeGreaterThanOrEqual(3);
    const left = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_market_post WHERE body ILIKE '%${marker}%' AND read_version < 3`);
    // A second visit has nothing stuck to trip over.
    expect(left?.n).toBe(0);
    const goodTwo = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id WHERE p.body ILIKE '%Sector 82%' AND p.body ILIKE '%${marker}%'`);
    expect(goodTwo?.n).toBe(1);
  });
});
