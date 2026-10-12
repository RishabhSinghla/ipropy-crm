import { describe, expect, it } from 'vitest';
import { bestPerBuyer, scorePair, type MarketDeal } from '../src/core/market/crossMatch.js';
import { associateValues, looksLikeAFirm, usableName, type FieldInfo } from '../src/core/market/dealers.js';

const NOW = new Date('2026-10-12T05:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function deal(over: Partial<MarketDeal>): MarketDeal {
  return {
    id: Math.random().toString(36).slice(2), kind: 'have', placeKeys: ['sector 85'], category: 'Residential Plot',
    bhk: null, sizeSqYd: 250, priceMinLakh: 350, priceMaxLakh: 350, posterName: 'A', posterPhone: '9811111111',
    groups: ['FEAWA'], postedAt: daysAgo(5), body: '', ...over,
  };
}

describe('scoring a buyer against a seller', () => {
  it('a plot of the right size in the same sector, in budget, is a strong match', () => {
    const buyer = deal({ kind: 'want', priceMaxLakh: 400, posterPhone: '9822222222' });
    const pairing = scorePair(buyer, deal({}), NOW)!;
    expect(pairing.score).toBeGreaterThanOrEqual(0.9);
    expect(pairing.reasons).toContain('within budget');
  });

  it('never matches different areas, different kinds of property or an over-budget ask', () => {
    const buyer = deal({ kind: 'want', priceMaxLakh: 300 });
    expect(scorePair(buyer, deal({ placeKeys: ['sector 21'] }), NOW)).toBeNull();
    expect(scorePair(buyer, deal({ category: 'Apartment' }), NOW)).toBeNull();
    expect(scorePair(buyer, deal({ priceMinLakh: 500 }), NOW)).toBeNull();
  });

  it('a seller a little over budget still counts; a buyer asking a different BHK does not', () => {
    const buyer = deal({ kind: 'want', priceMaxLakh: 300, category: 'Apartment', bhk: 3, sizeSqYd: null });
    const flat = (over: Partial<MarketDeal>) => deal({ category: 'Apartment', sizeSqYd: null, bhk: 3, ...over });
    expect(scorePair(buyer, flat({ priceMinLakh: 340 }), NOW)).not.toBeNull();
    expect(scorePair(buyer, flat({ bhk: 2 }), NOW)).toBeNull();
  });

  it('a stale pair scores below a fresh one', () => {
    // No size or price, so neither side is held at the ceiling of 1.
    const bare = (over: Partial<MarketDeal>) => deal({ sizeSqYd: null, priceMinLakh: null, priceMaxLakh: null, ...over });
    const fresh = scorePair(bare({ kind: 'want' }), bare({}), NOW)!.score;
    const stale = scorePair(bare({ kind: 'want', postedAt: daysAgo(300) }), bare({ postedAt: daysAgo(300) }), NOW)!.score;
    expect(stale).toBeLessThan(fresh);
  });
});

describe('the best seller for each buyer', () => {
  it('lists only introductions across groups unless asked for the rest', () => {
    const buyer = deal({ kind: 'want', groups: ['A'], posterPhone: '9822222222' });
    const sameGroup = deal({ groups: ['A'], posterPhone: '9833333333' });
    const otherGroup = deal({ groups: ['B'], posterPhone: '9844444444' });
    expect(bestPerBuyer([buyer, sameGroup], {}, NOW)).toHaveLength(0);
    expect(bestPerBuyer([buyer, sameGroup], { crossGroupOnly: false }, NOW)).toHaveLength(1);
    const found = bestPerBuyer([buyer, sameGroup, otherGroup], {}, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]!.have.posterPhone).toBe('9844444444');
    expect(found[0]!.crossGroup).toBe(true);
  });

  it('never introduces somebody to themselves', () => {
    const buyer = deal({ kind: 'want', groups: ['A'], posterPhone: '9811111111' });
    expect(bestPerBuyer([buyer, deal({ groups: ['B'] })], {}, NOW)).toHaveLength(0);
  });
});

describe('dealers becoming Associates', () => {
  const dealer = { phone: '9811111111', name: 'Bhoomi Associates', posts: 12, haves: 10, wants: 2, groups: ['FEAWA'], localities: ['sector 85', 'Greenfields Colony', 'Sector 21'], category: 'Residential Plot', lastSeenAt: null };
  const options = (...values: string[]) => new Map(values.map((v) => [v.toLowerCase(), v] as const));
  const production = new Map<string, FieldInfo>([
    ['preferred_locations', { multi: false, options: options('Greenfields Colony', 'Sector 21') }],
    ['contact_type', { multi: false, options: options('Builder', 'Dealer', 'Seller') }],
    ['associate_status', { multi: false, options: options('New', 'Active') }],
    ['category', { multi: false, options: options('Residential Plot', 'Unknown') }],
    ['company', { multi: false, options: null }],
    ['source', { multi: false, options: options('Facebook', 'WhatsApp') }],
  ]);

  it('fills what the module has, picking only values its own lists offer', () => {
    expect(associateValues(dealer, production)).toEqual({
      full_name: 'Bhoomi Associates', mobile: '9811111111', preferred_locations: 'Greenfields Colony',
      contact_type: 'Dealer', associate_status: 'New', category: 'Residential Plot', company: 'Bhoomi Associates', source: 'WhatsApp',
    });
  });

  it('calls a dealer a Broker where that is the module\'s word, and leaves out what it has no word for', () => {
    const cloned = new Map<string, FieldInfo>([
      ['preferred_locations', { multi: true, options: options('Sector 21', 'Greenfields Colony') }],
      ['contact_type', { multi: false, options: options('Broker', 'Buyer') }],
      ['status', { multi: false, options: options('Fresh', 'Active') }],
    ]);
    expect(associateValues(dealer, cloned)).toEqual({
      full_name: 'Bhoomi Associates', mobile: '9811111111', preferred_locations: ['Greenfields Colony', 'Sector 21'],
      contact_type: 'Broker', status: 'Fresh',
    });
  });

  it('lists a location once even when it was read twice', () => {
    const twice = associateValues({ ...dealer, localities: ['Sector 21', 'sector 21'] }, new Map<string, FieldInfo>([['preferred_locations', { multi: true, options: options('Sector 21') }]]));
    expect(twice!.preferred_locations).toEqual(['Sector 21']);
  });

  it('is a Builder when the name says so', () => {
    expect(associateValues({ ...dealer, name: 'Sunil Builders' }, production)!.contact_type).toBe('Builder');
  });

  it('does not invent a location', () => {
    expect(associateValues({ ...dealer, localities: ['sector 85'] }, production)).toBeNull();
    expect(associateValues({ ...dealer, localities: [] }, production)).toBeNull();
  });

  it('keeps a number as the name only when there is nothing better', () => {
    expect(usableName('+91 98111 11111')).toBeNull();
    expect(associateValues({ ...dealer, name: '+91 98111 11111' }, production)!.full_name).toBe('WhatsApp 9811111111');
    expect(looksLikeAFirm('Ramesh')).toBe(false);
    expect(looksLikeAFirm('Guruji Kripa Realtors')).toBe(true);
  });
});
