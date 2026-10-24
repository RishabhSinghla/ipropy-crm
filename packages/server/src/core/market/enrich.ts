/**
 * Jev reading the feed in the background.
 *
 * Importing a group stores every deal at once with the word-list reading, so
 * an upload never waits on a third party — a year of a busy group is thousands
 * of posts and Jev takes about a second for each. This is the second pass: it
 * picks up deals Jev has not looked at, newest first, asks, and corrects the
 * reading when Jev is sure.
 *
 * Alerts to owners wait for this pass when Jev is connected (see `feed.ts`),
 * so the person told about a deal is told about the right side of it.
 *
 * One visit at a time, like the other workers: two visits reading the same
 * rows would pay for each answer twice.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { notifyMany } from '../notifications/index.js';
import { isAiAvailable } from '../../ai/client.js';
import { findCrossMatches, invalidateMarketMatches, pairsWaitingForJev } from './crossMatch.js';
import { purgeStaleMarketDataDaily } from './retention.js';
import { syncDealerNotes } from './dealerNotes.js';
import { alertOwners, knownLocalities, READ_VERSION } from './feed.js';
import { askJev, askJevFit, jevIsAvailable, mergeReadings } from './jev.js';
import { extractListingsWithAi, saveListings, splitListings, worthAnAiRead } from './listings.js';
import { looksLikeANotice, placeKeysOf, readPost, type PostReading } from './readPost.js';

const EVERY_MS = 30_000;
const PER_VISIT = 24;
const AT_ONCE = 4;
/** After this many failed asks a post is left to the word lists rather than retried for ever. */
export const GIVE_UP_AFTER = 3;
const ALERT_WITHIN_DAYS = 7;

interface WaitingPost {
  id: string;
  body: string;
  kind: PostReading['kind'];
  purpose: PostReading['purpose'] | null;
  last_posted_at: Date | null;
  alerted_at: Date | null;
}

/** Read one post. Returns its id when the owners should now be told about it. */
async function readOne(post: WaitingPost): Promise<{ read: boolean; tell: string | null }> {
  const answer = await askJev(post.body);
  if ('failed' in answer) {
    await db.query(`UPDATE ipy_market_post SET jev_attempts = jev_attempts + 1 WHERE id = $1`, [post.id]);
    return { read: false, tell: null };
  }
  const merged = mergeReadings({ kind: post.kind, purpose: post.purpose ?? 'sale' } as PostReading, answer.reading);
  await db.query(
    `UPDATE ipy_market_post
        SET kind = $2, is_noise = $3, category = coalesce($4, category), poster_role = $5, urgency = $6, purpose = $7, jev_checked_at = now()
      WHERE id = $1`,
    [post.id, merged.kind, merged.isNoise, merged.category, merged.role, merged.urgency, merged.purpose],
  );
  // A message with one property in it takes Jev's word on what it is; a list keeps the split of its own lines.
  await db.query(
    `UPDATE ipy_market_listing SET kind = $2, purpose = $3
      WHERE post_id = $1 AND $2 IN ('have', 'want') AND 1 = (SELECT count(*) FROM ipy_market_listing WHERE post_id = $1)`,
    [post.id, merged.kind === 'have' || merged.kind === 'want' ? merged.kind : 'none', merged.purpose],
  );
  const ageDays = post.last_posted_at ? (Date.now() - post.last_posted_at.getTime()) / 86_400_000 : Infinity;
  const worthTelling = !post.alerted_at && !merged.isNoise && merged.kind !== 'unknown' && ageDays <= ALERT_WITHIN_DAYS;
  return { read: true, tell: worthTelling ? post.id : null };
}

export async function readWaitingPosts(limit = PER_VISIT): Promise<{ read: number; failed: number; alerted: number }> {
  if (!jevIsAvailable()) return { read: 0, failed: 0, alerted: 0 };
  const waiting = await db.query<WaitingPost>(
    `SELECT id, body, kind, purpose, last_posted_at, alerted_at
       FROM ipy_market_post
      WHERE jev_checked_at IS NULL AND jev_attempts < $1
      ORDER BY last_posted_at DESC NULLS LAST
      LIMIT $2`,
    [GIVE_UP_AFTER, limit],
  );

  let read = 0;
  let failed = 0;
  const toTell: string[] = [];
  for (let i = 0; i < waiting.rows.length; i += AT_ONCE) {
    const results = await Promise.all(waiting.rows.slice(i, i + AT_ONCE).map(readOne));
    for (const result of results) {
      if (result.read) read += 1; else failed += 1;
      if (result.tell) toTell.push(result.tell);
    }
    // Jev refusing every post in a batch means it is down or the key is wrong; stop paying for attempts.
    if (failed >= AT_ONCE * 2 && read === 0) break;
  }
  const alerted = toTell.length ? await alertOwners(toTell) : 0;
  return { read, failed, alerted };
}

