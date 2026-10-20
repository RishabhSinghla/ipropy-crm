/**
 * Jev inside the CRM, held to its promises: a verdict is paid for once and survives a re-read of the message, what the team
 * decided is not erased by it, one odd pairing cannot stop the rest or be asked about for ever, an outage is told apart from
 * a bad pairing, and what it costs and has done can be read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { adminToken } from './fixtures.js';
import { saveListings, type ListingDraft } from '../../src/core/market/listings.js';
import { verifyPairs } from '../../src/core/market/enrich.js';
import { jevStatus } from '../../src/core/market/jevStatus.js';
import { recordOutcome } from '../../src/core/market/crossMatch.js';

// A TypeSafe key: the direct route, answered by the stub below.
vi.mock('../../src/core/settings/integrations.js', async (original) => ({
  ...(await original<typeof import('../../src/core/settings/integrations.js')>()),
  getIntegrationCredentials: (provider: string) => (provider === 'typesafe_jev' ? { apiKey: 'test-typesafe-key' } : null),
  getAiProviderSettings: () => null,
}));

let app: ReturnType<typeof createApp>;
let token = '';
let adminId = '';
const marker = `itestjevhonest${Date.now()}`;
const buyerPhone = `98${String(Date.now()).slice(-8)}`;
const sellerPhone = `97${String(Date.now()).slice(-8)}`;
const draft = (over: Partial<ListingDraft>): ListingDraft => ({
  kind: 'have', purpose: 'sale', category: 'Residential Plot', bhk: null, sizeSqYd: 250, priceMinLakh: 300, priceMaxLakh: 300,
  placeKeys: ['sector 87'], project: null, facing: null, floor: null, summary: `plot ${marker}`, ...over,
});
let buyerPost = '';
let sellerPost = '';
let mode: 'fine' | 'down' | 'one-bad' = 'fine';
const asked: string[] = [];

const makePost = async (body: string, phone: string, group: string): Promise<string> => (await db.queryOne<{ id: string }>(
  `INSERT INTO ipy_market_post (fingerprint, body, groups, poster_phone, phones, first_posted_at, last_posted_at, kind, jev_checked_at)
   VALUES ($1, $2, ARRAY[$3::text], $4, ARRAY[$4::text], now(), now(), 'unknown', now()) RETURNING id`, [`${marker}-${body.length}-${group}`, body, group, phone]))!.id;

beforeAll(async () => {
  app = createApp(); token = await adminToken(app);
  adminId = (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com'`))!.id;
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestjevhonest%'`);
  buyerPost = await makePost(`Required plot sector 87 ${marker}`, buyerPhone, `B ${marker}`);
  sellerPost = await makePost(`Plot for sale sector 87 ${marker} 250 sq yd`, sellerPhone, `S ${marker}`);
  await saveListings(buyerPost, [draft({ kind: 'want', priceMinLakh: null, priceMaxLakh: 400, summary: `want ${marker}` })], 'rules', false, { replace: false });
  await saveListings(sellerPost, [draft({ summary: `have ${marker}` })], 'rules', false, { replace: false });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { state: string };
    asked.push(sent.state);
    if (mode === 'down') return new Response('overloaded', { status: 529 });
    if (mode === 'one-bad' && sent.state.includes(marker)) return new Response('{"detail":"cannot read"}', { status: 422 });
    return new Response(JSON.stringify({ answers: { fit: { noul: 0.9 } }, usage: { input_tokens: 400, output_tokens: 3 } }), { status: 200 });
  }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.query(`DELETE FROM ipy_market_post WHERE body ILIKE '%itestjevhonest%'`);
});

const ids = async () => ({
  want: (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_market_listing WHERE post_id = $1`, [buyerPost]))!.id,
  have: (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_market_listing WHERE post_id = $1`, [sellerPost]))!.id,
});

describe('Jev inside the CRM', () => {
  it('rates a pairing once, counts the question, and is not asked again', async () => {
    mode = 'fine';
    await verifyPairs(50);
    const first = asked.filter((text) => text.includes(marker)).length;
    expect(first).toBe(1);
    const { want, have } = await ids();
    const row = await db.queryOne<{ fit: string }>(`SELECT fit FROM ipy_market_pair_check WHERE want_listing_id = $1 AND have_listing_id = $2`, [want, have]);
    expect(Number(row?.fit)).toBeCloseTo(0.9);
    await verifyPairs(50);
    expect(asked.filter((text) => text.includes(marker)).length).toBe(first);
    const status = await jevStatus();
    expect(status.connection).toMatchObject({ connected: true, via: 'typesafe', model: 'jev-latest' });
    expect(status.today.calls).toBeGreaterThanOrEqual(1);
    expect(status.today.tokens).toBeGreaterThanOrEqual(400);
    expect(status.today.costUsd).toBeGreaterThanOrEqual(0);
    expect(status.pairings.total).toBeGreaterThanOrEqual(status.pairings.rated);
  });

  it('keeps Jev\'s verdict and the team\'s decision when the message is re-read, and drops them for a property that changed', async () => {
    const before = await ids();
    await recordOutcome(before.want, before.have, 'called', 'rang both', adminId);
    // Re-read: the same property, written again.
    await saveListings(sellerPost, [draft({ summary: `have again ${marker}` })], 'ai');
    const after = await ids();
    expect(after.have).not.toBe(before.have);
    const verdict = await db.queryOne<{ fit: string }>(`SELECT fit FROM ipy_market_pair_check WHERE want_listing_id = $1 AND have_listing_id = $2`, [after.want, after.have]);
    expect(Number(verdict?.fit)).toBeCloseTo(0.9);
    const decision = await db.queryOne<{ status: string; note: string }>(`SELECT status, note FROM ipy_market_deal WHERE want_listing_id = $1 AND have_listing_id = $2`, [after.want, after.have]);
    expect(decision).toMatchObject({ status: 'called', note: 'rang both' });
    // A different property is a different question.
    await saveListings(sellerPost, [draft({ sizeSqYd: 400, summary: `bigger ${marker}` })], 'ai');
    const changed = await ids();
    expect((await db.query(`SELECT 1 FROM ipy_market_pair_check WHERE have_listing_id = $1`, [changed.have])).rowCount).toBe(0);
  });

  it('tells an outage from a bad pairing: nobody is blamed for Jev being down', async () => {
    // The seller is back to the size the buyer wants.
    await saveListings(sellerPost, [draft({ summary: `have back ${marker}` })], 'ai');
    const { want, have } = await ids();
    await db.query(`DELETE FROM ipy_market_pair_check WHERE want_listing_id = $1`, [want]);
    mode = 'down';
    await verifyPairs(50);
    expect((await db.query(`SELECT 1 FROM ipy_market_pair_failed WHERE want_listing_id = $1 AND have_listing_id = $2`, [want, have])).rowCount).toBe(0);
    const status = await jevStatus();
    expect(status.connection.lastError?.message).toContain('529');
  });

  it('leaves a pairing alone after three failures, and says so', async () => {
    const { want, have } = await ids();
    // Other pairings in the test database answer; this one is the odd one.
    await db.query(`INSERT INTO ipy_market_pair_failed (want_listing_id, have_listing_id, attempts) VALUES ($1, $2, 3) ON CONFLICT DO NOTHING`, [want, have]);
    mode = 'fine';
    const before = asked.length;
    await verifyPairs(50);
    expect(asked.slice(before).some((text) => text.includes(marker))).toBe(false);
  });

  it('the status route answers for anyone signed in', async () => {
    const res = await request(app).get('/api/market/jev-status').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pairings.total');
    expect(res.body).toHaveProperty('today.costUsd');
  });
});
