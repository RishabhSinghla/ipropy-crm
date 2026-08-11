/**
 * Turning a day's loose photos into the visits they came from, with nobody
 * having pressed anything.
 *
 * `sessions.ts` covers the good case: somebody tapped Start at the gate and the
 * property was named at the one moment it was certain. This covers the case
 * that actually happens — they didn't, and there are 200 photos of six places
 * sitting in an account with no idea which is which.
 *
 * The only signal in an unopened shoot is the clock, and it is a better signal
 * than it sounds. Photographing a builder floor is a burst: thirty shots over
 * fifteen minutes, then a drive, then the next burst. The drive is the delimiter.
 * A gap of `GAP_MINUTES` between consecutive photos means the run before it and
 * the run after it are different places.
 *
 * What this deliberately does not do is name them. A gap in a timeline says
 * "these are two places", never "this one is B-110" — that fact only ever
 * existed in the photographer's head, and the honest thing is to ask them for it
 * once, that evening, with the pictures on screen. Six taps sitting down beats
 * six taps at six gates, because a missed tap here costs nothing: the group is
 * still there tomorrow.
 *
 * Manual always outranks auto. A group made here is a guess about boundaries; a
 * session somebody opened is a statement. See `matchOrphansForSession`, which
 * can take photos back off an unnamed auto group when the visit that explains
 * them finally syncs.
 */
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * The gap that means "different place".
 *
 * Tuned to the actual job rather than to a round number. A thorough walkthrough
 * with a talkative owner has quiet stretches — the photographer stops shooting,
 * listens, measures a room, argues about the price — so anything under about
 * half an hour splits one visit into several, which is the more annoying of the
 * two errors: the reviewer has to name the same property three times.
 *
 * The opposite error, merging two visits, needs 40 minutes of continuous
 * shooting-then-driving-then-shooting to occur, and Greenfield floors are five
 * minutes apart. It happens, and the review screen is where it gets caught:
 * splitting a group is a thing a person can see is needed. Merging two groups
 * they were never shown is not.
 */
export const GAP_MINUTES = 40;

/**
 * How long a photo is left alone before it is grouped.
 *
 * Uploads finish out of order and hours late — a phone shooting with no signal
 * syncs the whole day at once over office wi-fi, and the order bytes arrive in
 * has nothing to do with the order the shots were taken. Grouping a photo the
 * instant it lands would mint a group per straggler.
 *
 * Nothing is waiting on this. The groups are read in the evening; a half-hour
 * settle costs the user nothing and removes almost all of the churn.
 */
export const SETTLE_MINUTES = 30;

/** Enough for a heavy day across a whole team, bounded so a backlog cannot stall the tick. */
const BATCH = 500;

interface UnfiledPhoto {
  id: string;
  uploaded_by: string;
  captured_at: Date;
}

interface Bucket {
  /** Null until written — a group this sweep is inventing. */
  id: string | null;
  startedAt: Date;
  endedAt: Date;
  photoIds: string[];
}

const gapMs = GAP_MINUTES * 60_000;

/**
 * Group every settled photo that belongs to no session yet.
 *
 * Incremental and safe to run on a timer: photos already in a group are never
 * looked at, and a late arrival extends the group it falls near rather than
 * starting a rival one. Returns how many photos were filed.
 */
export async function groupUnfiledPhotos(conn: Tx = db): Promise<number> {
  await pruneEmptyAutoShoots(conn);

  const { rows: photos } = await conn.query<UnfiledPhoto>(
    `SELECT id, uploaded_by, captured_at
       FROM ipy_attachment
      WHERE shoot_session_id IS NULL
        AND record_id IS NULL
        AND captured_at IS NOT NULL
        AND uploaded_by IS NOT NULL
        AND captured_at < now() - make_interval(mins => $1)
      ORDER BY uploaded_by, captured_at
      LIMIT $2`,
    [SETTLE_MINUTES, BATCH],
  );
  if (!photos.length) return 0;

  // `record_id IS NULL` above is what keeps this off files somebody placed by
  // hand. A photo uploaded from a property's own Files tab already knows where
  // it belongs; inferring a visit for it would be inventing a site trip that
  // never happened.

  const byUser = new Map<string, UnfiledPhoto[]>();
  for (const photo of photos) {
    const list = byUser.get(photo.uploaded_by);
    if (list) list.push(photo);
    else byUser.set(photo.uploaded_by, [photo]);
  }

  let filed = 0;
  for (const [userId, userPhotos] of byUser) {
    filed += await groupForUser(userId, userPhotos, conn);
  }

  if (filed) logger.info({ filed, users: byUser.size }, 'capture: grouped loose photos into shoots');
  return filed;
}

