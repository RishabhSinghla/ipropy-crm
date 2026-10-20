/**
 * A buyer in one dealer group and a seller in another cannot find each other.
 * This finds them: every requirement in the feed against every offer, scored on
 * the few facts a listing carries — and rejected outright when a fact a broker
 * checks first (type, size, budget, BHK, rent or sale) does not fit.
 *
 * It works on **listings**, one per property, not on messages. A broker's
 * message of twenty plots used to be one deal with the first size and every
 * sector it named, which matched everybody; each plot is now matched on its own
 * sector, size and price.
 *
 * It never contacts anyone and stores nothing but what a person did about a
 * pairing (`ipy_market_deal`) and Jev's second opinion on it
 * (`ipy_market_pair_check`). Pairings themselves are worked out fresh each time,
 * so a better rule tomorrow improves the whole feed without a rebuild.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { BROAD_AREAS, categoryFamily, isProjectKey, tidyBody } from './readPost.js';

export interface MarketListing {
  id: string;
  postId: string;
  kind: 'have' | 'want';
  purpose: 'sale' | 'rent';
  category: string | null;
  bhk: number | null;
  sizeSqYd: number | null;
  priceMinLakh: number | null;
  priceMaxLakh: number | null;
  placeKeys: string[];
  project: string | null;
  summary: string;
  posterName: string | null;
  posterPhone: string | null;
  phones: string[];
  groups: string[];
  postedAt: Date | null;
  /** The whole message this listing came from. Empty until a pairing is shown (see `findCrossMatches`). */
  body: string;
}

export interface Pairing {
  score: number;
  reasons: string[];
  /** Which facts agreed, as a stable word ("area:sector+size:fits+type:same"), so the system can learn which kinds of pairing turn out wrong. */
  signature: string;
}

/** A seller quoting a little over what the buyer named will usually come down. */
const PRICE_GRACE = 1.15;
const DAY_MS = 86_400_000;

/** Below this Jev thinks the offer does not answer the requirement, and the call sheet leaves it out. */
export const JEV_FIT_FLOOR = 0.45;

/** "sector 21c" → base "21" and pocket "c". */
function sectorParts(key: string): { base: string; pocket: string } | null {
  const match = /^sector (\d{1,3})([a-z]?)$/.exec(key);
  return match ? { base: match[1]!, pocket: match[2]! } : null;
}

/**
 * How well two places agree, 0 for none. A named sector is the strongest signal in this
 * market; a pocket of the same sector is close but not the same; a developer or a wide
 * area is real but weak. A bare city never reaches here — it is not a place key at all.
 */
export function areaScore(wanted: string[], offered: string[]): { score: number; why: string; code: string } | null {
  let best: { score: number; why: string; code: string } | null = null;
  const take = (score: number, why: string, code: string): void => { if (!best || score > best.score) best = { score, why, code }; };
  for (const a of wanted) {
    for (const b of offered) {
      if (a === b) {
        // A named sector or block is exact; a colony the business lists is nearly so; a developer or a wide area is weak.
        const strength = BROAD_AREAS.has(a) ? 0.2 : a.includes(':') ? 0.4 : sectorParts(a) ? 0.45 : isProjectKey(a) ? 0.25 : 0.42;
        take(strength, `same area: ${label(a)}`, BROAD_AREAS.has(a) ? 'broad' : a.includes(':') ? 'block' : sectorParts(a) ? 'sector' : isProjectKey(a) ? 'project' : 'place');
        continue;
      }
      const x = sectorParts(a);
      const y = sectorParts(b);
      if (x && y && x.base === y.base) {
        // "Sector 21" and "Sector 21C": the buyer did not narrow it, so any pocket will do.
        take(x.pocket === '' || y.pocket === '' ? 0.4 : 0.15, `same sector: ${label(a)} / ${label(b)}`, x.pocket === '' || y.pocket === '' ? 'sector-any-pocket' : 'sector-other-pocket');
      }
    }
  }
  return best;
}

