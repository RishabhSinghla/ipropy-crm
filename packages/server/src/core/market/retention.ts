/**
 * The feed shows 15 days (`MARKET_FEED_DAYS`) and no more; rows are physically deleted only after 45.
 *
 * 24 October 2026: the window shown shrank from 45 to 15 days, on the manager's instruction, with *no* data deleted by the
 * deploy. So the daily clear keeps its own, older limit below; it is a separate number on purpose. Lower it when the owner
 * says older rows may go.
 *
 * The owner, 20 October 2026: *"I don't want to keep any stale or junk data … no chats nowhere to us which are before
 * 45 days from the current date."* Read off production that day: 12,941 of 19,277 stored deals were older, with 30,941
 * property rows, 35,934 sightings and 8,274 notes copied onto dealers' records. Nobody had worked any of them.
 *
 * What goes is the chat itself and what was derived from it: the post, its sightings, its properties, Jev's verdicts on
 * its pairings (they cascade), and the note each one left on a dealer's Associate record. What stays is anything a person
 * did that is not a chat — a row on a dealer's deal table the team edited, a call, a comment they wrote — none of which
 * these tables hold. Imports are cleared in small batches so the database is never locked for long.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/** Rows older than this are deleted by the daily clear. Not the window the screens show: see the header. */
export const PURGE_AFTER_DAYS = 45;

export interface PurgeReport { posts: number; notes: number; sightings: number; imports: number }

const BATCH = 2000;

export async function purgeStaleMarketData(days = PURGE_AFTER_DAYS): Promise<PurgeReport> {
  const report: PurgeReport = { posts: 0, notes: 0, sightings: 0, imports: 0 };
  for (;;) {
    const ids = await db.query<{ id: string }>(
      `SELECT id FROM ipy_market_post WHERE coalesce(last_posted_at, created_at) < now() - make_interval(days => $1::int) LIMIT $2`, [days, BATCH]);
    if (!ids.rows.length) break;
    const list = ids.rows.map((row) => row.id);
    const notes = await db.query(`DELETE FROM ipy_comment WHERE market_post_id = ANY($1::uuid[])`, [list]);
    const posts = await db.query(`DELETE FROM ipy_market_post WHERE id = ANY($1::uuid[])`, [list]);
    report.notes += notes.rowCount ?? 0;
    report.posts += posts.rowCount ?? 0;
    if (ids.rows.length < BATCH) break;
  }
  // A repost of an old message in a recent group keeps the post but not the sighting that is itself stale.
  report.sightings = (await db.query(
    `DELETE FROM ipy_market_post_seen WHERE posted_at < now() - make_interval(days => $1::int)`, [days])).rowCount ?? 0;
  report.imports = (await db.query(
    `DELETE FROM ipy_market_import WHERE created_at < now() - make_interval(days => $1::int)`, [days])).rowCount ?? 0;
  if (report.posts || report.notes || report.sightings || report.imports) logger.info(report, 'market: stale data cleared');
  return report;
}

const MARKER = 'market.last_purge';

/** Once a day is enough, and a container waking twice must not clear it twice. */
export async function purgeStaleMarketDataDaily(now = new Date()): Promise<PurgeReport | null> {
  const day = now.toISOString().slice(0, 10);
  const claimed = await db.queryOne<{ key: string }>(
    `INSERT INTO ipy_setting (key, value, category, label) VALUES ($1, $2::jsonb, 'market', 'Last stale-data clear')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE ipy_setting.value->>'date' IS DISTINCT FROM $3
     RETURNING key`, [MARKER, JSON.stringify({ date: day }), day]);
  return claimed ? purgeStaleMarketData() : null;
}
