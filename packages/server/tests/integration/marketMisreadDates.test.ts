/**
 * 20 October 2026: 22 month-first WhatsApp exports were read day-first, which put deals in 2027
 * and 2028 and past the feed-window filter. Migration 215 turns those dates back. Only a real database
 * can prove it, because it works on the rows' own transaction ids and on time zones.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, transaction } from '../../src/db/pool.js';

const group = `itest-misread-${Date.now()}`;
const here = dirname(fileURLToPath(import.meta.url));
const posted = async (post: string): Promise<{ last: string | null; first: string | null }> => {
  const row = await db.queryOne<{ last: Date | null; first: Date | null }>(
    `SELECT last_posted_at AS last, first_posted_at AS first FROM ipy_market_post WHERE body = $1`, [post]);
  return { last: row?.last?.toISOString() ?? null, first: row?.first?.toISOString() ?? null };
};
const sightingsOf = async (post: string): Promise<string[]> =>
  (await db.query<{ posted_at: Date }>(
    `SELECT s.posted_at FROM ipy_market_post_seen s JOIN ipy_market_post p ON p.id = s.post_id WHERE p.body = $1 ORDER BY s.posted_at`, [post]))
    .rows.map((row) => row.posted_at.toISOString());

/** What the old reader stored for a month-first line: day = first number, month = second, in India time. */
const misread = (month: number, day: number, hour: number, minute: number): string =>
  new Date(Date.UTC(2026, day - 1, month, hour - 5, minute - 30)).toISOString();

// The migrations ask the database for now(); a real clock would turn "in the future" fixtures into the past one
// day. So they run with now() pinned (below) and every fixture is dated against this instead.
const PINNED_NOW = '2026-10-25 12:00+00';
const FUTURE = misread(10, 31, 9, 15);

/** Runs a migration file as the runner does, with every now() in it replaced by PINNED_NOW. */
const runPinned = (sql: string, afterwards = ''): Promise<void> => transaction(async (tx) => {
  await tx.query(sql.replaceAll('now()', `timestamptz '${PINNED_NOW}'`));
  if (afterwards) await tx.query(afterwards);
});

const NEW_ONLY = `${group} brand new deal`;
const OLD_AND_NEW = `${group} older deal seen again`;
const ELSEWHERE = `${group} other group untouched`;
const EARLY = `${group} written first then updated`;

