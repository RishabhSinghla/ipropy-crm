/**
 * The dealer-group feed, end to end inside the CRM: two groups go in, Jev
 * (stubbed — only its network edge) reads the posts, a buyer in one group is
 * matched to a seller in the other, and what a person did about it is kept.
 *
 * Everything past the word lists is SQL in a string, so a wrong column name is
 * invisible to typecheck and to a mocked query. This runs it for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// Only the key lookup is faked, so the reader behaves as if OpenRouter were connected.
vi.mock('../../src/core/settings/integrations.js', async (original) => ({
  ...(await original<typeof import('../../src/core/settings/integrations.js')>()),
  getAiProviderSettings: () => ({ apiKey: 'test-key' }),
}));

import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';
import { readWaitingPosts, reReadOldPosts } from '../../src/core/market/enrich.js';
import { findCrossMatches, recordOutcome } from '../../src/core/market/crossMatch.js';
import { dealerDirectory, saveDealersAsAssociates } from '../../src/core/market/dealers.js';
import { dealsOfRecord } from '../../src/core/market/dealerDeals.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, leadInput } from './fixtures.js';

let app: Express;
let adminToken = '';
let adminId = '';
const marker = `itestjev${Date.now()}`;
const buyerPhone = `98${String(Date.now()).slice(-8)}`;
const sellerPhone = `97${String(Date.now()).slice(-8)}`;
const today = new Date();
const stamp = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

// Same sector, same size, different groups, nobody in common.
const groupBuyers = `${stamp}, 10:15 am - Anil Buyer: Required 250 gaj plot sector 85 ${marker} budget 4 cr call ${buyerPhone}`;
const groupSellers = `${stamp}, 10:20 am - Bhoomi Associates: 260 sq yd residential plot for sale sector 85 ${marker} demand 3.5 cr call ${sellerPhone}`;

const jevCalls: string[] = [];
const pairChecks: string[] = [];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  adminToken = await signIn(app, 'admin@ipropy.com');
  adminId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com'`))!.id;
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestjev%'`);

  // Jev, as the network sees it: a requirement is a lead, anything else is inventory.
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { state: string };
    // A pairing question asks only "fit"; the answer is yes when both name the same sector.
    if (sent.state.startsWith('REQUIREMENT:')) {
      pairChecks.push(sent.state);
      return new Response(JSON.stringify({ answers: { fit: { noul: /sector 85/i.test(sent.state) ? 0.93 : 0.1 } } }), { status: 200 });
    }
    jevCalls.push(sent.state);
    const isLead = /required/i.test(sent.state);
    return new Response(JSON.stringify({
      answers: {
        kind: { choice: isLead ? 'lead' : 'inventory', confidence: 0.99 },
        is_property_post: { noul: 0.97 },
        urgency: { score: 2 },
        category: { choice: 'Residential Plot' },
        author_role: { choice: isLead ? 'Buyer' : 'Dealer' },
      },
    }), { status: 200 });
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestjev%'`);
});

const upload = (group: string, text: string) => request(app)
  .post('/api/market/import')
  .set('Authorization', `Bearer ${adminToken}`)
  .field('group', group)
  .attach('file', Buffer.from(text), 'chat.txt');

describe('a dealer group read by Jev and matched across groups', () => {
  it('stores sector, size and category from the words, before Jev has looked', async () => {
    expect((await upload(`Buyers ${marker}`, groupBuyers)).status).toBe(200);
    expect((await upload(`Sellers ${marker}`, groupSellers)).status).toBe(200);
    const row = await db.queryOne<{ places: string[]; size_sqyd: number; category: string; place_keys: string[]; jev_checked_at: Date | null }>(
      `SELECT places, size_sqyd, category, place_keys, jev_checked_at FROM ipy_market_post WHERE poster_phone = $1`, [sellerPhone],
    );
    expect(row?.places).toEqual(['sector 85']);
    expect(row?.size_sqyd).toBe(260);
    expect(row?.category).toBe('Residential Plot');
    expect(row?.place_keys).toContain('sector 85');
  });

  it('Jev reads each waiting post once, hides nothing it should not, and never sees a phone number', async () => {
    // An upload already nudges the background reader, so some or all may be read by now.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await readWaitingPosts(50);
    expect(jevCalls.filter((text) => text.includes(marker))).toHaveLength(2);
    expect(jevCalls.some((text) => text.includes(buyerPhone) || text.includes(sellerPhone))).toBe(false);
    const rows = await db.query<{ kind: string; poster_role: string; is_noise: boolean; jev_checked_at: Date | null }>(
      `SELECT kind, poster_role, is_noise, jev_checked_at FROM ipy_market_post WHERE body ILIKE '%${marker}%' ORDER BY kind`,
    );
    expect(rows.rows.map((r) => [r.kind, r.poster_role, r.is_noise, r.jev_checked_at !== null])).toEqual([
      ['have', 'Dealer', false, true],
      ['want', 'Buyer', false, true],
    ]);
    // Asking again costs nothing: they are read.
    const before = jevCalls.length;
    await readWaitingPosts(50);
    expect(jevCalls.slice(before).some((text) => text.includes(marker))).toBe(false);
  });

  it('the buyer is matched to the seller in the other group, and an outcome takes the pair off the list', async () => {
    const find = async () => (await findCrossMatches({ limit: 500 })).find((m) => m.have.posterPhone === sellerPhone);
    const match = await find();
    expect(match?.want.posterPhone).toBe(buyerPhone);
    expect(match?.crossGroup).toBe(true);
    expect(match?.score).toBeGreaterThanOrEqual(0.9);

    await recordOutcome(match!.want.id, match!.have.id, 'called', 'rang both', adminId);
    expect((await find())?.status).toBe('called');
    await recordOutcome(match!.want.id, match!.have.id, 'dismissed', null, adminId);
    expect(await find()).toBeUndefined();
  });

  it('sure-shot shows only pairs Jev has checked and rates high, and Refresh answers at once', async () => {
    const find = async (minJevFit?: number) => (await findCrossMatches({ limit: 500, includeWorked: true, minJevFit })).find((m) => m.have.posterPhone === sellerPhone);
    const match = (await find())!;
    await db.query(`DELETE FROM ipy_market_pair_check WHERE want_listing_id = $1 AND have_listing_id = $2`, [match.want.id, match.have.id]);
    expect(await find(0.7)).toBeUndefined();
    await db.query(`INSERT INTO ipy_market_pair_check (want_listing_id, have_listing_id, fit) VALUES ($1, $2, 0.6)`, [match.want.id, match.have.id]);
    expect(await find(0.7)).toBeUndefined();
    await db.query(`UPDATE ipy_market_pair_check SET fit = 0.9 WHERE want_listing_id = $1 AND have_listing_id = $2`, [match.want.id, match.have.id]);
    expect(await find(0.7)).toBeDefined();
    const refresh = await request(app).post('/api/market/refresh').set('Authorization', `Bearer ${adminToken}`);
    expect(refresh.status).toBe(200);
    expect(refresh.body).toEqual({ started: true });
  });

  it('the HTTP routes answer, and refuse a status that does not exist', async () => {
    const list = await request(app).get('/api/market/matches?includeWorked=true&limit=500').set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const found = (list.body as Array<{ have: { posterPhone: string }; want: { id: string }; status: string }>).find((m) => m.have.posterPhone === sellerPhone)!;
    expect(found.status).toBe('dismissed');
    const bad = await request(app).put(`/api/market/matches/${found.want.id}/${found.want.id}`)
      .set('Authorization', `Bearer ${adminToken}`).send({ status: 'sold' });
    expect(bad.status).toBe(422);
  });

  it('lists the people who posted, and writing them to Associates does not break on a database without the module', async () => {
    const dealers = await dealerDirectory();
    const seller = dealers.find((d) => d.phone === sellerPhone);
    expect(seller?.name).toBe('Bhoomi Associates');
    expect(seller?.haves).toBe(1);
    const saved = await saveDealersAsAssociates(seller ? [seller] : []);
    expect(saved.created + saved.alreadyKnown + saved.noLocation + saved.refused > 0 || saved.noModule).toBe(true);
  });

  it('posts stored before sectors were understood are read again without Jev', async () => {
    await db.query(`UPDATE ipy_market_post SET read_version = 0, places = '{}', size_sqyd = NULL, place_keys = '{}' WHERE poster_phone = $1`, [sellerPhone]);
    expect(await reReadOldPosts(500)).toBeGreaterThanOrEqual(1);
    const row = await db.queryOne<{ size_sqyd: number; place_keys: string[] }>(`SELECT size_sqyd, place_keys FROM ipy_market_post WHERE poster_phone = $1`, [sellerPhone]);
    expect(row?.size_sqyd).toBe(260);
    expect(row?.place_keys).toContain('sector 85');
  });

  it('a dealer\'s record shows what they posted in four lists, and only theirs', async () => {
    const rentPhone = sellerPhone;
    // The same dealer also has a flat to let, and a tenant wants one.
    await upload(`Rentals ${marker}`, [
      `${stamp}, 11:00 am - Bhoomi Associates: 2 BHK flat available on rent sector 85 ${marker} 25000 per month call ${rentPhone}`,
      `${stamp}, 11:05 am - Bhoomi Associates: Tenant required 3 BHK builder floor sector 85 ${marker} call ${rentPhone}`,
    ].join('\n'));
    const ctx = await adminContext();
    const lead = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `Dealer ${marker}`, mobile: rentPhone }));
    const stranger = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `Nobody ${marker}` }));

    const deals = await dealsOfRecord(ctx, 'leads', lead.id);
    expect(deals.forSale.map((d) => d.body).join('|')).toContain('260 sq yd residential plot');
    expect(deals.forRent.map((d) => d.body).join('|')).toContain('2 BHK flat available on rent');
    expect(deals.tenantRequirements.map((d) => d.body).join('|')).toContain('Tenant required');
    expect(deals.buyerRequirements).toHaveLength(0);
    expect(deals.forSale[0]!.places).toContain('Sector 85');

    const none = await dealsOfRecord(ctx, 'leads', stranger.id);
    expect([none.forSale, none.forRent, none.buyerRequirements, none.tenantRequirements].every((list) => list.length === 0)).toBe(true);

    const http = await request(app).get(`/api/market/records/leads/${lead.id}/deals`).set('Authorization', `Bearer ${adminToken}`);
    expect(http.status).toBe(200);
    expect(http.body.forRent).toHaveLength(1);
  });
});
