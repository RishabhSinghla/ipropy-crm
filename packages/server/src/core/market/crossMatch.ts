/**
 * A buyer in one dealer group and a seller in another cannot find each other.
 * This finds them: every "want" post in the feed against every "have" post,
 * scored on the few facts a group post carries.
 *
 * It never contacts anyone and stores nothing but what a person did about a
 * pairing (`ipy_market_deal`). Pairings are worked out fresh each time, so a
 * better rule tomorrow improves the whole feed without a rebuild.
 *
 * Ported from the standalone tool this replaces, with its weights kept: the
 * area is the strongest signal in this market (a plot in the wrong sector is
 * worthless), size next, price a soft filter.
 */
import { db } from '../../db/pool.js';
import { categoryFamily } from './readPost.js';

export interface MarketDeal {
  id: string;
  kind: 'have' | 'want';
  purpose: 'sale' | 'rent';
  placeKeys: string[];
  category: string | null;
  bhk: number | null;
  sizeSqYd: number | null;
  priceMinLakh: number | null;
  priceMaxLakh: number | null;
  posterName: string | null;
  posterPhone: string | null;
  groups: string[];
  postedAt: Date | null;
  body: string;
}

export interface Pairing {
  score: number;
  reasons: string[];
}

/** A seller quoting a little over what the buyer named will usually come down. */
const PRICE_GRACE = 1.15;
const DAY_MS = 86_400_000;

/** Null means the two cannot be a deal at all; otherwise how good a one, and why. */
export function scorePair(want: MarketDeal, have: MarketDeal, now = new Date()): Pairing | null {
  // Somebody buying is not introduced to a landlord, and a tenant is not introduced to a seller.
  if (want.purpose !== have.purpose) return null;
  let score = 0;
  const reasons: string[] = [];

  const shared = want.placeKeys.filter((key) => have.placeKeys.includes(key));
  if (shared.length === 0) return null;
  score += 0.45;
  reasons.push(`same area: ${shared.slice(0, 3).join(', ')}`);

  const wantFamily = categoryFamily(want.category);
  const haveFamily = categoryFamily(have.category);
  if (wantFamily && haveFamily) {
    if (wantFamily !== haveFamily) return null;
    score += 0.2;
    reasons.push(`same type: ${have.category}`);
  }

  if (want.bhk && have.bhk && want.bhk !== have.bhk) return null;

  if (want.sizeSqYd && have.sizeSqYd) {
    // A buyer asking 250 will look at 200–300.
    const tolerance = Math.max(30, Math.round(want.sizeSqYd * 0.25));
    if (Math.abs(want.sizeSqYd - have.sizeSqYd) <= tolerance) {
      score += 0.25;
      reasons.push(`size fits: wants ${want.sizeSqYd} yd, has ${have.sizeSqYd} yd`);
    } else {
      score += 0.05;
      reasons.push('size differs');
    }
  } else {
    score += 0.05;
  }

  if (want.priceMaxLakh && have.priceMinLakh) {
    if (have.priceMinLakh > want.priceMaxLakh * PRICE_GRACE) return null;
    score += 0.1;
    reasons.push('within budget');
  }

  // A number on the buyer's side is what makes it something to act on today.
  if (want.posterPhone) score += 0.05;

  const newest = Math.max(want.postedAt?.getTime() ?? 0, have.postedAt?.getTime() ?? 0);
  const oldest = Math.min(want.postedAt?.getTime() ?? Infinity, have.postedAt?.getTime() ?? Infinity);
  if (newest && Number.isFinite(oldest)) {
    const ageDays = (now.getTime() - oldest) / DAY_MS;
    if (ageDays <= 90) {
      score += 0.1;
      reasons.push('recent (within 90 days)');
    } else if (ageDays <= 200) {
      score += 0.03;
    } else {
      score -= 0.05;
      reasons.push('older postings');
    }
  }

  return { score: Math.round(Math.min(score, 1) * 100) / 100, reasons };
}

export interface CrossMatch {
  want: MarketDeal;
  have: MarketDeal;
  score: number;
  reasons: string[];
  /** True when the two were posted in groups with nobody in common — the pairs only we can see. */
  crossGroup: boolean;
  status: 'new' | 'called' | 'meeting' | 'won' | 'lost' | 'dismissed';
  note: string | null;
}

export interface CrossMatchQuery {
  days?: number;
  minScore?: number;
  /** Default true: two dealers in the same group can already see each other's posts. */
  crossGroupOnly?: boolean;
  /** Pairings already won, lost or dismissed are left off unless asked for. */
  includeWorked?: boolean;
  limit?: number;
}

