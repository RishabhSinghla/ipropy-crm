/**
 * Dealer-group deals: in once, searched by what a rep would type.
 *
 * The reading rules are unit-tested in marketReadPost.test.ts. What needs a
 * real database is the storing: a deal forwarded into a second group is the
 * same deal, uploading an export twice adds nothing, and a search by BHK,
 * budget and locality finds it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { authUser, signIn, SEEDED } from './fixtures.js';
import { hasCapability } from '../../src/core/permissions/index.js';

let app: Express;
let adminToken = '';
let repToken = '';
const marker = `itestmkt${Date.now()}`;

const groupA = [
  `12/10/2025, 10:16 am - Ramesh Dealer: 3 BHK available in ${marker} Greenfields, 1.45 Cr, call 9811012345`,
  '12/10/2025, 10:17 am - Sita Realty: ok',
  `12/10/2025, 11:02 am - Sita Realty: Required 2 bhk ${marker} budget 70-80 lac`,
].join('\n');
const groupB = `[13/10/25, 9:00:00 AM] Mohan Associates: 3 bhk available in ${marker} greenfields,  1.45 cr, call 9811012345`;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  adminToken = await signIn(app, 'admin@ipropy.com');
  repToken = await signIn(app, SEEDED.executiveA);
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestmkt%'`);
});

const upload = (token: string, group: string, text: string) => request(app)
  .post('/api/market/import')
  .set('Authorization', `Bearer ${token}`)
  .field('group', group)
  .attach('file', Buffer.from(text, 'utf8'), 'chat.txt');

describe('the market feed', () => {
  it('stores each deal once, skips chatter, and merges a forward from another group', async () => {
    const first = await upload(adminToken, 'Dealers A', groupA);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ messages: 3, deals: 2, newDeals: 2, repeats: 0 });

    const forward = await upload(adminToken, 'Dealers B', groupB);
    expect(forward.body).toMatchObject({ deals: 1, newDeals: 0, repeats: 1 });

    // The same export again is read from where the last one ended: the two older messages (a deal and a line of chatter) are skipped,
    // and the one at the mark is read but is not counted twice.
    const again = await upload(adminToken, 'Dealers A', groupA);
    expect(again.body).toMatchObject({ newDeals: 0, repeats: 0, skippedOld: 2 });

    const held = await db.query(`SELECT groups FROM ipy_market_post WHERE body ILIKE $1 AND kind = 'have'`, [`%${marker}%`]);
    expect(held.rows).toHaveLength(1);
    expect(held.rows[0].groups.sort()).toEqual(['Dealers A', 'Dealers B']);
    // Posted in two groups, so seen twice — however often either export is dropped again.
    const seen = await db.queryOne<{ seen_count: number }>(`SELECT seen_count FROM ipy_market_post WHERE body ILIKE $1 AND kind = 'have'`, [`%${marker}%`]);
    expect(seen?.seen_count).toBe(2);
  });

  it('finds a seller by BHK, budget and words, for anybody signed in', async () => {
    const res = await request(app)
      .get('/api/market/posts')
      .query({ kind: 'have', bhk: 3, maxLakh: 150, text: marker, days: 365 })
      .set('Authorization', `Bearer ${repToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.posts[0]).toMatchObject({ posterPhone: '9811012345', priceMinLakh: 145 });

    const tooCheap = await request(app)
      .get('/api/market/posts')
      .query({ kind: 'have', maxLakh: 100, text: marker, days: 365 })
      .set('Authorization', `Bearer ${repToken}`);
    expect(tooCheap.body.total).toBe(0);
  });

  it('putting a group in needs the import permission', async () => {
    const rep = await authUser(SEEDED.executiveA);
    const res = await upload(repToken, 'Dealers A', groupA);
    expect(res.status).toBe(await hasCapability(rep, 'records.import') ? 200 : 403);
  });
});
