/**
 * The market feed: storing and searching deals from dealer WhatsApp groups.
 *
 * The reading itself is `readPost.ts`, pure and tested. This file is the two
 * things that touch the database: putting a group's export in, once per deal,
 * and asking it questions — the same question a rep types into chat.ipropy.com.
 */
import { MARKET_FEED_DAYS } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { notify } from '../notifications/index.js';
import { logger } from '../../utils/logger.js';
import { invalidateMarketMatches } from './crossMatch.js';
import { type ChatMessage, fingerprintOf, looksLikeADeal, looksLikeANotice, parseWhatsAppExport, placeKeysOf, readPost, tidyBody } from './readPost.js';
import { saveListings, splitListings, worthAnAiRead } from './listings.js';
import { matchDeal, type DealMatch } from './matchDeal.js';
import { jevIsAvailable } from './jev.js';
import { dealerDirectory, saveDealersAsAssociates } from './dealers.js';
import { label as placeLabel } from './crossMatch.js';

/** Bump when `readPost` or the listing splitter learns something new; every stored post is then read again, once. */
export const READ_VERSION = 4;

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
  /** Messages older than where the last upload of this group ended: already read, so not read again. */
  skippedOld: number;
  /** Messages the database refused; they are skipped and logged, never fatal. */
  refused: number;
  /** Properties found in the new messages — a broker's list of twenty is twenty. */
  listings: number;
  /** People told that a fresh deal fits one of their records. */
  alerted: number;
}

/**
 * Only a fresh deal is worth an alert. The first upload of a group is often a
 * year of history, and ringing the team about a flat posted in March is how
 * they learn to switch alerts off — older deals are matched when somebody asks.
 */
const ALERT_WITHIN_DAYS = 7;
/** Keep a small group of messages moving together instead of making each DB round-trip wait for the last. */
const IMPORT_CONCURRENCY = 16;
/**
 * Nothing the feed holds is older than this. A deal from last quarter is gone, a requirement from last quarter is
 * filled, and keeping them only buried the live ones: 12,941 of 19,277 stored deals were older on 20 October 2026.
 */
export const KEEP_DAYS = MARKET_FEED_DAYS;

/** "FEAWA  Registered Members " and "feawa registered members" are one group. */
export function groupKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Put one group's export into the feed — **only what is new**.
 *
 * An export is the whole history every time. The first upload of a group reads
 * all of it; the next reads only from where that one ended
 * (`ipy_market_group.read_up_to`), so a second upload of a year-old group with
 * a week of news costs a week. Two safeguards stand behind that, because a clock
 * is a guess about somebody else's export: a message in the same minute as the
 * mark is read again, and every sighting is recorded (`ipy_market_post_seen`) so
 * reading one twice can never count it twice.
 *
 * A deal already held — forwarded into another group — is not stored again: its
 * group is added and it is marked seen once more, which is what "posted in 6
 * groups" on the screen reads.
 */
export async function importGroupExport(rawGroupName: string, text: string, userId: string): Promise<ImportOutcome> {
  return importGroupMessages(rawGroupName, parseWhatsAppExport(text), userId);
}

/**
 * The same import for messages that are already parsed — a live feed from the linked phone hands them over
 * directly, so a message read live and the same message read later from an uploaded export are one deal.
 */