/**
 * Re-read stored posts with the word lists. No network, so it is cheap and runs
 * whether or not Jev is connected: it is how posts imported before sectors,
 * sizes and categories were understood become matchable.
 */
async function readOnePostAgain(post: { id: string; body: string; listings_source: string | null }, localities: string[]): Promise<void> {
  const reading = readPost(post.body, localities);
  const notice = looksLikeANotice(post.body);
  await db.query(
    `UPDATE ipy_market_post
        SET places = $2, size_sqyd = $3, category = coalesce(category, $4), place_keys = $5, read_version = $6,
            phones = $8, poster_phone = coalesce($9, poster_phone), is_noise = is_noise OR $10,
            price_min_lakh = $11, price_max_lakh = $12,
            -- Jev's reading of sale or rent outranks the words, so a post it has already read keeps it.
            purpose = CASE WHEN jev_checked_at IS NULL THEN $7 ELSE coalesce(purpose, $7) END
      WHERE id = $1`,
    [post.id, reading.places, reading.sizeSqYd, reading.category, placeKeysOf(reading), READ_VERSION, reading.purpose,
      reading.phones, reading.phone, notice, reading.priceMinLakh, reading.priceMaxLakh],
  );
  // An AI model's split is better than the rules' and is kept; the rules' split is simply redone.
  if (post.listings_source === 'ai') return;
  if (notice) await db.query(`DELETE FROM ipy_market_listing WHERE post_id = $1`, [post.id]);
  else await saveListings(post.id, splitListings(post.body, localities, reading), 'rules', worthAnAiRead(post.body, localities));
}

export async function reReadOldPosts(limit = 300): Promise<number> {
  const old = await db.query<{ id: string; body: string; listings_source: string | null }>(
    `SELECT id, body, listings_source FROM ipy_market_post WHERE read_version < $1 ORDER BY last_posted_at DESC NULLS LAST LIMIT $2`,
    [READ_VERSION, limit],
  );
  if (!old.rows.length) return 0;
  const localities = await knownLocalities();
  for (const post of old.rows) {
    try {
      await readOnePostAgain(post, localities);
    } catch (err) {
      // One message the database refuses must never stop the thousands after it: this pass takes the
      // newest first, so a post that threw and stayed "unread" would be hit again at every visit and
      // nothing behind it would ever be read — which is how the live page stayed empty for a day.
      logger.error({ err, postId: post.id }, 'market: a stored message could not be read again; set aside');
      await db.query(`UPDATE ipy_market_post SET read_version = $2 WHERE id = $1`, [post.id, READ_VERSION]);
    }
  }
  return old.rows.length;
}

/**
 * The AI model's read of the long messages — the broadcasts of twenty plots, where
 * the rules are weakest. It replaces the rules' listings with its own, and it throws
 * out what is not a listing at all (a dispute notice, a greeting). Without a model
 * connected nothing happens and the rules' split stands.
 */
const AI_PER_VISIT = 12;
const AI_AT_ONCE = 4;
/** A model that has not answered in this long is not going to; the message waits for another try. */
const AI_CALL_TIMEOUT_MS = 45_000;
const AI_GIVE_UP_AFTER = 2;

export async function refineWithAi(limit = AI_PER_VISIT): Promise<number> {
  if (!isAiAvailable()) return 0;
  const waiting = await db.query<{ id: string; body: string }>(
    `SELECT id, body FROM ipy_market_post
      WHERE ai_pending AND NOT is_noise AND ai_attempts < $1
      ORDER BY last_posted_at DESC NULLS LAST LIMIT $2`,
    [AI_GIVE_UP_AFTER, limit],
  );
  if (!waiting.rows.length) return 0;
  const localities = await knownLocalities();
  let done = 0;
  for (let i = 0; i < waiting.rows.length; i += AI_AT_ONCE) {
    await Promise.all(waiting.rows.slice(i, i + AI_AT_ONCE).map(async (post) => {
     try {
      const drafts = await Promise.race([
        extractListingsWithAi(post.body, localities),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), AI_CALL_TIMEOUT_MS)),
      ]);
      if (drafts === null) {
        // After the last try the rules' split stands, and the message stops waiting to be written into notes.
        await db.query(`UPDATE ipy_market_post SET ai_attempts = ai_attempts + 1, ai_pending = (ai_attempts + 1 < $2) WHERE id = $1`, [post.id, AI_GIVE_UP_AFTER]);
        return;
      }
      if (!drafts.length) {
        await db.query(`DELETE FROM ipy_market_listing WHERE post_id = $1`, [post.id]);
        await db.query(`UPDATE ipy_market_post SET is_noise = true, ai_pending = false, listings_source = 'ai' WHERE id = $1`, [post.id]);
      } else {
        await saveListings(post.id, drafts, 'ai');
      }
      done += 1;
     } catch (err) {
      // The same rule as the re-read: a message the database refuses is counted against it and the rest go on.
      logger.error({ err, postId: post.id }, 'market: the AI model\'s listings for a message could not be saved');
      await db.query(`UPDATE ipy_market_post SET ai_attempts = ai_attempts + 1, ai_pending = (ai_attempts + 1 < $2) WHERE id = $1`, [post.id, AI_GIVE_UP_AFTER]);
     }
    }));
  }
  return done;
}

