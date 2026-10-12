import { describe, expect, it } from 'vitest';
import { areaScore, bestPerRequirement, samePerson, scorePair, type MarketListing } from '../src/core/market/crossMatch.js';
import { onceEach } from '../src/core/market/dealerDeals.js';
import { associateValues, looksLikeAFirm, usableName, type FieldInfo } from '../src/core/market/dealers.js';

const NOW = new Date('2026-10-12T05:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let seq = 0;
function listing(over: Partial<MarketListing>): MarketListing {
  seq += 1;
  return {
    id: `l${seq}`, postId: `p${seq}`, kind: 'have', purpose: 'sale', category: 'Residential Plot', bhk: null,
    sizeSqYd: 250, priceMinLakh: 350, priceMaxLakh: 350, placeKeys: ['sector 85'], project: null, summary: '',
    posterName: `Dealer ${seq}`, posterPhone: `98000000${String(seq).padStart(2, '0')}`, phones: [`98000000${String(seq).padStart(2, '0')}`],
    groups: ['FEAWA'], postedAt: daysAgo(5), body: '', ...over,
  };
}
const buyer = (over: Partial<MarketListing> = {}) => listing({ kind: 'want', priceMinLakh: null, priceMaxLakh: 400, ...over });

describe('scoring a requirement against an offer', () => {
  it('a plot of the right size in the same sector, in budget, is a strong match', () => {
    const pairing = scorePair(buyer(), listing({}), NOW)!;
    expect(pairing.score).toBeGreaterThanOrEqual(0.9);
    expect(pairing.reasons).toContain('within budget');
  });

  it('never matches different sectors, a different kind of property or an over-budget ask', () => {
    expect(scorePair(buyer(), listing({ placeKeys: ['sector 21'] }), NOW)).toBeNull();
    expect(scorePair(buyer(), listing({ category: 'Apartment' }), NOW)).toBeNull();
    expect(scorePair(buyer({ priceMaxLakh: 300 }), listing({ priceMinLakh: 500 }), NOW)).toBeNull();
  });

  it('sector 28 is not sector 2, and sector 21 is close to sector 21C but not to sector 31', () => {
    expect(areaScore(['sector 28'], ['sector 2'])).toBeNull();
    expect(areaScore(['sector 21'], ['sector 21c'])!.score).toBeGreaterThanOrEqual(0.4);
    expect(areaScore(['sector 21a'], ['sector 21c'])!.score).toBeLessThan(0.2);
    expect(areaScore(['sector 21'], ['sector 31'])).toBeNull();
  });

  it('a developer in common is a weak reason, a sector in common a strong one', () => {
    expect(areaScore(['bptp'], ['bptp'])!.score).toBeLessThan(0.3);
    expect(areaScore(['sector 85'], ['sector 85'])!.score).toBeGreaterThanOrEqual(0.45);
  });

  it('a size four times the one asked for is another property, however well the sector fits', () => {
    expect(scorePair(buyer({ sizeSqYd: 160 }), listing({ sizeSqYd: 1050 }), NOW)).toBeNull();
    expect(scorePair(buyer({ sizeSqYd: 250 }), listing({ sizeSqYd: 330 }), NOW)).not.toBeNull();
  });

  it('somebody wanting a kothi is not offered a flat', () => {
    const wants = buyer({ category: 'Kothi/Villa', sizeSqYd: null });
    expect(scorePair(wants, listing({ category: 'Apartment', sizeSqYd: null }), NOW)).toBeNull();
    expect(scorePair(wants, listing({ category: 'Builder Floor', sizeSqYd: null }), NOW)).not.toBeNull();
  });

  it('a place and a type alone are not enough — one agreeing detail makes it a lead', () => {
    const bare = (over: Partial<MarketListing> = {}) => ({ sizeSqYd: null, priceMinLakh: null, priceMaxLakh: null, ...over });
    const pairing = scorePair(buyer(bare()), listing(bare()), NOW)!;
    expect(pairing.score).toBeLessThan(0.5);
  });

  it('never pairs a purchase with a rental, or different BHKs', () => {
    expect(scorePair(buyer({ purpose: 'rent' }), listing({}), NOW)).toBeNull();
    expect(scorePair(buyer({ purpose: 'rent' }), listing({ purpose: 'rent' }), NOW)).not.toBeNull();
    const flat = (over: Partial<MarketListing>) => ({ category: 'Apartment', sizeSqYd: null, bhk: 3, ...over });
    expect(scorePair(buyer(flat({})), listing(flat({ bhk: 2 })), NOW)).toBeNull();
  });

  it('a stale pair scores below a fresh one', () => {
    const bare = (over: Partial<MarketListing>) => ({ sizeSqYd: null, priceMinLakh: null, priceMaxLakh: null, bhk: 3, category: 'Apartment', ...over });
    const fresh = scorePair(buyer(bare({})), listing(bare({})), NOW)!.score;
    const stale = scorePair(buyer(bare({ postedAt: daysAgo(300) })), listing(bare({ postedAt: daysAgo(300) })), NOW)!.score;
    expect(stale).toBeLessThan(fresh);
  });
});

describe('the best offer for each requirement', () => {
  it('lists only introductions across groups unless asked for the rest', () => {
    const wants = buyer({ groups: ['A'] });
    const sameGroup = listing({ groups: ['A'] });
    const otherGroup = listing({ groups: ['B'] });
    expect(bestPerRequirement([wants, sameGroup], {}, NOW)).toHaveLength(0);
    expect(bestPerRequirement([wants, sameGroup], { crossGroupOnly: false }, NOW)).toHaveLength(1);
    const found = bestPerRequirement([wants, sameGroup, otherGroup], {}, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]!.have.id).toBe(otherGroup.id);
    expect(found[0]!.crossGroup).toBe(true);
  });

  it('never introduces somebody to themselves — by number, or by the name WhatsApp shows', () => {
    const me = buyer({ groups: ['A'], phones: ['9811111111'], posterName: 'Sanjay Kumar DS21' });
    expect(samePerson(me, listing({ groups: ['B'], phones: ['9811111111', '9822222222'] }))).toBe(true);
    // Two numbers, one man: Sanjay Arora posts his requirement and his offer under different numbers.
    expect(samePerson(me, listing({ groups: ['B'], posterName: '~ Sanjay Kumar DS21' }))).toBe(true);
    expect(bestPerRequirement([me, listing({ groups: ['B'], posterName: 'Sanjay Kumar DS21' })], {}, NOW)).toHaveLength(0);
  });

  it('a listing people have called wrong needs to be a better fit each time', () => {
    const wants = buyer({ groups: ['A'] });
    const offer = listing({ groups: ['B'] });
    const fresh = bestPerRequirement([wants, offer], {}, NOW);
    const once = bestPerRequirement([wants, offer], {}, NOW, new Map([[offer.id, 1]]));
    const thrice = bestPerRequirement([wants, offer], { minScore: 0.9 }, NOW, new Map([[offer.id, 3]]));
    expect(once[0]!.score).toBeLessThan(fresh[0]!.score);
    expect(once[0]!.reasons).toContain('marked wrong 1 time before');
    // Three strikes and even a strong fit no longer clears a high bar.
    expect(thrice).toHaveLength(0);
  });

  it('a listing with nothing but a city to say where it is matches nobody', () => {
    expect(bestPerRequirement([buyer({ placeKeys: [], groups: ['A'] }), listing({ placeKeys: [], groups: ['B'] })], {}, NOW)).toHaveLength(0);
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

describe('a dealer\'s deal lists', () => {
  it('shows a place once, in the business\'s own spelling', () => {
    expect(onceEach(['Sector 78', 'sector 78', 'Greenfields Colony'])).toEqual(['Sector 78', 'Greenfields Colony']);
  });
});