function sharesAGroup(a: string[], b: string[]): boolean {
  return a.some((group) => b.includes(group));
}

function samePerson(want: MarketDeal, have: MarketDeal): boolean {
  if (want.posterPhone && have.posterPhone) return want.posterPhone === have.posterPhone;
  return !!want.posterName && want.posterName === have.posterName;
}

function rowToDeal(row: Record<string, unknown>): MarketDeal {
  return {
    id: row.id as string,
    kind: row.kind as 'have' | 'want',
    purpose: (row.purpose as 'sale' | 'rent' | null) ?? 'sale',
    placeKeys: row.place_keys as string[],
    category: row.category as string | null,
    bhk: row.bhk as number | null,
    sizeSqYd: row.size_sqyd as number | null,
    priceMinLakh: row.price_min_lakh as number | null,
    priceMaxLakh: row.price_max_lakh as number | null,
    posterName: row.poster_name as string | null,
    posterPhone: row.poster_phone as string | null,
    groups: row.groups as string[],
    postedAt: row.posted_at ? new Date(row.posted_at as string) : null,
    body: row.body as string,
  };
}

/**
 * Pure: the best seller for each buyer. Kept apart from the loader so the
 * ranking rules are pinned by a test that needs no database.
 */
export function bestPerBuyer(deals: MarketDeal[], query: CrossMatchQuery, now = new Date()): Array<Omit<CrossMatch, 'status' | 'note'>> {
  const minScore = query.minScore ?? 0.5;
  const crossGroupOnly = query.crossGroupOnly ?? true;
  const sellersByPlace = new Map<string, MarketDeal[]>();
  for (const deal of deals) {
    if (deal.kind !== 'have') continue;
    for (const key of deal.placeKeys) sellersByPlace.set(key, [...(sellersByPlace.get(key) ?? []), deal]);
  }

  const best: Array<Omit<CrossMatch, 'status' | 'note'>> = [];
  for (const want of deals) {
    if (want.kind !== 'want') continue;
    const candidates = new Set(want.placeKeys.flatMap((key) => sellersByPlace.get(key) ?? []));
    let top: Omit<CrossMatch, 'status' | 'note'> | null = null;
    for (const have of candidates) {
      if (samePerson(want, have)) continue;
      const crossGroup = !sharesAGroup(want.groups, have.groups);
      if (crossGroupOnly && !crossGroup) continue;
      const pairing = scorePair(want, have, now);
      if (!pairing || pairing.score < minScore) continue;
      if (!top || pairing.score > top.score) top = { want, have, crossGroup, ...pairing };
    }
    if (top) best.push(top);
  }
  return best.sort((a, b) => b.score - a.score);
}

export async function findCrossMatches(query: CrossMatchQuery = {}): Promise<CrossMatch[]> {
  const days = Math.min(Math.max(query.days ?? 90, 1), 365);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const posts = await db.query<Record<string, unknown>>(
    `SELECT id, kind, purpose, place_keys, category, bhk, size_sqyd, price_min_lakh, price_max_lakh,
            poster_name, poster_phone, groups, coalesce(last_posted_at, created_at) AS posted_at, body
       FROM ipy_market_post
      WHERE NOT is_noise AND kind IN ('have', 'want') AND place_keys <> '{}'
        AND coalesce(last_posted_at, created_at) > now() - make_interval(days => $1::int)`,
    [days],
  );
  const ranked = bestPerBuyer(posts.rows.map(rowToDeal), query);

  const worked = await db.query<{ want_post_id: string; have_post_id: string; status: CrossMatch['status']; note: string | null }>(
    `SELECT want_post_id, have_post_id, status, note FROM ipy_market_deal`,
  );
  const outcome = new Map(worked.rows.map((row) => [`${row.want_post_id}:${row.have_post_id}`, row]));

  const matches: CrossMatch[] = [];
  for (const pairing of ranked) {
    const done = outcome.get(`${pairing.want.id}:${pairing.have.id}`);
    const status = done?.status ?? 'new';
    if (!query.includeWorked && (status === 'won' || status === 'lost' || status === 'dismissed')) continue;
    matches.push({ ...pairing, status, note: done?.note ?? null });
    if (matches.length >= limit) break;
  }
  return matches;
}

export const DEAL_STATUSES = ['new', 'called', 'meeting', 'won', 'lost', 'dismissed'] as const;

export async function recordOutcome(
  wantPostId: string, havePostId: string, status: (typeof DEAL_STATUSES)[number], note: string | null, userId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO ipy_market_deal (want_post_id, have_post_id, status, note, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (want_post_id, have_post_id)
     DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [wantPostId, havePostId, status, note, userId],
  );
}