/**
 * Delete auto groups that have no photos left.
 *
 * They appear two ways: a late-syncing manual session took every photo back
 * (`matchOrphansForSession`), or somebody deleted the photos. Either way an
 * empty group is a row describing a visit that, as far as the evidence goes,
 * did not happen — and leaving it would put a shoot with nothing in it on the
 * review screen for somebody to puzzle over.
 *
 * Only ever auto and only ever unnamed. A manual session with no photos is
 * still a record that a person went somewhere, which is theirs to keep.
 */
async function pruneEmptyAutoShoots(conn: Tx): Promise<number> {
  const { rows } = await conn.query<{ id: string }>(
    `DELETE FROM ipy_shoot_session s
      WHERE s.origin = 'auto'
        AND s.record_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ipy_attachment a WHERE a.shoot_session_id = s.id)
      RETURNING s.id`,
  );
  if (rows.length) logger.debug({ removed: rows.length }, 'capture: pruned empty auto shoots');
  return rows.length;
}

async function groupForUser(userId: string, photos: UnfiledPhoto[], conn: Tx): Promise<number> {
  const first = photos[0]!.captured_at;
  const last = photos[photos.length - 1]!.captured_at;

  // The groups already standing that these photos could join. Restricted to
  // unnamed auto groups: a named one is a decision, and a manual session is
  // somebody's statement — neither may be widened by a straggler.
  const { rows: existing } = await conn.query<{ id: string; started_at: Date; ended_at: Date | null }>(
    `SELECT id, started_at, ended_at
       FROM ipy_shoot_session
      WHERE user_id = $1
        AND origin = 'auto'
        AND record_id IS NULL
        AND started_at <= $2
        AND COALESCE(ended_at, started_at) >= $3
      ORDER BY started_at`,
    [userId, new Date(last.getTime() + gapMs), new Date(first.getTime() - gapMs)],
  );

  const buckets: Bucket[] = existing.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? row.started_at,
    photoIds: [],
  }));

  for (const photo of photos) {
    const at = photo.captured_at.getTime();
    // Nearest, not first: a photo that lands between two groups belongs to the
    // one it is closer to. Deliberately no merging of the two — moving photos
    // between groups that already exist would silently undo a split somebody
    // may have made on purpose, and an over-split day is visible and fixable on
    // the review screen while a wrongly merged one is not.
    let best: Bucket | null = null;
    let bestDistance = Infinity;
    for (const bucket of buckets) {
      const distance = at < bucket.startedAt.getTime()
        ? bucket.startedAt.getTime() - at
        : at > bucket.endedAt.getTime() ? at - bucket.endedAt.getTime() : 0;
      if (distance <= gapMs && distance < bestDistance) {
        best = bucket;
        bestDistance = distance;
      }
    }

    if (best) {
      if (at < best.startedAt.getTime()) best.startedAt = photo.captured_at;
      if (at > best.endedAt.getTime()) best.endedAt = photo.captured_at;
      best.photoIds.push(photo.id);
    } else {
      buckets.push({
        id: null,
        startedAt: photo.captured_at,
        endedAt: photo.captured_at,
        photoIds: [photo.id],
      });
    }
  }

  let filed = 0;
  for (const bucket of buckets) {
    if (!bucket.photoIds.length) continue;
    const sessionId = bucket.id ?? await createAutoSession(userId, bucket, conn);
    if (!sessionId) continue;

    if (bucket.id) {
      // An existing group only ever grows, and only at the edges its new photos
      // pushed out to.
      await conn.query(
        `UPDATE ipy_shoot_session
            SET started_at = LEAST(started_at, $2),
                ended_at = GREATEST(COALESCE(ended_at, started_at), $3),
                updated_at = now()
          WHERE id = $1`,
        [sessionId, bucket.startedAt, bucket.endedAt],
      );
    }

    const { rows } = await conn.query<{ id: string }>(
      `UPDATE ipy_attachment
          SET shoot_session_id = $1
        WHERE id = ANY($2::uuid[])
          AND shoot_session_id IS NULL
        RETURNING id`,
      [sessionId, bucket.photoIds],
    );
    filed += rows.length;
  }

  return filed;
}

/**
 * `client_ref` is derived rather than random so the sweep is idempotent under a
 * crash: re-running after a partial write finds the group it already made
 * instead of minting a duplicate beside it.
 */
