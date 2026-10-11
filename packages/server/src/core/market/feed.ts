/**
 * The market feed: storing and searching deals from dealer WhatsApp groups.
 *
 * The reading itself is `readPost.ts`, pure and tested. This file is the two
 * things that touch the database: putting a group's export in, once per deal,
 * and asking it questions — the same question a rep types into chat.ipropy.com.
 */
import { db } from '../../db/pool.js';
import { notify } from '../notifications/index.js';
import { logger } from '../../utils/logger.js';
import { fingerprintOf, looksLikeADeal, parseWhatsAppExport, readPost } from './readPost.js';
import { matchDeal, type DealMatch } from './matchDeal.js';

/** The business's own locality names, from the `locality` dropdown an admin edits. */
export async function knownLocalities(): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT DISTINCT coalesce(nullif(v.label, ''), v.value) AS name
       FROM ipy_picklist p JOIN ipy_picklist_value v ON v.picklist_id = p.id
      WHERE p.name = 'locality' AND v.is_active`,
  );
  return rows.rows.map((row) => row.name).filter(Boolean);
}

export interface ImportOutcome {
  messages: number;
  deals: number;
  newDeals: number;
  repeats: number;
  /** People told that a fresh deal fits one of their records. */
  alerted: number;
}

/**
 * Only a fresh deal is worth an alert. The first upload of a group is often a
 * year of history, and ringing the team about a flat posted in March is how
 * they learn to switch alerts off — older deals are matched when somebody asks.
 */
const ALERT_WITHIN_DAYS = 7;

/**
 * Put one group's export into the feed.
 *
 * A deal already held — forwarded into another group, or the same export
 * uploaded twice — is not stored again: its group is added and it is marked
 * seen once more, which is what "posted in 6 groups" on the screen reads.
 */
export async function importGroupExport(groupName: string, text: string, userId: string): Promise<ImportOutcome> {
  const localities = await knownLocalities();
  const messages = parseWhatsAppExport(text);
  const outcome: ImportOutcome = { messages: messages.length, deals: 0, newDeals: 0, repeats: 0, alerted: 0 };
  const fresh: string[] = [];

  for (const message of messages) {
    const reading = readPost(message.body, localities);
    if (!looksLikeADeal(message.body, reading)) continue;
    outcome.deals += 1;

    const posted = message.postedAt?.toISOString() ?? null;
    const result = await db.queryOne<{ id: string; inserted: boolean }>(
      `INSERT INTO ipy_market_post
         (fingerprint, body, kind, bhk, price_min_lakh, price_max_lakh, localities,
          poster_name, poster_phone, groups, first_posted_at, last_posted_at, imported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10::text], $11::timestamptz, $11::timestamptz, $12)
       ON CONFLICT (fingerprint) DO UPDATE SET
         groups = CASE WHEN $10::text = ANY(ipy_market_post.groups) THEN ipy_market_post.groups
                       ELSE ipy_market_post.groups || $10::text END,
         seen_count = ipy_market_post.seen_count + 1,
         last_posted_at = GREATEST(ipy_market_post.last_posted_at, EXCLUDED.last_posted_at)
       RETURNING id, (xmax = 0) AS inserted`,
      [
        fingerprintOf(message.body), message.body, reading.kind, reading.bhk,
        reading.priceMinLakh, reading.priceMaxLakh, reading.localities,
        message.sender, reading.phone, groupName, posted, userId,
      ],
    );
    if (result?.inserted) {
      outcome.newDeals += 1;
      const ageDays = message.postedAt ? (Date.now() - message.postedAt.getTime()) / 86_400_000 : Infinity;
      if (ageDays <= ALERT_WITHIN_DAYS) fresh.push(result.id);
    } else {
      outcome.repeats += 1;
    }
  }

  outcome.alerted = await alertOwners(groupName, fresh);
  return outcome;
}

/**
 * Tell each owner, once per deal, which of their own records it fits. One
 * notification per person per deal rather than per record, so a deal that fits
 * five of somebody's contacts is one line in their bell, not five.
 */
async function alertOwners(groupName: string, postIds: string[]): Promise<number> {
  const told = new Set<string>();
  for (const postId of postIds) {
    let matches: DealMatch[] = [];
    try {
      matches = await matchDeal(postId);
    } catch (err) {
      // A deal that cannot be matched is still in the feed; the upload must not fail over it.
      logger.warn({ err, postId }, 'market: matching a deal failed');
      continue;
    }
    const byOwner = new Map<string, DealMatch[]>();
    for (const match of matches) {
      if (!match.ownerId) continue;
      byOwner.set(match.ownerId, [...(byOwner.get(match.ownerId) ?? []), match]);
    }
    const post = await db.queryOne<{ kind: string; poster_name: string | null }>(
      `SELECT kind, poster_name FROM ipy_market_post WHERE id = $1`, [postId],
    );
    for (const [ownerId, theirs] of byOwner) {
      const names = theirs.slice(0, 3).map((m) => m.label).join(', ') + (theirs.length > 3 ? ` and ${theirs.length - 3} more` : '');
      await notify({
        userId: ownerId,
        kind: 'market_match',
        title: post?.kind === 'have'
          ? `A dealer has a property for ${theirs.length === 1 ? 'your contact' : `${theirs.length} of your contacts`}`
          : `A dealer's buyer fits ${theirs.length === 1 ? 'your unit' : `${theirs.length} of your units`}`,
        body: `${post?.poster_name ?? 'Someone'} in ${groupName} — fits ${names}`,
        link: `/market?deal=${postId}`,
        recordId: theirs.length === 1 ? theirs[0]!.recordId : undefined,
      });
      told.add(ownerId);
    }
  }
  return told.size;
}