/**
 * Jev's second opinion on the pairings that would be shown. Each pairing is asked once,
 * best first; "no" takes it off the call sheet, and nothing is ever re-asked.
 */
const VERIFY_PER_VISIT = 400;
const VERIFY_PARALLEL = 8;

export async function verifyPairs(limit = VERIFY_PER_VISIT): Promise<number> {
  if (!jevIsAvailable()) return 0;
  // Worked out fresh: what is asked of Jev costs money, so it is never chosen from a sheet that may be minutes behind its own verdicts.
  // The whole sheet, best first: looking only at the top 300 left a pairing beyond it waiting until others cleared.
  const candidates = await pairsWaitingForJev();
  const done = new Set((await db.query<{ k: string }>(
    `SELECT want_listing_id || ':' || have_listing_id AS k FROM ipy_market_pair_check WHERE want_listing_id = ANY($1::uuid[])`,
    [candidates.map((match) => match.want.id)],
  )).rows.map((row) => row.k));
  const unchecked = candidates.filter((match) => !done.has(`${match.want.id}:${match.have.id}`)).slice(0, limit);
  const rejected = (await db.query<{ want_summary: string; have_summary: string }>(
    `SELECT w.summary AS want_summary, h.summary AS have_summary
       FROM ipy_market_deal d JOIN ipy_market_listing w ON w.id = d.want_listing_id JOIN ipy_market_listing h ON h.id = d.have_listing_id
      WHERE d.status = 'bad_match' ORDER BY d.updated_at DESC LIMIT 3`,
  )).rows.map((row) => ({ requirement: row.want_summary, offer: row.have_summary }));
  let checked = 0;
  let failures = 0;
  // Eight questions at a time: Jev answers each in well under a second, and asking one after another is what made the
  // backlog of unchecked pairings take hours to clear.
  for (let offset = 0; offset < unchecked.length && failures < 3; offset += VERIFY_PARALLEL) {
    const batch = unchecked.slice(offset, offset + VERIFY_PARALLEL);
    const answers = await Promise.all(batch.map((match) => askJevFit(match.want.summary || match.want.body, match.have.summary || match.have.body, rejected)));
    // Every answer missing means Jev (or the key, or the network) is down: nobody is to blame, so no pairing is marked.
    // A few missing among answers means those pairings are the problem, and each is counted against itself.
    const outage = answers.every((fit) => fit === null);
    for (const [index, fit] of answers.entries()) {
      const match = batch[index]!;
      if (fit === null) {
        failures += 1;
        if (!outage) {
          await db.query(
            `INSERT INTO ipy_market_pair_failed (want_listing_id, have_listing_id) VALUES ($1, $2)
             ON CONFLICT (want_listing_id, have_listing_id) DO UPDATE SET attempts = ipy_market_pair_failed.attempts + 1, last_at = now()`,
            [match.want.id, match.have.id]);
        }
        continue;
      }
      await db.query(
        `INSERT INTO ipy_market_pair_check (want_listing_id, have_listing_id, fit) VALUES ($1, $2, $3)
         ON CONFLICT (want_listing_id, have_listing_id) DO UPDATE SET fit = EXCLUDED.fit, checked_at = now()`,
        [match.want.id, match.have.id, fit],
      );
      checked += 1;
    }
    // A whole batch refused is an outage: stop paying for attempts and try again at the next visit.
    if (outage) failures += 3;
  }
  if (checked) invalidateMarketMatches();
  return checked;
}

/**
 * Everything the feed does on its own, in one visit.
 *
 * It rides the scheduler's tick (every fifteen minutes) and is also nudged
 * after an upload. It deliberately has no clock of its own: the database
 * powers down when nobody is asking it anything, and a thirty-second timer
 * would keep it awake all night for a feed that changes when somebody
 * uploads a group. Inside a visit it works until the backlog is clear or the
 * time budget is spent, because a first upload is thousands of posts.
 */