export function label(key: string): string {
  if (key.includes(':')) {
    const [project, rest] = key.split(':');
    return `${project!.toUpperCase()} · ${rest!.replace(/^block /, 'Block ')}`;
  }
  const sector = /^sector (\d+)([a-z]?)$/.exec(key);
  if (sector) return `Sector ${sector[1]}${sector[2]!.toUpperCase()}`;
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Plots, homes and commercial space are different purchases; within homes, a kothi is not a flat. */
function typeFit(want: MarketListing, have: MarketListing): { ok: boolean; bonus: number; why: string | null } {
  const a = categoryFamily(want.category);
  const b = categoryFamily(have.category);
  if (!a || !b) return { ok: true, bonus: 0, why: null };
  if (a !== b) return { ok: false, bonus: 0, why: null };
  if (want.category === have.category) return { ok: true, bonus: 0.2, why: `same type: ${have.category}` };
  const pair = new Set([want.category, have.category]);
  // Somebody who wants a kothi does not want a flat, however well the sector fits.
  if (pair.has('Apartment') && pair.has('Kothi/Villa')) return { ok: false, bonus: 0, why: null };
  return { ok: true, bonus: 0.08, why: `close type: ${want.category} / ${have.category}` };
}

/** Null means the two cannot be a deal at all; otherwise how good a one, and why. */
export function scorePair(want: MarketListing, have: MarketListing, now = new Date()): Pairing | null {
  // Somebody buying is not introduced to a landlord, and a tenant is not introduced to a seller.
  if (want.purpose !== have.purpose) return null;
  const reasons: string[] = [];
  const features: string[] = [];

  const area = areaScore(want.placeKeys, have.placeKeys);
  if (!area) return null;
  let score = area.score;
  reasons.push(area.why);
  features.push(`area:${area.code}`);

  const type = typeFit(want, have);
  if (!type.ok) return null;
  score += type.bonus;
  if (type.why) reasons.push(type.why);
  features.push(type.bonus >= 0.2 ? 'type:same' : type.bonus > 0 ? 'type:close' : 'type:unknown');

  if (want.bhk && have.bhk && want.bhk !== have.bhk) return null;
  let agreed = 0;
  if (want.bhk && have.bhk) { score += 0.1; agreed += 1; reasons.push(`${have.bhk} BHK`); features.push('bhk'); }

  if (want.sizeSqYd && have.sizeSqYd) {
    // Plots come in 100, 150, 200, 250, 300 and each is a different purchase: 250 will look at 225–275,
    // and 300 is only a stretch. The first live read called 250 against 303 a perfect fit.
    const tolerance = Math.max(15, Math.round(want.sizeSqYd * 0.1));
    const gap = Math.abs(want.sizeSqYd - have.sizeSqYd);
    if (gap <= tolerance) {
      score += 0.25;
      agreed += 1;
      reasons.push(`size fits: wants ${want.sizeSqYd} yd, has ${have.sizeSqYd} yd`);
      features.push('size:fits');
    } else if (gap <= tolerance * 2) {
      score += 0.03;
      reasons.push(`size is off: wants ${want.sizeSqYd} yd, has ${have.sizeSqYd} yd`);
      features.push('size:off');
    } else {
      return null;
    }
  }

  if (want.priceMaxLakh && have.priceMinLakh) {
    if (have.priceMinLakh > want.priceMaxLakh * PRICE_GRACE) return null;
    score += 0.1;
    agreed += 1;
    reasons.push('within budget');
    features.push('budget');
  }

  if (want.posterPhone) score += 0.03;

  const times = [want.postedAt?.getTime(), have.postedAt?.getTime()].filter((t): t is number => typeof t === 'number');
  if (times.length) {
    const ageDays = (now.getTime() - Math.min(...times)) / DAY_MS;
    if (ageDays <= 45) {
      score += 0.07;
      reasons.push('recent (within 45 days)');
    } else if (ageDays > 200) {
      score -= 0.05;
      reasons.push('older postings');
    }
  }
  // An area and a type alone fit half the feed; one agreeing detail is what makes it a lead.
  if (agreed === 0) score = Math.min(score, 0.49);
  return { score: Math.round(Math.min(Math.max(score, 0), 1) * 100) / 100, reasons, signature: features.join('+') };
}

export interface CrossMatch {
  /** The two listings, `${want}:${have}` — what an outcome is recorded against. */
  id: string;
  want: MarketListing;
  have: MarketListing;
  score: number;
  reasons: string[];
  /** True when the two were posted in groups with nobody in common — the pairs only we can see. */
  crossGroup: boolean;
  status: 'new' | 'called' | 'meeting' | 'won' | 'lost' | 'dismissed' | 'bad_match';
  note: string | null;
  /** Jev's probability that the offer answers the requirement; null until it has looked. */
  jevFit: number | null;
}

export interface CrossMatchQuery {
  days?: number;
  minScore?: number;
  /** Default true: two dealers in one group can already see each other's posts. */
  crossGroupOnly?: boolean;
  /** Pairings already won, lost or dismissed are left off unless asked for. */
  includeWorked?: boolean;
  /** Pairings Jev has not looked at yet are shown, marked as such, unless this is true. */
  onlyVerified?: boolean;
  /** "Sure-shot": Jev has looked and rates the fit at least this high. Implies verified. */
  minJevFit?: number;
  limit?: number;
  /** Narrow the sheet. A listing that does not say (no size, no type) is kept: silence is not a mismatch. */
  category?: string;
  sizeMinSqYd?: number;
  sizeMaxSqYd?: number;
  /** Part of a sector, block or project name: "77", "greenfield". */
  area?: string;
  bhk?: number;
  purpose?: 'sale' | 'rent';
  sort?: MatchSort;
  /** Show only pairings in this state: "new" is the ones nobody has worked yet. */
  status?: 'new' | 'called' | 'meeting' | 'won' | 'lost';
}

/** `best` is the default: strongest fits first, but a fresh pair outranks a stale one. */
export const MATCH_SORTS = ['best', 'match', 'newest'] as const;
export type MatchSort = (typeof MATCH_SORTS)[number];

/** Nobody works a deal older than this: a requirement or an offer from last quarter is gone. */
export const MAX_DEAL_AGE_DAYS = 45;

/** Pure: does this one property survive the narrowing the person asked for? */
export function listingPasses(listing: MarketListing, query: CrossMatchQuery): boolean {
  if (query.purpose && listing.purpose !== query.purpose) return false;
  if (query.category && listing.category && listing.category !== query.category) return false;
  if (query.bhk && listing.bhk && listing.bhk !== query.bhk) return false;
  if (listing.sizeSqYd) {
    if (query.sizeMinSqYd && listing.sizeSqYd < query.sizeMinSqYd) return false;
    if (query.sizeMaxSqYd && listing.sizeSqYd > query.sizeMaxSqYd) return false;
  }
  const area = query.area?.trim().toLowerCase();
  if (area && !listing.placeKeys.some((key) => key.includes(area) || label(key).toLowerCase().includes(area))) return false;
  return true;
}

/** The older of the two postings: a pair is only as fresh as its stalest side. */
function pairAgeDays(pair: { want: MarketListing; have: MarketListing }, now: Date): number {
  const times = [pair.want.postedAt, pair.have.postedAt].filter((at): at is Date => at !== null).map((at) => at.getTime());
  return times.length ? Math.max(0, (now.getTime() - Math.min(...times)) / DAY_MS) : MAX_DEAL_AGE_DAYS;
}

/** Jev's read when there is one, blended with the rules' score; the rules alone saturate for any pair in one sector. */
function quality(pair: { score: number; jevFit: number | null }): number {
  return pair.jevFit === null ? pair.score : 0.6 * pair.jevFit + 0.4 * pair.score;
}

/**
 * Pure: put the sheet in order. Default `best` weighs fit at 65% and freshness at 35%, so the top of
 * the list is the latest and most matching on both sides; `match` ignores age; `newest` ignores fit.
 */
export function sortMatches<T extends { want: MarketListing; have: MarketListing; score: number; jevFit: number | null }>(
  matches: T[], sort: MatchSort = 'best', now = new Date(),
): T[] {
  const fresh = (m: T): number => Math.max(0, 1 - pairAgeDays(m, now) / MAX_DEAL_AGE_DAYS);
  const key = (m: T): number => (sort === 'newest' ? fresh(m) : sort === 'match' ? quality(m) : 0.65 * quality(m) + 0.35 * fresh(m));
  const tie = (m: T): number => (sort === 'newest' ? quality(m) : fresh(m));
  return [...matches].sort((a, b) => key(b) - key(a) || tie(b) - tie(a));
}

function sharesAGroup(a: string[], b: string[]): boolean {
  return a.some((group) => b.includes(group));
}

/** "Sanjay Kumar DS21" and "~ Sanjay Kumar DS21" are the same person; so is anyone sharing a number. */
function nameOf(person: string | null): string {
  return (person ?? '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function samePerson(want: MarketListing, have: MarketListing): boolean {
  if (want.phones.some((phone) => have.phones.includes(phone))) return true;
  const a = nameOf(want.posterName);
  const b = nameOf(have.posterName);
  // A bare number is a sender WhatsApp could not name; two of those are the same person only if equal.
  return a.length > 2 && a === b;
}

function rowToListing(row: Record<string, unknown>): MarketListing {
  return {
    id: row.id as string,
    postId: row.post_id as string,
    kind: row.kind as 'have' | 'want',
    purpose: row.purpose as 'sale' | 'rent',
    category: row.category as string | null,
    bhk: row.bhk as number | null,
    sizeSqYd: row.size_sqyd as number | null,
    priceMinLakh: row.price_min_lakh as number | null,
    priceMaxLakh: row.price_max_lakh as number | null,
    placeKeys: row.place_keys as string[],
    project: row.project as string | null,
    summary: row.summary as string,
    posterName: row.poster_name as string | null,
    posterPhone: row.poster_phone as string | null,
    phones: (row.phones as string[] | null) ?? [],
    groups: row.groups as string[],
    postedAt: row.posted_at ? new Date(row.posted_at as string) : null,
    // Filled in for the pairings that are shown; loading every message to match the feed would be megabytes for nothing.
    body: '',
  };
}

/**
 * What the team has taught the matcher. Every "not a real match" is a lesson at three levels, so one click
 * improves the whole sheet and not only that card:
 *  - the **listing** (marked wrong before: vague or mistaken, so it must fit excellently to be offered again);
 *  - the **kind of pairing** (the same facts agreeing — "same sector only, no size" — that keeps turning out wrong);
 *  - the **dealer** (their listings keep being wrong).
 * Pairings somebody put away, or that Jev rates a non-fit, are `hidden`: skipped, so the next best one surfaces.
 */
export interface Lessons {
  wrong: Map<string, number>;
  hidden: Set<string>;
  signatures: Map<string, { bad: number; good: number }>;
  posters: Map<string, number>;
}
export const NO_LESSONS: Lessons = { wrong: new Map(), hidden: new Set(), signatures: new Map(), posters: new Map() };

/** Enough evidence before it counts: one mistake must not rewrite the rules. */
const SIGNATURE_MIN_WRONG = 3;
const POSTER_MIN_WRONG = 3;

/** Pure. How much a pairing's score drops for what the team has marked wrong before, and the words that say why. */
export function lessonPenalty(signature: string, want: MarketListing, have: MarketListing, lessons: Lessons): { penalty: number; notes: string[] } {
  let penalty = 0;
  const notes: string[] = [];
  const wrong = Math.min((lessons.wrong.get(have.id) ?? 0) + (lessons.wrong.get(want.id) ?? 0), 3);
  if (wrong) {
    penalty += 0.12 * wrong;
    notes.push(`marked wrong ${wrong} time${wrong === 1 ? '' : 's'} before`);
  }
  const seen = lessons.signatures.get(signature);
  if (seen && seen.bad >= SIGNATURE_MIN_WRONG) {
    const share = seen.bad / (seen.bad + seen.good);
    if (share >= 0.5) {
      penalty += 0.25 * share * Math.min(1, seen.bad / 10);
      notes.push(`this kind of pairing was marked wrong ${seen.bad} of ${seen.bad + seen.good} times`);
    }
  }
  const dealer = (want.posterPhone ? lessons.posters.get(want.posterPhone) ?? 0 : 0) + (have.posterPhone ? lessons.posters.get(have.posterPhone) ?? 0 : 0);
  if (dealer >= POSTER_MIN_WRONG) {
    penalty += 0.08 * Math.min(1, dealer / 6);
    notes.push('a dealer whose listings were often marked wrong');
  }
  return { penalty, notes };
}

function addTo(index: Map<string, MarketListing[]>, key: string, listing: MarketListing): void {
  const list = index.get(key);
  if (list) list.push(listing);
  else index.set(key, [listing]);
}

/**
 * The refusals `scorePair` would make anyway, asked without building anything: the wrong purpose, a different
 * kind of property, a different BHK, a size or price that cannot fit. On a busy area (Greenfields has thousands of
 * offers) running the whole scorer on each of them took six seconds; this takes a few hundred milliseconds.
 * It may only ever refuse what `scorePair` refuses — a test pins that the two agree.
 */
export function cannotMatch(want: MarketListing, have: MarketListing): boolean {
  if (want.purpose !== have.purpose) return true;
  const a = categoryFamily(want.category);
  const b = categoryFamily(have.category);
  if (a && b) {
    if (a !== b) return true;
    if (want.category !== have.category && ((want.category === 'Apartment' && have.category === 'Kothi/Villa') || (want.category === 'Kothi/Villa' && have.category === 'Apartment'))) return true;
  }
  if (want.bhk && have.bhk && want.bhk !== have.bhk) return true;
  if (want.sizeSqYd && have.sizeSqYd) {
    const tolerance = Math.max(15, Math.round(want.sizeSqYd * 0.1));
    if (Math.abs(want.sizeSqYd - have.sizeSqYd) > tolerance * 2) return true;
  }
  if (want.priceMaxLakh && have.priceMinLakh && have.priceMinLakh > want.priceMaxLakh * PRICE_GRACE) return true;
  return false;
}

/**
 * Pure: the best seller for each buyer's requirement. Kept apart from the loader so
 * the ranking rules are pinned by a test that needs no database.
 */
type BestPair = Pick<CrossMatch, 'want' | 'have' | 'score' | 'reasons' | 'crossGroup'>;

export function bestPerRequirement(
  listings: MarketListing[], query: CrossMatchQuery, now = new Date(), taught: Map<string, number> | Lessons = new Map(),
): BestPair[] {
  const steps = rankSteps(listings, query, now, taught);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * The same ranking, giving the server back to its other work every few dozen buyers. On production the sum takes
 * seconds, and a request that arrives during it must not wait for it to finish.
 */
export async function bestPerRequirementYielding(
  listings: MarketListing[], query: CrossMatchQuery, now = new Date(), taught: Map<string, number> | Lessons = new Map(),
): Promise<BestPair[]> {
  const steps = rankSteps(listings, query, now, taught);
  let done = 0;
  let step = steps.next();
  while (!step.done) {
    done += 1;
    if (done % 20 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    step = steps.next();
  }
  return step.value;
}

function* rankSteps(
  listings: MarketListing[], query: CrossMatchQuery, now: Date, taught: Map<string, number> | Lessons,
): Generator<void, BestPair[], void> {
  const lessons: Lessons = taught instanceof Map ? { ...NO_LESSONS, wrong: taught } : taught;
  const minScore = query.minScore ?? 0.5;
  const crossGroupOnly = query.crossGroupOnly ?? true;
  const offersByPlace = new Map<string, MarketListing[]>();
  for (const listing of listings) {
    if (listing.kind !== 'have') continue;
    for (const key of listing.placeKeys) {
      addTo(offersByPlace, `${listing.purpose}|${categoryFamily(listing.category) ?? '*'}|${key}`, listing);
      // A sector is also found from its pockets and the other way round.
      const parts = sectorParts(key);
      if (parts) addTo(offersByPlace, `${listing.purpose}|${categoryFamily(listing.category) ?? '*'}|sector ${parts.base}`, listing);
    }
  }

  const best: BestPair[] = [];
  for (const want of listings) {
    if (want.kind !== 'want') continue;
    // Offers are filed by purpose and family of property as well as place, so a buyer of a plot is never walked past a thousand flats.
    const wantFamily = categoryFamily(want.category);
    const families = wantFamily ? [wantFamily, '*'] : ['plot', 'home', 'commercial', '*'];
    const lists: MarketListing[][] = [];
    let mayRepeat = want.placeKeys.length > 1;
    for (const key of want.placeKeys) {
      const parts = sectorParts(key);
      if (parts) mayRepeat = true;
      for (const family of families) {
        const exact = offersByPlace.get(`${want.purpose}|${family}|${key}`);
        if (exact) lists.push(exact);
        const sector = parts ? offersByPlace.get(`${want.purpose}|${family}|sector ${parts.base}`) : undefined;
        if (sector) lists.push(sector);
      }
    }
    // Only a sector and its pockets, or several places, can offer the same listing twice; then, and only then, a set is worth building.
    const candidates: Iterable<MarketListing> = lists.length === 1 ? lists[0]! : mayRepeat ? new Set(lists.flat()) : lists.flat();
    let top: (typeof best)[number] | null = null;
    for (const have of candidates) {
      // The cheap, certain refusals first: most of a busy area's offers are the wrong kind, size or price.
      if (cannotMatch(want, have)) continue;
      if (samePerson(want, have)) continue;
      // A pairing somebody put away, or Jev says does not fit, is skipped here so the buyer's next best seller is found.
      if (lessons.hidden.has(`${want.id}:${have.id}`)) continue;
      const crossGroup = !sharesAGroup(want.groups, have.groups);
      if (crossGroupOnly && !crossGroup) continue;
      const pairing = scorePair(want, have, now);
      if (!pairing) continue;
      const lesson = lessonPenalty(pairing.signature, want, have, lessons);
      if (lesson.penalty) {
        pairing.score = Math.round(Math.max(pairing.score - lesson.penalty, 0) * 100) / 100;
        pairing.reasons.push(...lesson.notes);
      }
      if (pairing.score < minScore) continue;
      if (!top || pairing.score > top.score) top = { want, have, crossGroup, ...pairing };
    }
    if (top) best.push(top);
    yield;
  }
  return withoutRepeats(best.sort((a, b) => b.score - a.score));
}

/** The same words from the same person, lower-cased and stripped, so a repost reads as the same thing. */
function sameWords(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

/**
 * A dealer who posts the same requirement twice, or a seller whose ad is reposted, is one
 * introduction, not two. Best first, so the strongest copy is the one that stays.
 */
function withoutRepeats<T extends { want: MarketListing; have: MarketListing }>(ranked: T[]): T[] {
  const seen = new Set<string>();
  return ranked.filter(({ want, have }) => {
    const side = (l: MarketListing): string => `${l.posterPhone ?? l.posterName ?? ''}|${sameWords(l.summary)}`;
    const key = `${side(want)}>${side(have)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const LISTING_COLUMNS = `l.id, l.post_id, l.kind, l.purpose, l.category, l.bhk, l.size_sqyd, l.price_min_lakh, l.price_max_lakh,
  l.place_keys, l.project, l.summary, p.poster_name, p.poster_phone, p.phones, p.groups,
  coalesce(p.last_posted_at, p.created_at) AS posted_at`;

export async function loadListings(days: number): Promise<MarketListing[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${LISTING_COLUMNS}
       FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id
      WHERE NOT p.is_noise AND l.place_keys <> '{}'
        AND coalesce(p.last_posted_at, p.created_at) > now() - make_interval(days => $1::int)
        -- A date after today is a date somebody misread, never a fresh deal.
        AND coalesce(p.last_posted_at, p.created_at) <= now() + interval '1 day'`,
    [days],
  );
  return rows.rows.map(rowToListing);
}

// ---------------------------------------------------------------------------
// The sheet: worked out once, served many times
// ---------------------------------------------------------------------------

/**
 * Working out every pairing in the feed takes seconds, and the screen asks again for every page,
 * filter and click. So the worked-out sheet is kept: for ten minutes, or until something changes it
 * (a drop, an outcome, Jev's verdict), and when it is stale it is **served as it is while a fresh one
 * is built behind it** — nobody waits for the sum, they wait for the network.
 * Statuses are written into the kept sheet at once, so a click shows immediately.
 */
const SHEET_TTL_MS = 10 * 60_000;
const MAX_SHEETS = 12;
interface Sheet { version: number; at: number; ranked: CrossMatch[] }
const sheets = new Map<string, Sheet>();
const building = new Map<string, Promise<Sheet>>();
let version = 0;

/** Something the sheet is made from has changed: the next look rebuilds it (the old one is shown meanwhile). */
export function invalidateMarketMatches(): void {
  version += 1;
}

/**
 * Only what changes WHICH pairings exist. Type, size, area, BHK, purpose, status, sorting and paging are all applied to the kept
 * sheet: narrowing it is a filter over a few hundred pairings, not another pass over thirteen thousand listings.
 */
function sheetKey(query: CrossMatchQuery): string {
  const { minScore, crossGroupOnly, onlyVerified, minJevFit, days } = query;
  return JSON.stringify([days ?? MAX_DEAL_AGE_DAYS, minScore ?? 0.5, crossGroupOnly ?? true, onlyVerified ?? false, minJevFit ?? null]);
}

const pairKey = (wantId: string, haveId: string): string => `${wantId}:${haveId}`;

/** What people have decided and what Jev has said, as the matcher's lessons. */
export async function loadLessons(now = new Date()): Promise<Lessons> {
  const [deals, checks] = await Promise.all([
    db.query<{ want_listing_id: string; have_listing_id: string; status: string }>(
      `SELECT want_listing_id, have_listing_id, status FROM ipy_market_deal WHERE want_listing_id IS NOT NULL AND have_listing_id IS NOT NULL AND status <> 'new'`),
    db.query<{ want_listing_id: string; have_listing_id: string }>(
      `SELECT want_listing_id, have_listing_id FROM ipy_market_pair_check WHERE fit < $1`, [JEV_FIT_FLOOR]),
  ]);
  const lessons: Lessons = { wrong: new Map(), hidden: new Set(), signatures: new Map(), posters: new Map() };
  for (const row of checks.rows) lessons.hidden.add(pairKey(row.want_listing_id, row.have_listing_id));
  const judged = deals.rows.filter((row) => ['bad_match', 'dismissed', 'called', 'meeting', 'won'].includes(row.status));
  for (const row of judged) if (row.status === 'bad_match' || row.status === 'dismissed') lessons.hidden.add(pairKey(row.want_listing_id, row.have_listing_id));
  const wrongPairs = judged.filter((row) => row.status === 'bad_match');
  for (const row of wrongPairs) {
    for (const id of [row.want_listing_id, row.have_listing_id]) lessons.wrong.set(id, (lessons.wrong.get(id) ?? 0) + 1);
  }
  // The kind of pairing each decision was about: found by scoring the two listings again.
  const ids = [...new Set(judged.filter((row) => row.status !== 'dismissed').flatMap((row) => [row.want_listing_id, row.have_listing_id]))];
  if (ids.length) {
    const rows = await db.query<Record<string, unknown>>(
      `SELECT ${LISTING_COLUMNS} FROM ipy_market_listing l JOIN ipy_market_post p ON p.id = l.post_id WHERE l.id = ANY($1::uuid[])`, [ids]);
    const byId = new Map(rows.rows.map((row) => [row.id as string, rowToListing(row)]));
    for (const row of judged) {
      if (row.status === 'dismissed') continue;
      const want = byId.get(row.want_listing_id);
      const have = byId.get(row.have_listing_id);
      const pairing = want && have ? scorePair(want, have, now) : null;
      if (!pairing || !want || !have) continue;
      const seen = lessons.signatures.get(pairing.signature) ?? { bad: 0, good: 0 };
      if (row.status === 'bad_match') {
        seen.bad += 1;
        for (const phone of new Set([want.posterPhone, have.posterPhone])) if (phone) lessons.posters.set(phone, (lessons.posters.get(phone) ?? 0) + 1);
      } else {
        seen.good += 1;
      }
      lessons.signatures.set(pairing.signature, seen);
    }
  }
  return lessons;
}

/**
 * Every filter the screen offers is a different sheet but the same listings. Loading them is most of what a
 * new filter costs after the pairing is fast, so they are loaded once and shared until something changes.
 * Nobody mutates a listing, so sharing the objects is safe.
 */
let loaded: { version: number; at: number; days: number; rows: Promise<MarketListing[]> } | null = null;
function sharedListings(days: number): Promise<MarketListing[]> {
  if (loaded && loaded.version === version && loaded.days === days && Date.now() - loaded.at < SHEET_TTL_MS) return loaded.rows;
  const rows = loadListings(days);
  loaded = { version, at: Date.now(), days, rows };
  rows.catch(() => { if (loaded?.rows === rows) loaded = null; });
  return rows;
}

async function buildSheet(query: CrossMatchQuery, fresh: boolean): Promise<Sheet> {
  const days = Math.min(Math.max(query.days ?? MAX_DEAL_AGE_DAYS, 1), MAX_DEAL_AGE_DAYS);
  const built = version;
  const t0 = Date.now();
  const timed = async <T>(name: string, work: Promise<T>): Promise<T> => { const out = await work; spent[name] = Date.now() - t0; return out; };
  const spent: Record<string, number> = {};
  const [loaded, lessons, worked, checks] = await Promise.all([
    timed('listings', fresh ? loadListings(days) : sharedListings(days)),
    timed('lessons', loadLessons()),
    timed('deals', db.query<{ want_listing_id: string; have_listing_id: string; status: CrossMatch['status']; note: string | null }>(
      `SELECT want_listing_id, have_listing_id, status, note FROM ipy_market_deal WHERE want_listing_id IS NOT NULL`)),
    timed('checks', db.query<{ want_listing_id: string; have_listing_id: string; fit: string }>(`SELECT want_listing_id, have_listing_id, fit FROM ipy_market_pair_check`)),
  ]);
  const loadedAt = Date.now() - t0;
  const ranked = await bestPerRequirementYielding(loaded, query, new Date(), lessons);
  logger.info({ listings: loaded.length, loadedMs: loadedAt, queriesMs: spent, rankMs: Date.now() - t0 - loadedAt }, 'market: call sheet built');
  const outcome = new Map(worked.rows.map((row) => [pairKey(row.want_listing_id, row.have_listing_id), row]));
  const fit = new Map(checks.rows.map((row) => [pairKey(row.want_listing_id, row.have_listing_id), Number(row.fit)]));

  const matches: CrossMatch[] = [];
  for (const pairing of ranked) {
    const id = pairKey(pairing.want.id, pairing.have.id);
    const done = outcome.get(id);
    const status = done?.status ?? 'new';
    // Put away for good: "not a real match" teaches the matcher, "not for us" is the team's own no. Neither comes back.
    if (status === 'bad_match' || status === 'dismissed') continue;
    const jevFit = fit.get(id) ?? null;
    if (jevFit !== null && jevFit < JEV_FIT_FLOOR) continue;
    if ((query.onlyVerified || query.minJevFit !== undefined) && jevFit === null) continue;
    if (query.minJevFit !== undefined && jevFit! < query.minJevFit) continue;
    matches.push({ ...pairing, id, status, note: done?.note ?? null, jevFit });
  }
  return { version: built, at: Date.now(), ranked: matches };
}

/** The kept sheet, however old; a rebuild is started behind it when it is stale. Waits only when there is nothing kept. */
async function sheetFor(query: CrossMatchQuery, fresh = false): Promise<CrossMatch[]> {
  const key = sheetKey(query);
  const refresh = (): Promise<Sheet> => {
    const running = building.get(key);
    if (running) return running;
    const started = buildSheet(query, fresh)
      .then((sheet) => {
        sheets.delete(key);
        sheets.set(key, sheet);
        while (sheets.size > MAX_SHEETS) sheets.delete(sheets.keys().next().value as string);
        return sheet;
      })
      .finally(() => building.delete(key));
    building.set(key, started);
    return started;
  };
  const kept = sheets.get(key);
  // The screen takes what is kept; the background jobs, which decide what to ask Jev and what to alert, never act on a stale sheet.
  if (!kept || fresh) return (await refresh()).ranked;
  if (kept.version !== version || Date.now() - kept.at > SHEET_TTL_MS) refresh().catch((err) => logger.warn({ err }, 'market: rebuilding the call sheet failed'));
  return kept.ranked;
}

/** Write an outcome into every kept sheet at once, so the screen answers the click without a rebuild. */
function noteOutcome(wantId: string, haveId: string, status: CrossMatch['status'], note: string | null): void {
  const id = pairKey(wantId, haveId);
  for (const sheet of sheets.values()) {
    const at = sheet.ranked.findIndex((match) => match.id === id);
    if (at === -1) continue;
    if (status === 'bad_match' || status === 'dismissed') sheet.ranked.splice(at, 1);
    else sheet.ranked[at] = { ...sheet.ranked[at]!, status, note };
  }
}

export interface MatchPage { total: number; matches: CrossMatch[] }

/** One page of the sheet, in the order asked, with the whole messages for the pairings on it and nothing else. */
export async function findCrossMatchPage(query: CrossMatchQuery, page = 1, pageSize = 25, fresh = false): Promise<MatchPage> {
  // A pairing is on screen when both its sides fit what was asked for.
  let all = (await sheetFor(query, fresh)).filter((match) => listingPasses(match.want, query) && listingPasses(match.have, query));
  if (query.includeWorked === false) all = all.filter((match) => match.status !== 'won' && match.status !== 'lost');
  if (query.status) all = all.filter((match) => match.status === query.status);
  const ordered = sortMatches(all, query.sort);
  const size = Math.min(Math.max(pageSize, 1), 100);
  const from = (Math.max(page, 1) - 1) * size;
  const shown = ordered.slice(from, from + size).map((match) => ({ ...match }));

  const postIds = [...new Set(shown.flatMap((m) => [m.want.postId, m.have.postId]))];
  if (postIds.length) {
    const bodies = await db.query<{ id: string; body: string }>(`SELECT id, body FROM ipy_market_post WHERE id = ANY($1::uuid[])`, [postIds]);
    const byId = new Map(bodies.rows.map((row) => [row.id, tidyBody(row.body)]));
    for (const match of shown) {
      match.want = { ...match.want, body: byId.get(match.want.postId) ?? '' };
      match.have = { ...match.have, body: byId.get(match.have.postId) ?? '' };
    }
  }
  return { total: ordered.length, matches: shown };
}

/** The first `limit` of a freshly worked-out sheet, for the background jobs that verify pairings and write the alert. */
export async function findCrossMatches(query: CrossMatchQuery = {}, fresh = true): Promise<CrossMatch[]> {
  return (await findCrossMatchPage(query, 1, Math.min(Math.max(query.limit ?? 100, 1), 500), fresh)).matches;
}

export const DEAL_STATUSES = ['new', 'called', 'meeting', 'won', 'lost', 'dismissed', 'bad_match'] as const;

export async function recordOutcome(
  wantListingId: string, haveListingId: string, status: (typeof DEAL_STATUSES)[number], note: string | null, userId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO ipy_market_deal (want_listing_id, have_listing_id, want_post_id, have_post_id, status, note, updated_by)
     SELECT $1, $2, w.post_id, h.post_id, $3, $4, $5
       FROM ipy_market_listing w, ipy_market_listing h WHERE w.id = $1 AND h.id = $2
     ON CONFLICT (want_listing_id, have_listing_id) WHERE want_listing_id IS NOT NULL
     DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [wantListingId, haveListingId, status, note, userId],
  );
  noteOutcome(wantListingId, haveListingId, status, note);
  // The rest of the system learns from it: the matcher's lessons are rebuilt behind the kept sheet.
  invalidateMarketMatches();
}