export interface MarketQuery {
  kind?: 'have' | 'want';
  bhk?: number;
  /** A deal is offered if any part of its price falls inside this range. */
  minLakh?: number;
  maxLakh?: number;
  /** Matches a recognised locality or anywhere in the post's own words. */
  locality?: string;
  text?: string;
  /** Deals older than this fade from answers; dealers re-post what is still live. */
  days?: number;
  limit?: number;
}

export interface MarketPost {
  id: string;
  body: string;
  kind: 'have' | 'want' | 'unknown';
  bhk: number | null;
  priceMinLakh: number | null;
  priceMaxLakh: number | null;
  localities: string[];
  posterName: string | null;
  posterPhone: string | null;
  groups: string[];
  lastPostedAt: string | null;
  seenCount: number;
}

export async function searchMarket(query: MarketQuery): Promise<{ total: number; posts: MarketPost[] }> {
  const where: string[] = [`coalesce(last_posted_at, created_at) > now() - make_interval(days => $1::int)`];
  const params: unknown[] = [Math.min(Math.max(query.days ?? 30, 1), 365)];
  const add = (value: unknown): string => { params.push(value); return `$${params.length}`; };

  if (query.kind) where.push(`kind = ${add(query.kind)}`);
  if (query.bhk) where.push(`bhk = ${add(query.bhk)}::int`);
  if (query.maxLakh) where.push(`(price_min_lakh IS NULL OR price_min_lakh <= ${add(query.maxLakh)}::numeric)`);
  if (query.minLakh) where.push(`(price_max_lakh IS NULL OR price_max_lakh >= ${add(query.minLakh)}::numeric)`);
  if (query.locality) {
    const like = add(`%${query.locality.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(EXISTS (SELECT 1 FROM unnest(localities) l WHERE l ILIKE ${like}) OR body ILIKE ${like})`);
  }
  if (query.text) where.push(`body ILIKE ${add(`%${query.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);

  const clause = where.join(' AND ');
  const total = await db.queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM ipy_market_post WHERE ${clause}`, params);
  const limit = add(Math.min(Math.max(query.limit ?? 20, 1), 100));
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, body, kind, bhk, price_min_lakh, price_max_lakh, localities, poster_name, poster_phone,
            groups, last_posted_at, seen_count
       FROM ipy_market_post WHERE ${clause}
      ORDER BY last_posted_at DESC NULLS LAST LIMIT ${limit}`,
    params,
  );

  return {
    total: total?.n ?? 0,
    posts: rows.rows.map((row) => ({
      id: row.id as string,
      body: row.body as string,
      kind: row.kind as MarketPost['kind'],
      bhk: row.bhk as number | null,
      priceMinLakh: row.price_min_lakh as number | null,
      priceMaxLakh: row.price_max_lakh as number | null,
      localities: row.localities as string[],
      posterName: row.poster_name as string | null,
      posterPhone: row.poster_phone as string | null,
      groups: row.groups as string[],
      lastPostedAt: row.last_posted_at ? new Date(row.last_posted_at as string).toISOString() : null,
      seenCount: row.seen_count as number,
    })),
  };
}
