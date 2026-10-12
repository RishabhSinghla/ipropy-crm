/**
 * An Associate's deal table: what the team types into a row, and what happens to it.
 *
 * The reason the team's rows live in a table of their own is that the parser
 * deletes and re-inserts a post's listings whenever the post is read again. So the
 * test that matters here is the one that does exactly that, through the same
 * function (`saveListings`), and then looks for what somebody typed.
 *
 * A brand-new database has no Associates module (migration 175 stops early when
 * there is no Leads module to copy yet), so the suite makes one the same way the
 * migration does, once.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { db } from '../../src/db/pool.js';
import { saveListings } from '../../src/core/market/listings.js';
import { adminContext, leadInput, signIn, SEEDED } from './fixtures.js';

let app: Express;
let adminToken = '';
let repToken = '';
let recordId = '';
let otherRecordId = '';
const marker = `itestdeal${Date.now()}`;
const phone = `98${String(Date.now()).slice(-8)}`;
const otherPhone = `97${String(Date.now()).slice(-8)}`;

async function ensureAssociates(): Promise<void> {
  if (await db.queryOne(`SELECT 1 FROM ipy_module WHERE name = 'associates'`)) return;
  await db.query('DROP TABLE IF EXISTS ipy_e_associates CASCADE');
  await db.query(readFileSync(new URL('../../src/db/migrations/175_associates_from_dealers_and_builders.sql', import.meta.url), 'utf8'));
  registry.invalidate();
}

const upload = (text: string) => request(app)
  .post('/api/market/import')
  .set('Authorization', `Bearer ${adminToken}`)
  .field('group', `Deals ${marker}`)
  .attach('file', Buffer.from(text, 'utf8'), 'chat.txt');

const dealsOf = async (id = recordId): Promise<{ forSale: Array<Record<string, any>>; forRent: Array<Record<string, any>> }> => {
  const res = await request(app).get(`/api/market/records/associates/${id}/deals`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  return res.body;
};

const patch = (ref: string, body: Record<string, unknown>, token = adminToken, id = recordId) => request(app)
  .patch(`/api/market/records/associates/${id}/deals/${encodeURIComponent(ref)}`)
  .set('Authorization', `Bearer ${token}`)
  .send(body);

beforeAll(async () => {
  await ensureAssociates();
  await registry.warmup();
  app = createApp();
  adminToken = await signIn(app, 'admin@ipropy.com');
  repToken = await signIn(app, SEEDED.executiveA);
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestdeal%'`);

  const ctx = await adminContext();
  recordId = (await recordService.createRecord(ctx, 'associates', leadInput({ full_name: `Dealer ${marker}`, mobile: phone }))).id;
  otherRecordId = (await recordService.createRecord(ctx, 'associates', leadInput({ full_name: `Other ${marker}`, mobile: otherPhone }))).id;

  const day = new Date();
  const stamp = `${day.getDate()}/${day.getMonth() + 1}/${day.getFullYear()}`;
  const res = await upload([
    `${stamp}, 10:16 am - Dealer ${marker}: 3 BHK available in ${marker} Greenfields, 1.45 Cr, call ${phone}`,
    `${stamp}, 10:17 am - Dealer ${marker}: 4 BHK available in ${marker} Greenfields, 2.10 Cr, call ${phone}`,
    `${stamp}, 10:18 am - Other ${marker}: 2 BHK available in ${marker} Greenfields, 90 lac, call ${otherPhone}`,
  ].join('\n'));
  expect(res.status).toBe(200);
});

describe("an Associate's deal rows", () => {
  it('starts with what the parser read, none of it yet the team\'s own', async () => {
    const { forSale } = await dealsOf();
    expect(forSale).toHaveLength(2);
    expect(forSale.every((deal) => deal.stored === false && deal.houseNo === null)).toBe(true);
  });

  it('keeps what is typed into a row, and the row keeps its place on the list', async () => {
    const before = (await dealsOf()).forSale.find((deal) => deal.bhk === 3)!;
    const res = await patch(before.ref, { houseNo: 'B-12', portion: 'Ground', nextFollowUpAt: '2026-11-03', extra: { owner_name: 'Mr Sharma' } });
    expect(res.status).toBe(200);

    const after = (await dealsOf()).forSale.find((deal) => deal.bhk === 3)!;
    expect(after).toMatchObject({ stored: true, houseNo: 'B-12', portion: 'Ground', nextFollowUpAt: '2026-11-03', extra: { owner_name: 'Mr Sharma' } });
    expect(after.key).toBe(before.key);
    expect((await dealsOf()).forSale).toHaveLength(2);
  });

  it('is still there after the parser re-reads the post and replaces its listings', async () => {
    const row = (await dealsOf()).forSale.find((deal) => deal.bhk === 3)!;
    const listing = await db.queryOne<{ post_id: string; kind: string; purpose: string; category: string | null; bhk: number | null; place_keys: string[]; summary: string }>(
      `SELECT post_id, kind, purpose, category, bhk, place_keys, summary FROM ipy_market_listing WHERE post_id = $1 AND ord = 0`, [row.postId]);
    const oldId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_market_listing WHERE post_id = $1 AND ord = 0`, [row.postId]))!.id;

    await saveListings(row.postId, [{
      kind: listing!.kind as 'have', purpose: listing!.purpose as 'sale', category: listing!.category, bhk: listing!.bhk, sizeSqYd: null,
      priceMinLakh: 145, priceMaxLakh: 145, placeKeys: listing!.place_keys, project: null, facing: null, floor: null, summary: listing!.summary,
    }], 'rules');
    const newId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_market_listing WHERE post_id = $1 AND ord = 0`, [row.postId]))!.id;
    expect(newId).not.toBe(oldId);

    const sale = (await dealsOf()).forSale;
    expect(sale).toHaveLength(2);
    expect(sale.find((deal) => deal.bhk === 3)).toMatchObject({ stored: true, houseNo: 'B-12', extra: { owner_name: 'Mr Sharma' } });
  });

  it('moves between For Sale and For Rent when that column is changed', async () => {
    const row = (await dealsOf()).forSale.find((deal) => deal.bhk === 4)!;
    expect((await patch(row.ref, { purpose: 'rent' })).status).toBe(200);
    const lists = await dealsOf();
    expect(lists.forSale.map((deal) => deal.bhk)).toEqual([3]);
    expect(lists.forRent.map((deal) => deal.bhk)).toEqual([4]);
    expect((await patch(lists.forRent[0].ref, { purpose: 'sale' })).status).toBe(200);
  });

  it('empties a box when it is sent as null and removes an extra field when it is emptied', async () => {
    const row = (await dealsOf()).forSale.find((deal) => deal.bhk === 3)!;
    expect((await patch(row.ref, { houseNo: null, extra: { owner_name: null } })).status).toBe(200);
    expect((await dealsOf()).forSale.find((deal) => deal.bhk === 3)).toMatchObject({ houseNo: null, extra: {} });
  });

  it('duplicates a row beside its original, and removing the copy leaves the original', async () => {
    const row = (await dealsOf()).forSale.find((deal) => deal.bhk === 3)!;
    const copy = await request(app).post(`/api/market/records/associates/${recordId}/deals/${encodeURIComponent(row.ref)}/duplicate`).set('Authorization', `Bearer ${adminToken}`);
    expect(copy.status).toBe(200);
    expect((await dealsOf()).forSale).toHaveLength(3);

    const gone = await request(app).delete(`/api/market/records/associates/${recordId}/deals/${copy.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(gone.status).toBe(200);
    expect((await dealsOf()).forSale).toHaveLength(2);
  });

  it('keeps a removed listing off the list even after its post is re-read', async () => {
    const row = (await dealsOf()).forSale.find((deal) => deal.bhk === 4)!;
    const gone = await request(app).delete(`/api/market/records/associates/${recordId}/deals/${encodeURIComponent(row.ref)}`).set('Authorization', `Bearer ${adminToken}`);
    expect(gone.status).toBe(200);
    expect((await dealsOf()).forSale.map((deal) => deal.bhk)).toEqual([3]);

    await saveListings(row.postId, [{
      kind: 'have', purpose: 'sale', category: null, bhk: 4, sizeSqYd: null, priceMinLakh: 210, priceMaxLakh: 210,
      placeKeys: [], project: null, facing: null, floor: null, summary: '4 BHK again',
    }], 'rules');
    expect((await dealsOf()).forSale.map((deal) => deal.bhk)).toEqual([3]);
  });
});

describe('who may change a row, and which rows', () => {
  it('refuses a listing that belongs to another dealer', async () => {
    const theirs = (await dealsOf(otherRecordId)).forSale[0];
    expect(theirs).toBeTruthy();
    const res = await patch(theirs.ref, { houseNo: 'X-1' });
    expect(res.status).toBe(404);
  });

  it('refuses someone who may not edit this Associate', async () => {
    const mine = (await dealsOf()).forSale[0];
    const res = await patch(mine.ref, { houseNo: 'X-2' }, repToken);
    expect([403, 404]).toContain(res.status);
    expect((await dealsOf()).forSale.find((deal) => deal.houseNo === 'X-2')).toBeUndefined();
  });

  it('refuses a key it does not know, a bad date and a bad reference, changing nothing', async () => {
    const mine = (await dealsOf()).forSale[0];
    // This app answers input it will not accept with 422; a reference that is not one is a plain 400.
    expect((await patch(mine.ref, { owner_id: 'x' })).status).toBe(422);
    expect((await patch(mine.ref, { nextFollowUpAt: '3/11/2026' })).status).toBe(422);
    expect((await patch('x; drop table ipy_record', { houseNo: 'Y' })).status).toBe(400);
  });

  it('answers how many of our own records each post fits, and refuses a made-up id', async () => {
    const post = (await dealsOf()).forSale[0].postId as string;
    const res = await request(app).get(`/api/market/deal-match-counts?posts=${post}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body[post]).toBe('number');
    const bad = await request(app).get('/api/market/deal-match-counts?posts=nope').set('Authorization', `Bearer ${adminToken}`);
    expect(bad.status).toBe(422);
  });
});
