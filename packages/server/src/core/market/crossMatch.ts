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
export function areaScore(wanted: string[], offered: string[]): { score: number; why: string } | null {
  let best: { score: number; why: string } | null = null;
  const take = (score: number, why: string): void => { if (!best || score > best.score) best = { score, why }; };
  for (const a of wanted) {
    for (const b of offered) {
      if (a === b) {
        // A named sector or block is exact; a colony the business lists is nearly so; a developer or a wide area is weak.
        const strength = BROAD_AREAS.has(a) ? 0.2 : a.includes(':') ? 0.4 : sectorParts(a) ? 0.45 : isProjectKey(a) ? 0.25 : 0.42;
        take(strength, `same area: ${label(a)}`);
        continue;
      }
      const x = sectorParts(a);
      const y = sectorParts(b);
      if (x && y && x.base === y.base) {
        // "Sector 21" and "Sector 21C": the buyer did not narrow it, so any pocket will do.
        take(x.pocket === '' || y.pocket === '' ? 0.4 : 0.15, `same sector: ${label(a)} / ${label(b)}`);
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

  const area = areaScore(want.placeKeys, have.placeKeys);
  if (!area) return null;
  let score = area.score;
  reasons.push(area.why);

  const type = typeFit(want, have);
  if (!type.ok) return null;
  score += type.bonus;
  if (type.why) reasons.push(type.why);

  if (want.bhk && have.bhk && want.bhk !== have.bhk) return null;
  let agreed = 0;
  if (want.bhk && have.bhk) { score += 0.1; agreed += 1; reasons.push(`${have.bhk} BHK`); }

  if (want.sizeSqYd && have.sizeSqYd) {
    // Plots come in 100, 150, 200, 250, 300 and each is a different purchase: 250 will look at 225–275,
    // and 300 is only a stretch. The first live read called 250 against 303 a perfect fit.
    const tolerance = Math.max(15, Math.round(want.sizeSqYd * 0.1));
    const gap = Math.abs(want.sizeSqYd - have.sizeSqYd);
    if (gap <= tolerance) {
      score += 0.25;
      agreed += 1;
      reasons.push(`size fits: wants ${want.sizeSqYd} yd, has ${have.sizeSqYd} yd`);
    } else if (gap <= tolerance * 2) {
      score += 0.03;
      reasons.push(`size is off: wants ${want.sizeSqYd} yd, has ${have.sizeSqYd} yd`);
    } else {
      return null;
    }
  }

  if (want.priceMaxLakh && have.priceMinLakh) {
    if (have.priceMinLakh > want.priceMaxLakh * PRICE_GRACE) return null;
    score += 0.1;
    agreed += 1;
    reasons.push('within budget');
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
  return { score: Math.round(Math.min(Math.max(score, 0), 1) * 100) / 100, reasons };
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
 * Pure: the best seller for each buyer's requirement. Kept apart from the loader so
 * the ranking rules are pinned by a test that needs no database.
 */
export function bestPerRequirement(
  listings: MarketListing[], query: CrossMatchQuery, now = new Date(), wrongBefore: Map<string, number> = new Map(),
): Array<Pick<CrossMatch, 'want' | 'have' | 'score' | 'reasons' | 'crossGroup'>> {
  const minScore = query.minScore ?? 0.5;
  const crossGroupOnly = query.crossGroupOnly ?? true;
  const offersByPlace = new Map<string, MarketListing[]>();
  for (const listing of listings) {
    if (listing.kind !== 'have') continue;
    for (const key of listing.placeKeys) {
      offersByPlace.set(key, [...(offersByPlace.get(key) ?? []), listing]);
      // A sector is also found from its pockets and the other way round.
      const parts = sectorParts(key);
      if (parts) offersByPlace.set(`sector ${parts.base}`, [...(offersByPlace.get(`sector ${parts.base}`) ?? []), listing]);
    }
  }

  const best: Array<Pick<CrossMatch, 'want' | 'have' | 'score' | 'reasons' | 'crossGroup'>> = [];
  for (const want of listings) {
    if (want.kind !== 'want') continue;
    const candidates = new Set(want.placeKeys.flatMap((key) => {
      const parts = sectorParts(key);
      return [...(offersByPlace.get(key) ?? []), ...(parts ? offersByPlace.get(`sector ${parts.base}`) ?? [] : [])];
    }));
    let top: (typeof best)[number] | null = null;
    for (const have of candidates) {
      if (samePerson(want, have)) continue;
      const crossGroup = !sharesAGroup(want.groups, have.groups);
      if (crossGroupOnly && !crossGroup) continue;
      const pairing = scorePair(want, have, now);
      if (!pairing) continue;
      // What people have said was wrong before counts against it: a listing marked "not a real match" for
      // two buyers is vague or mistaken, and it should have to be an excellent fit to be offered a third.
      const wrong = Math.min((wrongBefore.get(have.id) ?? 0) + (wrongBefore.get(want.id) ?? 0), 3);
      if (wrong) {
        pairing.score = Math.round(Math.max(pairing.score - 0.12 * wrong, 0) * 100) / 100;
        pairing.reasons.push(`marked wrong ${wrong} time${wrong === 1 ? '' : 's'} before`);
      }
      if (pairing.score < minScore) continue;
      if (!top || pairing.score > top.score) top = { want, have, crossGroup, ...pairing };
    }
    if (top) best.push(top);
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

export async function findCrossMatches(query: CrossMatchQuery = {}): Promise<CrossMatch[]> {
  const days = Math.min(Math.max(query.days ?? MAX_DEAL_AGE_DAYS, 1), MAX_DEAL_AGE_DAYS);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const learned = await db.query<{ listing: string; n: number }>(
    `SELECT l AS listing, count(*)::int AS n FROM (
       SELECT have_listing_id AS l FROM ipy_market_deal WHERE status = 'bad_match' AND have_listing_id IS NOT NULL
       UNION ALL SELECT want_listing_id FROM ipy_market_deal WHERE status = 'bad_match' AND want_listing_id IS NOT NULL
     ) wrong GROUP BY l`,
  );
  const listings = (await loadListings(days)).filter((listing) => listingPasses(listing, query));
  const ranked = bestPerRequirement(listings, query, new Date(), new Map(learned.rows.map((row) => [row.listing, row.n])));

  const worked = await db.query<{ want_listing_id: string; have_listing_id: string; status: CrossMatch['status']; note: string | null }>(
    `SELECT want_listing_id, have_listing_id, status, note FROM ipy_market_deal WHERE want_listing_id IS NOT NULL`,
  );
  const outcome = new Map(worked.rows.map((row) => [`${row.want_listing_id}:${row.have_listing_id}`, row]));
  const checks = await db.query<{ want_listing_id: string; have_listing_id: string; fit: string }>(
    `SELECT want_listing_id, have_listing_id, fit FROM ipy_market_pair_check`,
  );
  const fit = new Map(checks.rows.map((row) => [`${row.want_listing_id}:${row.have_listing_id}`, Number(row.fit)]));

  const matches: CrossMatch[] = [];
  for (const pairing of ranked) {
    const id = `${pairing.want.id}:${pairing.have.id}`;
    const done = outcome.get(id);
    const status = done?.status ?? 'new';
    // "Not a real match" is never shown again; the others come back only when finished work is asked for.
    if (status === 'bad_match') continue;
    if (!query.includeWorked && (status === 'won' || status === 'lost' || status === 'dismissed')) continue;
    const jevFit = fit.get(id) ?? null;
    if (jevFit !== null && jevFit < JEV_FIT_FLOOR) continue;
    if ((query.onlyVerified || query.minJevFit !== undefined) && jevFit === null) continue;
    if (query.minJevFit !== undefined && jevFit! < query.minJevFit) continue;
    matches.push({ ...pairing, id, status, note: done?.note ?? null, jevFit });
  }
  // Order first, then cut: the limit must keep the best of all of them, not the first hundred found.
  const shown = sortMatches(matches, query.sort).slice(0, limit);
  matches.length = 0;
  matches.push(...shown);

  // The whole messages, for the pairings that are being shown and nothing else.
  const postIds = [...new Set(matches.flatMap((m) => [m.want.postId, m.have.postId]))];
  if (postIds.length) {
    const bodies = await db.query<{ id: string; body: string }>(`SELECT id, body FROM ipy_market_post WHERE id = ANY($1::uuid[])`, [postIds]);
    const byId = new Map(bodies.rows.map((row) => [row.id, tidyBody(row.body)]));
    for (const match of matches) {
      match.want = { ...match.want, body: byId.get(match.want.postId) ?? '' };
      match.have = { ...match.have, body: byId.get(match.have.postId) ?? '' };
    }
  }
  return matches;
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
}
