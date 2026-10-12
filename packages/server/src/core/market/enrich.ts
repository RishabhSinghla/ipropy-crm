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
import { findCrossMatches } from './crossMatch.js';
import { alertOwners, knownLocalities } from './feed.js';
import { askJev, jevIsAvailable, mergeReadings } from './jev.js';
import { placeKeysOf, readPost, type PostReading } from './readPost.js';

const EVERY_MS = 30_000;
const PER_VISIT = 24;
const AT_ONCE = 4;
/** After this many failed asks a post is left to the word lists rather than retried for ever. */
const GIVE_UP_AFTER = 3;
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

/** Bump when `readPost` learns something new; every older row is then re-read once. */
const READ_VERSION = 2;

/**
 * Re-read stored posts with the word lists. No network, so it is cheap and runs
 * whether or not Jev is connected: it is how posts imported before sectors,
 * sizes and categories were understood become matchable.
 */
export async function reReadOldPosts(limit = 500): Promise<number> {
  const old = await db.query<{ id: string; body: string }>(
    `SELECT id, body FROM ipy_market_post WHERE read_version < $1 ORDER BY last_posted_at DESC NULLS LAST LIMIT $2`,
    [READ_VERSION, limit],
  );
  if (!old.rows.length) return 0;
  const localities = await knownLocalities();
  for (const post of old.rows) {
    const reading = readPost(post.body, localities);
    await db.query(
      `UPDATE ipy_market_post
          SET places = $2, size_sqyd = $3, category = coalesce(category, $4), place_keys = $5, read_version = $6,
              -- Jev's reading of sale or rent outranks the words, so a post it has already read keeps it.
              purpose = CASE WHEN jev_checked_at IS NULL THEN $7 ELSE coalesce(purpose, $7) END
        WHERE id = $1`,
      [post.id, reading.places, reading.sizeSqYd, reading.category, placeKeysOf(reading), READ_VERSION, reading.purpose],
    );
  }
  return old.rows.length;
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
let busy = false;

export async function marketWork(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const started = Date.now();
    while (Date.now() - started < VISIT_BUDGET_MS) {
      const reread = await reReadOldPosts();
      const result = await readWaitingPosts();
      if (result.read || result.failed) logger.info({ ...result }, 'market: Jev read a batch');
      if (!reread && !result.read) break;
    }
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
  const matches = (await findCrossMatches({ limit: SHEET_SIZE })).filter((m) => m.status === 'new' || m.status === 'called');
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