export async function importGroupMessages(
  rawGroupName: string, messages: ChatMessage[], userId: string,
  /** A history backfill may reach back before the mark live messages have already moved forward; the fingerprints still stop any repeat. */
  options: { ignoreMark?: boolean } = {},
): Promise<ImportOutcome> {
  const groupName = groupKey(rawGroupName);
  const localities = await knownLocalities();
  const outcome: ImportOutcome = { messages: messages.length, deals: 0, newDeals: 0, repeats: 0, skippedOld: 0, refused: 0, listings: 0, alerted: 0 };
  const fresh: string[] = [];

  const mark = await db.queryOne<{ read_up_to: Date | null }>(`SELECT read_up_to FROM ipy_market_group WHERE name = $1`, [groupName]);
  const readUpTo = options.ignoreMark ? null : (mark?.read_up_to ?? null);
  const previousMark = mark?.read_up_to ?? null;
  let newest: Date | null = previousMark;

  const storeMessage = async (message: (typeof messages)[number]): Promise<void> => {
    const reading = readPost(message.body, localities);
    if (!looksLikeADeal(message.body, reading)) return;
    outcome.deals += 1;

    const posted = message.postedAt?.toISOString() ?? null;
    const notice = looksLikeANotice(message.body);
    const result = await db.queryOne<{ id: string; inserted: boolean }>(
      `INSERT INTO ipy_market_post
         (fingerprint, body, kind, bhk, price_min_lakh, price_max_lakh, localities,
          poster_name, poster_phone, groups, first_posted_at, last_posted_at, imported_by, places, size_sqyd,
          category, place_keys, purpose, phones, is_noise, read_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10::text], $11::timestamptz, $11::timestamptz, $12, $13, $14,
               $15, $16, $17, $18, $19, $20)
       ON CONFLICT (fingerprint) DO UPDATE SET
         groups = CASE WHEN $10::text = ANY(ipy_market_post.groups) THEN ipy_market_post.groups
                       ELSE ipy_market_post.groups || $10::text END,
         last_posted_at = GREATEST(ipy_market_post.last_posted_at, EXCLUDED.last_posted_at),
         first_posted_at = LEAST(ipy_market_post.first_posted_at, EXCLUDED.first_posted_at)
       RETURNING id, (xmax = 0) AS inserted`,
      [
        fingerprintOf(message.body), message.body, reading.kind, reading.bhk,
        reading.priceMinLakh, reading.priceMaxLakh, reading.localities,
        message.sender, reading.phone, groupName, posted, userId,
        reading.places, reading.sizeSqYd, reading.category, placeKeysOf(reading), reading.purpose,
        reading.phones, notice, READ_VERSION,
      ],
    );
    if (!result) return;

    // Counted once per sighting: reading the same line of the same export again changes nothing.
    const sighting = await db.queryOne<{ post_id: string }>(
      `INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender) VALUES ($1, $2, $3::timestamptz, $4)
       ON CONFLICT DO NOTHING RETURNING post_id`,
      [result.id, groupName, posted, message.sender],
    );

    if (result.inserted) {
      outcome.newDeals += 1;
      if (!notice) {
        const found = splitListings(message.body, localities, reading);
        try {
          await saveListings(result.id, found, 'rules', worthAnAiRead(message.body, localities), { replace: false });
          outcome.listings += found.length;
        } catch (err) {
          // The message is kept; the background re-read tries its listings again, and sets it aside if it fails again.
          logger.error({ err, postId: result.id }, 'market: a message\'s listings could not be saved');
          await db.query(`UPDATE ipy_market_post SET read_version = 0 WHERE id = $1`, [result.id]);
        }
      }
      const ageDays = message.postedAt ? (Date.now() - message.postedAt.getTime()) / 86_400_000 : Infinity;
      if (!notice && ageDays <= ALERT_WITHIN_DAYS) fresh.push(result.id);
    } else if (sighting) {
      outcome.repeats += 1;
      await db.query(`UPDATE ipy_market_post SET seen_count = seen_count + 1 WHERE id = $1`, [result.id]);
    }
  };

  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const freshMessages = messages.filter((message) => {
    if (message.postedAt && (!newest || message.postedAt > newest)) newest = message.postedAt;
    // Older than the feed keeps, or with no date to prove it is not: never stored, so there is nothing to clean up later.
    if (!message.postedAt || message.postedAt.getTime() < cutoff) {
      outcome.skippedOld += 1;
      return false;
    }
    if (readUpTo && message.postedAt < readUpTo) {
      outcome.skippedOld += 1;
      return false;
    }
    return true;
  });

  // Most of a re-uploaded group is what the feed already holds. Those are recorded in a few statements
  // for the whole file instead of three round trips each, and only what is genuinely new is read and stored one by one.
  const prints = freshMessages.map((message) => fingerprintOf(message.body));
  const held = new Set<string>();
  for (let offset = 0; offset < prints.length; offset += 5000) {
    const rows = await db.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM ipy_market_post WHERE fingerprint = ANY($1::text[])`, [prints.slice(offset, offset + 5000)]);
    for (const row of rows.rows) held.add(row.fingerprint);
  }
  const repeats: Array<{ fingerprint: string; posted: string; sender: string }> = [];
  const brandNew: typeof freshMessages = [];
  freshMessages.forEach((message, index) => {
    if (held.has(prints[index]!)) repeats.push({ fingerprint: prints[index]!, posted: message.postedAt!.toISOString(), sender: message.sender });
    else brandNew.push(message);
  });
  for (let offset = 0; offset < repeats.length; offset += 2000) {
    const chunk = repeats.slice(offset, offset + 2000);
    try {
      const done = await db.queryOne<{ repeats: number }>(
        `WITH incoming AS (
           SELECT fp, posted, sender FROM unnest($1::text[], $2::timestamptz[], $3::text[]) AS t(fp, posted, sender)
         ), hit AS (
           SELECT p.id, i.posted, i.sender FROM incoming i JOIN ipy_market_post p ON p.fingerprint = i.fp
         ), newly AS (
           INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender)
           SELECT id, $4::text, posted, sender FROM hit ON CONFLICT DO NOTHING RETURNING post_id
         ), counted AS (
           SELECT post_id, count(*)::int AS n FROM newly GROUP BY post_id
         ), spread AS (
           SELECT id, max(posted) AS last_at, min(posted) AS first_at FROM hit GROUP BY id
         ), upd AS (
           UPDATE ipy_market_post p
              SET seen_count = p.seen_count + coalesce(c.n, 0),
                  groups = CASE WHEN $4::text = ANY(p.groups) THEN p.groups ELSE p.groups || $4::text END,
                  last_posted_at = GREATEST(p.last_posted_at, s.last_at),
                  first_posted_at = LEAST(p.first_posted_at, s.first_at)
             FROM spread s LEFT JOIN counted c ON c.post_id = s.id
            WHERE p.id = s.id RETURNING p.id
         )
         SELECT (SELECT count(*) FROM newly)::int AS repeats`,
        [chunk.map((r) => r.fingerprint), chunk.map((r) => r.posted), chunk.map((r) => r.sender), groupName]);
      outcome.deals += chunk.length;
      outcome.repeats += done?.repeats ?? 0;
    } catch (err) {
      outcome.refused += chunk.length;
      logger.error({ err, group: groupName }, 'market: a batch of repeated messages could not be recorded; skipped');
    }
  }

  for (let offset = 0; offset < brandNew.length; offset += IMPORT_CONCURRENCY) {
    const batch = brandNew.slice(offset, offset + IMPORT_CONCURRENCY);
    await Promise.all(batch.map(async (message) => {
      try {
        await storeMessage(message);
      } catch (err) {
        // One message the database refuses must not throw away the other thousands in the export.
        outcome.refused += 1;
        logger.error({ err, group: groupName }, 'market: a message could not be stored; skipped');
      }
    }));
  }

  await db.query(
    `INSERT INTO ipy_market_group (name, read_up_to, messages_seen, last_import_at) VALUES ($1, $2::timestamptz, $3, now())
     ON CONFLICT (name) DO UPDATE SET read_up_to = GREATEST(ipy_market_group.read_up_to, EXCLUDED.read_up_to),
       messages_seen = ipy_market_group.messages_seen + EXCLUDED.messages_seen, last_import_at = now()`,
    [groupName, newest?.toISOString() ?? null, outcome.messages - outcome.skippedOld],
  );

  // With Jev connected the background reader alerts once it has read each deal,
  // because its verdict can turn a "want" into a "have" and send the alert to
  // the wrong people. Without Jev there is nothing to wait for.
  if (!jevIsAvailable()) outcome.alerted = await alertOwners(fresh);
  return outcome;
}

/** The people who posted become Associates and their messages go into their notes; then Jev reads. */
export async function afterImport(groupName: string | string[]): Promise<void> {
  // New deals are in: the kept call sheet is stale and is rebuilt behind the one being shown.
  invalidateMarketMatches();
  const names = new Set((Array.isArray(groupName) ? groupName : [groupName]).map(groupKey));
  try {
    const dealers = (await dealerDirectory()).filter((dealer) => dealer.groups.some((group) => names.has(group)));
    const saved = await saveDealersAsAssociates(dealers);
    logger.info({ groupName, ...saved }, 'market: dealers added to Associates');
  } catch (err) {
    logger.warn({ err }, 'market: adding dealers to Associates failed');
  } finally {
    // Dynamic, because the background reader imports this file back for its alerts.
    void import('./enrich.js').then((m) => m.nudgeMarketWork());
  }
}

/**
 * Tell each owner, once per deal, which of their own records it fits. One
 * notification per person per deal rather than per record, so a deal that fits
 * five of somebody's contacts is one line in their bell, not five.
 */
export async function alertOwners(postIds: string[]): Promise<number> {
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
    const post = await db.queryOne<{ kind: string; poster_name: string | null; group_name: string | null }>(
      `SELECT kind, poster_name, groups[1] AS group_name FROM ipy_market_post WHERE id = $1`, [postId],
    );
    await db.query(`UPDATE ipy_market_post SET alerted_at = now() WHERE id = $1`, [postId]);
    const groupName = post?.group_name ?? 'a dealer group';
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
  category: string | null;
  posterRole: string | null;
}

export async function searchMarket(query: MarketQuery): Promise<{ total: number; posts: MarketPost[] }> {
  // Never older than the feed window and never from the future: a date after today was misread, not posted tomorrow.
  const where: string[] = [
    `NOT is_noise`,
    `coalesce(last_posted_at, created_at) > now() - make_interval(days => $1::int)`,
    `coalesce(last_posted_at, created_at) <= now() + interval '1 day'`,
  ];
  const params: unknown[] = [Math.min(Math.max(query.days ?? KEEP_DAYS, 1), KEEP_DAYS)];
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
            groups, last_posted_at, seen_count, category, poster_role
       FROM ipy_market_post WHERE ${clause}
      ORDER BY last_posted_at DESC NULLS LAST LIMIT ${limit}`,
    params,
  );

  return {
    total: total?.n ?? 0,
    posts: rows.rows.map(rowToPost),
  };
}