async function createAutoSession(userId: string, bucket: Bucket, conn: Tx): Promise<string | null> {
  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_shoot_session
       (user_id, started_at, ended_at, origin, status, client_ref)
     VALUES ($1, $2, $3, 'auto', 'ready', $4)
     ON CONFLICT (client_ref) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [userId, bucket.startedAt, bucket.endedAt, `auto:${userId}:${bucket.startedAt.toISOString()}`],
  );
  return row?.id ?? null;
}

export interface UnnamedShoot {
  id: string;
  origin: 'manual' | 'auto';
  startedAt: Date;
  endedAt: Date | null;
  mediaCount: number;
  /** A few attachment ids for the strip of thumbnails that makes it recognisable. */
  previewIds: string[];
  transcript: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * The evening list: everything shot that still has no property on it.
 *
 * Both origins appear. A manual session opened offline before its record
 * existed is just as nameless as an inferred group, and there is no reason to
 * make somebody visit two screens to fix the same thing.
 *
 * Groups with no photos are excluded — an auto group cannot exist without them,
 * but a manual tap with nothing behind it (opened at the gate, then the visit
 * fell through) is noise, not work.
 */
export async function listUnnamedShoots(
  userId: string,
  limit = 50,
  conn: Tx = db,
): Promise<UnnamedShoot[]> {
  const { rows } = await conn.query<{
    id: string; origin: 'manual' | 'auto'; started_at: Date; ended_at: Date | null;
    media_count: number; preview_ids: string[]; transcript: string | null;
    lat: string | null; lng: string | null;
  }>(
    `SELECT s.id, s.origin, s.started_at, s.ended_at, s.transcript, s.lat, s.lng,
            COUNT(a.id)::int AS media_count,
            (ARRAY_AGG(a.id ORDER BY a.captured_at NULLS LAST))[1:4] AS preview_ids
       FROM ipy_shoot_session s
       JOIN ipy_attachment a ON a.shoot_session_id = s.id
      WHERE s.user_id = $1
        AND s.record_id IS NULL
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT $2`,
    [userId, Math.min(limit, 200)],
  );

  return rows.map((r) => ({
    id: r.id,
    origin: r.origin,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    mediaCount: r.media_count,
    previewIds: r.preview_ids ?? [],
    transcript: r.transcript,
    lat: r.lat === null ? null : Number(r.lat),
    lng: r.lng === null ? null : Number(r.lng),
  }));
}

/**
 * Push a shoot's property down onto the photos already inside it.
 *
 * This is the step that was missing, and its absence is invisible until you
 * look for it. `matchAttachment` files a photo against the session it was shot
 * during and copies that session's `record_id` onto it — which is null when the
 * session has no property yet. Naming the session later updated the session row
 * and nothing else: `matchOrphansForSession` only ever considered photos with no
 * session at all, so a photo that had correctly joined the visit was the one
 * photo the naming could not reach. The visit read as named, the property's
 * Files tab stayed empty.
 *
 * It mattered rarely before, when the property was almost always named at the
 * gate. With inferred groups it is the only path there is: every one of them
 * starts nameless by definition.
 *
 * Photos already carrying a record keep it — somebody who filed one by hand has
 * said something more specific than this has.
 */
export async function attachShootMedia(
  sessionId: string,
  recordId: string,
  conn: Tx = db,
): Promise<number> {
  const { rows } = await conn.query<{ id: string }>(
    `UPDATE ipy_attachment
        SET record_id = $2
      WHERE shoot_session_id = $1 AND record_id IS NULL
      RETURNING id`,
    [sessionId, recordId],
  );
  return rows.length;
}

/**
 * Give a nameless shoot its property — the one action the evening screen has.
 *
 * Scoped to the shoot's own owner and refuses one that already has a property,
 * so a stale screen re-submitting cannot repoint a shoot somebody has since
 * named to something else.
 */
export async function nameShoot(
  sessionId: string,
  userId: string,
  recordId: string,
  conn: Tx = db,
): Promise<{ ok: boolean; photosAttached: number }> {
  const owned = await conn.queryOne<{ id: string }>(
    `UPDATE ipy_shoot_session
        SET record_id = $3,
            status = CASE WHEN status = 'capturing' THEN 'ready' ELSE status END,
            updated_at = now()
      WHERE id = $1 AND user_id = $2 AND record_id IS NULL
      RETURNING id`,
    [sessionId, userId, recordId],
  );
  if (!owned) return { ok: false, photosAttached: 0 };

  const photosAttached = await attachShootMedia(sessionId, recordId, conn);
  logger.info({ sessionId, recordId, photos: photosAttached }, 'capture: shoot named');
  return { ok: true, photosAttached };
}
