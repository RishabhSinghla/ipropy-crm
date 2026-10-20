import { describe, expect, it } from 'vitest';
import { areaScore, bestPerRequirement, lessonPenalty, listingPasses, NO_LESSONS, samePerson, scorePair, sortMatches, type Lessons, type MarketListing } from '../src/core/market/crossMatch.js';
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
    expect(scorePair(buyer({ sizeSqYd: 250 }), listing({ sizeSqYd: 330 }), NOW)).toBeNull();
  });

  it('250 yd fits 275, but 303 is another plot and 300 is only a stretch that never reaches the sheet', () => {
    expect(scorePair(buyer({ sizeSqYd: 250 }), listing({ sizeSqYd: 275 }), NOW)!.score).toBeGreaterThanOrEqual(0.9);
    expect(scorePair(buyer({ sizeSqYd: 250 }), listing({ sizeSqYd: 303 }), NOW)).toBeNull();
    expect(scorePair(buyer({ sizeSqYd: 250, priceMaxLakh: null }), listing({ sizeSqYd: 300, priceMinLakh: null }), NOW)!.score).toBeLessThan(0.5);
  });

  it('the same requirement posted twice, against the same seller, is one introduction', () => {
    const seller = listing({ summary: 'F47 size 250 sqyrd sec 88' });
    const first = buyer({ posterPhone: '9811111111', summary: 'Amolik sco sec 88 250 sqyd', id: 'a1' });
    const repost = buyer({ posterPhone: '9811111111', summary: 'Amolik SCO sec 88 250 sqyd!', id: 'a2', postId: 'pa2' });
    const found = bestPerRequirement([first, repost, seller], { crossGroupOnly: false }, NOW);
    expect(found).toHaveLength(1);
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

  it('marks a pair recent only when both posts are within the 45-day window', () => {
    const withinWindow = scorePair(buyer({ postedAt: daysAgo(45) }), listing({ postedAt: daysAgo(45) }), NOW)!;
    const outsideWindow = scorePair(buyer({ postedAt: daysAgo(46) }), listing({ postedAt: daysAgo(46) }), NOW)!;

    expect(withinWindow.reasons).toContain('recent (within 45 days)');
    expect(outsideWindow.reasons).not.toContain('recent (within 45 days)');
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

describe('narrowing and ordering the call sheet', () => {
  const pair = (want: Partial<MarketListing>, have: Partial<MarketListing>, score: number, jevFit: number | null = null) =>
    ({ want: buyer(want), have: listing(have), score, jevFit });

  it('keeps a property that does not say its size or type, and drops one that says the wrong thing', () => {
    expect(listingPasses(listing({ sizeSqYd: null }), { sizeMinSqYd: 200, sizeMaxSqYd: 300 })).toBe(true);
    expect(listingPasses(listing({ sizeSqYd: 250 }), { sizeMinSqYd: 200, sizeMaxSqYd: 300 })).toBe(true);
    expect(listingPasses(listing({ sizeSqYd: 150 }), { sizeMinSqYd: 200 })).toBe(false);
    expect(listingPasses(listing({ category: 'Builder Floor' }), { category: 'Residential Plot' })).toBe(false);
    expect(listingPasses(listing({ category: null }), { category: 'Residential Plot' })).toBe(true);
    expect(listingPasses(listing({ purpose: 'rent' }), { purpose: 'sale' })).toBe(false);
  });

  it('finds an area by any part of its name, as the sheet prints it', () => {
    expect(listingPasses(listing({ placeKeys: ['sector 85'] }), { area: '85' })).toBe(true);
    expect(listingPasses(listing({ placeKeys: ['sector 85'] }), { area: 'Sector 8' })).toBe(true);
    expect(listingPasses(listing({ placeKeys: ['sector 85'] }), { area: 'sector 21' })).toBe(false);
    expect(listingPasses(listing({ placeKeys: ['bptp:block a'] }), { area: 'BPTP' })).toBe(true);
  });

  it('puts a fresh strong pair above a stale one, and a stronger fit above a weaker one of the same age', () => {
    const stale = pair({ postedAt: daysAgo(40) }, { postedAt: daysAgo(40) }, 0.9);
    const fresh = pair({ postedAt: daysAgo(1) }, { postedAt: daysAgo(1) }, 0.8);
    const weakFresh = pair({ postedAt: daysAgo(1) }, { postedAt: daysAgo(1) }, 0.5);
    expect(sortMatches([stale, weakFresh, fresh], 'best', NOW)).toEqual([fresh, weakFresh, stale]);
  });

  it('is only as fresh as its older side', () => {
    const oneStale = pair({ postedAt: daysAgo(1) }, { postedAt: daysAgo(44) }, 0.9);
    const bothFresh = pair({ postedAt: daysAgo(3) }, { postedAt: daysAgo(3) }, 0.9);
    expect(sortMatches([oneStale, bothFresh], 'newest', NOW)[0]).toBe(bothFresh);
  });

  it('"most matching" ignores age and trusts Jev over the rules alone', () => {
    const oldButSure = pair({ postedAt: daysAgo(40) }, { postedAt: daysAgo(40) }, 0.7, 0.95);
    const newButMaybe = pair({ postedAt: daysAgo(1) }, { postedAt: daysAgo(1) }, 0.7, 0.5);
    expect(sortMatches([newButMaybe, oldButSure], 'match', NOW)[0]).toBe(oldButSure);
  });
});

describe('what the matcher learns from "not a real match"', () => {
  const lessons = (over: Partial<Lessons>): Lessons => ({ ...NO_LESSONS, wrong: new Map(), hidden: new Set(), signatures: new Map(), posters: new Map(), ...over });

  it('a pairing put away is skipped, so the buyer is shown their next best seller instead', () => {
    const wants = buyer({ groups: ['A'] });
    const best = listing({ groups: ['B'] });
    const next = listing({ groups: ['B'], sizeSqYd: 240 });
    expect(bestPerRequirement([wants, best, next], {}, NOW)[0]!.have).toBe(best);
    const after = bestPerRequirement([wants, best, next], {}, NOW, lessons({ hidden: new Set([`${wants.id}:${best.id}`]) }));
    expect(after).toHaveLength(1);
    expect(after[0]!.have).toBe(next);
  });

  it('a kind of pairing that keeps being marked wrong costs every pairing of that kind, once there is enough evidence', () => {
    const want = buyer({ groups: ['A'] });
    const have = listing({ groups: ['B'] });
    const signature = scorePair(want, have, NOW)!.signature;
    expect(lessonPenalty(signature, want, have, lessons({ signatures: new Map([[signature, { bad: 2, good: 0 }]]) })).penalty).toBe(0);
    const learned = lessonPenalty(signature, want, have, lessons({ signatures: new Map([[signature, { bad: 6, good: 1 }]]) }));
    expect(learned.penalty).toBeGreaterThan(0.1);
    expect(learned.notes.join(' ')).toContain('marked wrong 6 of 7');
    // ...but not when the same kind of pairing has mostly worked out.
    expect(lessonPenalty(signature, want, have, lessons({ signatures: new Map([[signature, { bad: 3, good: 9 }]]) })).penalty).toBe(0);
  });

  it('a dealer whose listings keep being wrong has to fit better to be offered', () => {
    const want = buyer({ groups: ['A'] });
    const have = listing({ groups: ['B'], posterPhone: '9811111111' });
    const taught = lessonPenalty('x', want, have, lessons({ posters: new Map([['9811111111', 4]]) }));
    expect(taught.penalty).toBeGreaterThan(0);
    expect(taught.notes[0]).toContain('dealer');
    expect(lessonPenalty('x', want, have, lessons({ posters: new Map([['9811111111', 1]]) })).penalty).toBe(0);
  });

  it('names the facts that agreed, so a pairing can be recognised as a kind', () => {
    const pairing = scorePair(buyer(), listing({}), NOW)!;
    expect(pairing.signature).toBe('area:sector+type:same+size:fits+budget');
  });
});