function rowToPost(row: Record<string, unknown>): MarketPost {
  return {
    id: row.id as string,
    body: tidyBody(row.body as string),
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
    category: row.category as string | null,
    posterRole: row.poster_role as string | null,
  };
}

export interface PostDetail {
  post: MarketPost;
  listings: Array<{
    id: string; kind: 'have' | 'want'; purpose: 'sale' | 'rent'; category: string | null; bhk: number | null;
    sizeSqYd: number | null; priceMinLakh: number | null; priceMaxLakh: number | null; places: string[]; summary: string; source: 'rules' | 'ai';
  }>;
  /** Every time this message was seen, in which group, by whom. */
  sightings: Array<{ group: string; postedAt: string | null; sender: string }>;
}

/** One message in full, the properties read out of it, and everywhere it was posted. */
export async function getPostDetail(id: string): Promise<PostDetail | null> {
  const found = await searchMarketById(id);
  if (!found) return null;
  const listings = await db.query<Record<string, unknown>>(
    `SELECT id, kind, purpose, category, bhk, size_sqyd, price_min_lakh, price_max_lakh, place_keys, summary, source
       FROM ipy_market_listing WHERE post_id = $1 ORDER BY ord`, [id],
  );
  const seen = await db.query<{ group_name: string; posted_at: Date | null; sender: string }>(
    `SELECT group_name, posted_at, sender FROM ipy_market_post_seen WHERE post_id = $1 ORDER BY posted_at NULLS LAST LIMIT 50`, [id],
  );
  return {
    post: found,
    listings: listings.rows.map((row) => ({
      id: row.id as string, kind: row.kind as 'have' | 'want', purpose: row.purpose as 'sale' | 'rent', category: row.category as string | null,
      bhk: row.bhk as number | null, sizeSqYd: row.size_sqyd as number | null, priceMinLakh: row.price_min_lakh as number | null,
      priceMaxLakh: row.price_max_lakh as number | null, places: (row.place_keys as string[]).map(placeLabel),
      summary: row.summary as string, source: row.source as 'rules' | 'ai',
    })),
    sightings: seen.rows.map((row) => ({ group: row.group_name, postedAt: row.posted_at ? row.posted_at.toISOString() : null, sender: row.sender })),
  };
}

async function searchMarketById(id: string): Promise<MarketPost | null> {
  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT id, body, kind, bhk, price_min_lakh, price_max_lakh, localities, poster_name, poster_phone,
            groups, last_posted_at, seen_count, category, poster_role
       FROM ipy_market_post WHERE id = $1`, [id],
  );
  return row ? rowToPost(row) : null;
}