const VISIT_BUDGET_MS = 8 * 60_000;
/** The AI model is the slow one and sometimes a failing one; it gets a slice of a visit, never the whole of it. */
const AI_BUDGET_MS = 3 * 60_000;
let busy = false;

/** Repeat a stage while it still finds work, within a deadline. Returns how much it did in all. */
async function whileThereIsWork(stage: () => Promise<number>, deadline: number, rounds = 1000): Promise<number> {
  let total = 0;
  for (let round = 0; round < rounds && Date.now() < deadline; round += 1) {
    const done = await stage();
    if (!done) break;
    total += done;
  }
  return total;
}

/**
 * Stages in the order of how much a person is waiting for them:
 *   1. re-read what is stored (no network) — until nothing is left, because nothing else can show before it;
 *   2. Jev's read of new messages;
 *   3. the dealers' notes and Jev's check of each pairing — fast, and what the team looks at;
 *   4. the AI model's read of the long broadcasts — slow, so last and capped.
 * A slow stage used to sit in front of the others, and the notes and the checks never came.
 */
export async function marketWork(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // First: nothing older than the feed keeps is read, paired or alerted about, and it is cleared once a day.
    const purged = await purgeStaleMarketDataDaily();
    if (purged?.posts) invalidateMarketMatches();
    const started = Date.now();
    const deadline = started + VISIT_BUDGET_MS;

    await whileThereIsWork(() => reReadOldPosts(500), deadline);

    const jev = await whileThereIsWork(async () => {
      const result = await readWaitingPosts();
      return result.read;
    }, deadline);
    if (jev) logger.info({ jev }, 'market: Jev read messages');

    const noted = await whileThereIsWork(() => syncDealerNotes(), deadline);
    if (noted) logger.info({ noted }, 'market: messages written into dealers\' notes');

    const verified = await whileThereIsWork(() => verifyPairs(), deadline, 12);
    if (verified) logger.info({ verified }, 'market: Jev checked pairings');

    const refined = await whileThereIsWork(() => refineWithAi(), Math.min(deadline, Date.now() + AI_BUDGET_MS));
    if (refined) logger.info({ refined }, 'market: the AI model read long messages');

    await sendCallSheet();
  } catch (err) {
    logger.warn({ err }, 'market: background work failed; it will be tried again');
  } finally {
    busy = false;
  }
}

/** After an upload: start now instead of waiting for the next visit. */
export function nudgeMarketWork(): void {
  void marketWork();
}

const SHEET_HOUR_IST = 9;
const SHEET_MARKER = 'market.callsheet_last_sent';
const SHEET_SIZE = 10;

/** Today's date in India, which is what "once a day" means for this team. */
function indiaDate(now = new Date()): { date: string; hour: number } {
  const shifted = new Date(now.getTime() + 5.5 * 3_600_000);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
}

/**
 * The morning list of introductions worth a call, to the people who run the
 * business. The list itself lives on the Market screen; this is the nudge to
 * open it, with the best few named so the bell says something on its own.
 */
export async function sendCallSheet(now = new Date()): Promise<boolean> {
  const today = indiaDate(now);
  if (today.hour < SHEET_HOUR_IST) return false;
  const last = await db.queryOne<{ value: { date?: string } }>(`SELECT value FROM ipy_setting WHERE key = $1`, [SHEET_MARKER]);
  if (last?.value?.date === today.date) return false;
  const matches = (await findCrossMatches({ limit: SHEET_SIZE })).filter((m) => m.status === 'new' || m.status === 'called' || m.status === 'busy');
  if (!matches.length) return false;
  // Claim the day first, so two containers waking together cannot both send it.
  const claimed = await db.queryOne<{ key: string }>(
    `INSERT INTO ipy_setting (key, value, category, label)
     VALUES ($1, $2::jsonb, 'market', 'Last morning call sheet')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE ipy_setting.value->>'date' IS DISTINCT FROM $3
     RETURNING key`,
    [SHEET_MARKER, JSON.stringify({ date: today.date }), today.date],
  );
  if (!claimed) return false;

  const admins = await db.query<{ id: string }>(`SELECT id FROM ipy_user WHERE is_admin AND is_active`);
  const strong = matches.filter((m) => m.score >= 0.7).length;
  await notifyMany(admins.rows.map((row) => row.id), {
    kind: 'market_callsheet',
    title: `${matches.length} introductions worth a call today`,
    body: `${strong} strong. Best: ${matches[0]!.reasons.slice(0, 2).join(', ')}`,
    link: '/market?tab=calls',
  });
  return true;
}
