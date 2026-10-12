import { describe, expect, it } from 'vitest';
import { bucketDeals, mergeDeals } from '../src/core/market/dealerDeals.js';
import { columnsToSet, DEAL_PATCH, mergeExtra, parseDealRef } from '../src/core/market/associateDeals.js';

const POST = '11111111-1111-4111-8111-111111111111';

const listing = (ord: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `l${ord}`, post_id: POST, ord, kind: 'have', purpose: 'sale', summary: `listing ${ord}`, category: 'Builder Floor',
  project: null, facing: null, floor: null, bhk: 3, size_sqyd: 200, price_min_lakh: 145, price_max_lakh: 145,
  place_keys: ['greenfields'], body: 'whole message', groups: ['G1'], seen_count: 1, urgency: null,
  posted_at: '2026-10-10T10:00:00Z', ...over,
});

const stored = (ord: number | null, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `s${ord ?? 'dup'}`, post_id: POST, source_ord: ord, kind: 'have', purpose: 'sale', is_deleted: false, summary: `listing ${ord}`,
  body: 'whole message', groups: ['G1'], seen_count: 1, posted_at: '2026-10-10T10:00:00Z', house_no: null, locality: null,
  category: null, project: null, facing: null, floor: null, portion: null, bhk: null, size_sqyd: null, price_min_lakh: null,
  price_max_lakh: null, next_followup_at: null, property_status: null, lost_reason: null, source: null, extra: {}, ...over,
});

describe('mergeDeals', () => {
  it('shows every listing the parser read when the team has touched none', () => {
    const rows = mergeDeals([listing(0), listing(1)], []);
    expect(rows.map((row) => row.deal.ref)).toEqual([`post:${POST}:0`, `post:${POST}:1`]);
    expect(rows.every((row) => !row.deal.stored)).toBe(true);
  });

  it("replaces a listing with the team's own row, so what they typed is what shows", () => {
    const rows = mergeDeals([listing(0), listing(1)], [stored(1, { house_no: 'B-12', locality: 'Greenfields Colony' })]);
    const adopted = rows.find((row) => row.deal.stored)!;
    expect(rows).toHaveLength(2);
    expect(adopted.deal.houseNo).toBe('B-12');
    expect(adopted.deal.places).toEqual(['Greenfields Colony']);
    expect(rows.filter((row) => row.deal.ref === `post:${POST}:1`)).toHaveLength(0);
  });

  it('keeps the same key when a listing becomes the team\'s row, so the screen does not lose its place', () => {
    const before = mergeDeals([listing(1)], [])[0].deal.key;
    const after = mergeDeals([listing(1)], [stored(1)])[0].deal.key;
    expect(after).toBe(before);
    expect(mergeDeals([], [stored(null, { id: 'copy' })])[0].deal.key).toBe('copy');
  });

  it('keeps a deleted listing gone when the post is re-read', () => {
    const rows = mergeDeals([listing(0), listing(1)], [stored(0, { is_deleted: true })]);
    expect(rows.map((row) => row.deal.ref)).toEqual([`post:${POST}:1`]);
  });

  it('adds a duplicate beside its original rather than in place of it', () => {
    const rows = mergeDeals([listing(0)], [stored(null, { id: 'copy' })]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.deal.stored).sort()).toEqual([false, true]);
  });

  it('moves a row to the other list when its For Sale / For Rent changes', () => {
    const buckets = bucketDeals(mergeDeals([listing(0)], [stored(0, { purpose: 'rent' })]));
    expect(buckets.forSale).toHaveLength(0);
    expect(buckets.forRent).toHaveLength(1);
  });
});

describe('parseDealRef', () => {
  it('reads a stored id and a listing reference', () => {
    expect(parseDealRef('22222222-2222-4222-8222-222222222222')).toEqual({ stored: '22222222-2222-4222-8222-222222222222' });
    expect(parseDealRef(`post:${POST}:3`)).toEqual({ postId: POST, ord: 3 });
  });

  it('refuses anything else', () => {
    expect(() => parseDealRef('x; drop table ipy_record')).toThrow();
    expect(() => parseDealRef(`post:${POST}:-1`)).toThrow();
  });
});

describe('what a form may change', () => {
  it('maps the form to columns the code chose, with an emptied box stored as nothing', () => {
    const pairs = columnsToSet({ houseNo: 'B-12', facing: '', bedrooms: 4, priceLakh: 150 });
    expect(pairs).toEqual([
      ['house_no', 'B-12'], ['facing', null], ['bhk', 4], ['price_min_lakh', 150], ['price_max_lakh', 150],
    ]);
  });

  it('writes nothing for a field that was not sent', () => {
    expect(columnsToSet({})).toEqual([]);
  });

  it('refuses an unknown key instead of ignoring it', () => {
    expect(DEAL_PATCH.safeParse({ owner_id: 'x' }).success).toBe(false);
    expect(DEAL_PATCH.safeParse({ nextFollowUpAt: '12/10/2026' }).success).toBe(false);
    expect(DEAL_PATCH.safeParse({ nextFollowUpAt: '2026-10-12', extra: { 'Bad Key': 'x' } }).success).toBe(false);
  });

  it('removes an extra field the admin took off the form when its box is emptied', () => {
    expect(mergeExtra({ a: '1', b: '2' }, { a: null, c: '3' })).toEqual({ b: '2', c: '3' });
  });
});