beforeAll(async () => {
  await db.query(`DELETE FROM ipy_market_post WHERE body LIKE $1`, [`${group}%`]);
  await db.query(`DELETE FROM ipy_market_import WHERE group_name = $1 OR group_name = $2`, [group, `${group}-other`]);
  await db.query(`DELETE FROM ipy_market_group WHERE name = $1`, [group]);

  // Before the bad imports: a deal read correctly on an earlier day, and another group nobody touched.
  await db.query(
    `INSERT INTO ipy_market_post (fingerprint, body, groups, first_posted_at, last_posted_at, created_at)
     VALUES ($1, $2, ARRAY[$3::text], '2026-09-20 10:00+05:30', '2026-09-20 10:00+05:30', '2026-10-10 10:00+00'),
            ($4, $5, ARRAY[$6::text], '2026-10-01 10:00+05:30', '2026-10-01 10:00+05:30', '2026-10-10 10:00+00')`,
    [`${group}-b`, OLD_AND_NEW, group, `${group}-c`, ELSEWHERE, `${group}-other`]);
  await db.query(
    `INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender)
     SELECT id, groups[1], first_posted_at, 'A' FROM ipy_market_post WHERE body IN ($1, $2)`, [OLD_AND_NEW, ELSEWHERE]);

  // The bad imports: they exist in the window, then write posts and sightings with misread dates.
  await db.query(
    `INSERT INTO ipy_market_import (group_name, file_name, file_hash, status, created_at)
     VALUES ($1, 'x.zip', 'h', 'done', '2026-10-20 11:12+00')`, [group]);
  // The first deal of the import: its sightings are written, then the deal is updated again (a repeat), which
  // gives it a newer transaction id than the sightings — the case the first repair drew its line too high for.
  await db.query(
    `INSERT INTO ipy_market_post (fingerprint, body, groups, first_posted_at, last_posted_at, created_at)
     VALUES ($1, $2, ARRAY[$3::text], $4::timestamptz, $4::timestamptz, '2026-10-20 11:11+00')`,
    [`${group}-e`, EARLY, group, misread(10, 18, 10, 0)]);
  await db.query(`INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender)
                  SELECT id, $2, $3::timestamptz, 'D' FROM ipy_market_post WHERE body = $1`, [EARLY, group, misread(10, 18, 10, 0)]);
  await db.query(`INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender)
                  SELECT id, $2, $3::timestamptz, 'E' FROM ipy_market_post WHERE body = $1`, [EARLY, group, misread(9, 8, 10, 0)]);
  await db.query(`UPDATE ipy_market_post SET seen_count = seen_count + 1 WHERE body = $1`, [EARLY]);
  await db.query(
    `INSERT INTO ipy_market_post (fingerprint, body, groups, first_posted_at, last_posted_at, created_at)
     VALUES ($1, $2, ARRAY[$3::text], $4::timestamptz, $4::timestamptz, '2026-10-20 11:20+00')`,
    [`${group}-a`, NEW_ONLY, group, misread(10, 20, 16, 32)]);
  await db.query(`INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender)
                  SELECT id, $2, $3::timestamptz, 'B' FROM ipy_market_post WHERE body = $1`, [NEW_ONLY, group, misread(10, 20, 16, 32)]);
  // The old deal was seen again in the bad import: its dates were pushed forward by GREATEST.
  await db.query(`UPDATE ipy_market_post SET last_posted_at = $2::timestamptz WHERE body = $1`, [OLD_AND_NEW, FUTURE]);
  await db.query(`INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender)
                  SELECT id, $2, $3::timestamptz, 'B' FROM ipy_market_post WHERE body = $1`, [OLD_AND_NEW, group, FUTURE]);
  // And one that landed on a valid but wrong day: 5 September, read as 9 May.
  await db.query(`INSERT INTO ipy_market_post_seen (post_id, group_name, posted_at, sender)
                  SELECT id, $2, $3::timestamptz, 'C' FROM ipy_market_post WHERE body = $1`, [NEW_ONLY, group, misread(9, 5, 9, 0)]);
  await db.query(`INSERT INTO ipy_market_group (name, read_up_to) VALUES ($1, '2028-07-08 00:00+00')`, [group]);
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_market_post WHERE body LIKE $1`, [`${group}%`]);
  await db.query(`DELETE FROM ipy_market_import WHERE group_name = $1`, [group]);
  await db.query(`DELETE FROM ipy_market_group WHERE name = $1`, [group]);
});

describe('migration 215 puts misread dates back', () => {
  it('turns every misread sighting back into the day it was posted, and leaves the rest alone', async () => {
    const sql = await readFile(join(here, '../../src/db/migrations/215_market_fix_misread_dates.sql'), 'utf8');
    // As the runner does it: the file and its row in ipy_migration share one transaction id.
    await runPinned(sql, `UPDATE ipy_migration SET applied_at = applied_at WHERE name = '215_market_fix_misread_dates.sql'`);

    // 20 October 4:32 PM and 5 September 9:00 AM, India time.
    expect(await sightingsOf(NEW_ONLY)).toEqual(['2026-09-05T03:30:00.000Z', '2026-10-20T11:02:00.000Z']);
    expect(await posted(NEW_ONLY)).toEqual({ first: '2026-09-05T03:30:00.000Z', last: '2026-10-20T11:02:00.000Z' });

    // The older deal keeps its real earlier sighting. The second one reads back as 31 October, which has not happened
    // yet, so it is dropped rather than believed — and the deal's dates come from the sighting that is left.
    const old = await posted(OLD_AND_NEW);
    expect(old.first).toBe('2026-09-20T04:30:00.000Z');
    expect(new Date(old.last!).getTime()).toBeLessThanOrEqual(Date.parse(PINNED_NOW) + 86_400_000);

    // Another group's rows were never touched.
    expect(await sightingsOf(ELSEWHERE)).toEqual(['2026-10-01T04:30:00.000Z']);
    expect(await posted(ELSEWHERE)).toEqual({ first: '2026-10-01T04:30:00.000Z', last: '2026-10-01T04:30:00.000Z' });
  });

  it('the second pass finishes what the first could not reach, and leaves what the first fixed alone', async () => {
    // After the first pass the early deal still has a future sighting.
    expect((await sightingsOf(EARLY)).some((at) => new Date(at).getTime() > Date.parse(PINNED_NOW))).toBe(true);
    const second = await readFile(join(here, '../../src/db/migrations/216_market_fix_misread_dates_second_pass.sql'), 'utf8');
    await runPinned(second);

    // 18 October 10:00 IST and 8 September 10:00 IST.
    expect(await sightingsOf(EARLY)).toEqual(['2026-09-08T04:30:00.000Z', '2026-10-18T04:30:00.000Z']);
    expect(await posted(EARLY)).toEqual({ first: '2026-09-08T04:30:00.000Z', last: '2026-10-18T04:30:00.000Z' });
    // Not turned back a second time.
    expect(await sightingsOf(NEW_ONLY)).toEqual(['2026-09-05T03:30:00.000Z', '2026-10-20T11:02:00.000Z']);
    expect(await sightingsOf(ELSEWHERE)).toEqual(['2026-10-01T04:30:00.000Z']);
  });

  it('brings the group\'s "read up to" back from 2028 to its newest real sighting', async () => {
    const mark = await db.queryOne<{ read_up_to: Date }>(`SELECT read_up_to FROM ipy_market_group WHERE name = $1`, [group]);
    expect(mark!.read_up_to.getTime()).toBeLessThanOrEqual(Date.parse(PINNED_NOW) + 86_400_000);
    expect(mark!.read_up_to.toISOString()).toBe('2026-10-20T11:02:00.000Z');
  });

  it('rewrites the date in the first line of a note without touching the rest', async () => {
    const note = await db.queryOne<{ body: string }>(
      `SELECT regexp_replace(E'💬 WhatsApp · A + B · 8 Jul 2028\ntabs\n\nbody',
                E'^(💬 WhatsApp · [^\\n]*) · [^\\n·]*\\n', E'\\\\1 · 20 Oct 2026\n') AS body`);
    expect(note!.body).toBe('💬 WhatsApp · A + B · 20 Oct 2026\ntabs\n\nbody');
  });
});
