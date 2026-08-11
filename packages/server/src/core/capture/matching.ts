/**
 * Filing an uploaded photo against the visit it was shot on.
 *
 * The last link in the chain. A visit records that B-110 was being photographed
 * between 09:03 and 09:18; a photo records that it was taken at 09:07. Putting
 * those together is the whole trick, and it is why the property never has to be
 * chosen again after the gate.
 *
 * Time, not location. GPS is on the visit and useful for review, but it cannot
 * name a property: adjacent builder floors in Greenfield are ten to twenty
 * metres apart, well inside a phone fix's error. The clock is exact.
 *
 * Two things this deliberately will not do:
 *
 * It never overrides an explicit choice. A file uploaded from a property's own
 * Files tab already knows where it belongs; inference must not second-guess
 * somebody who told us directly.
 *
 * It never guesses a capture time. A file with no EXIF gets no session — see
 * captureTime.ts. Filing it by upload time would attach it confidently to
 * whichever property was being visited when it happened to sync.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { sessionForCapture } from './sessions.js';

export interface MatchResult {
  capturedAt: Date | null;
  sessionId: string | null;
  /** True when the photo also gained the property it belongs to. */
  attachedToRecord: boolean;
}

/**
 * Record when an attachment was taken, and file it against the matching visit.
 *
 * Safe to run more than once: the media queue retries, and re-running simply
 * arrives at the same answer. The record is only ever filled in when it was
 * empty, so a second pass cannot move a photo somebody has since placed by hand.
 */
export async function matchAttachment(attachmentId: string, capturedAt: Date | null): Promise<MatchResult> {
  const attachment = await db.queryOne<{
    uploaded_by: string | null;
    record_id: string | null;
    shoot_session_id: string | null;
  }>(
    `SELECT uploaded_by, record_id, shoot_session_id FROM ipy_attachment WHERE id = $1`,
    [attachmentId],
  );
  if (!attachment) return { capturedAt: null, sessionId: null, attachedToRecord: false };

  // Worth storing on its own even when nothing matches: it is what sorts a
  // gallery into the order things were actually shot, rather than the order
  // they finished uploading.
  await db.query(`UPDATE ipy_attachment SET captured_at = $2 WHERE id = $1`, [attachmentId, capturedAt]);

  if (!capturedAt || !attachment.uploaded_by || attachment.shoot_session_id) {
    return { capturedAt, sessionId: attachment.shoot_session_id, attachedToRecord: false };
  }

  const session = await sessionForCapture(attachment.uploaded_by, capturedAt);
  if (!session) return { capturedAt, sessionId: null, attachedToRecord: false };

  // `record_id IS NULL` in the WHERE, not a branch above it: two photos from the
  // same burst are processed concurrently by the queue, and the guard belongs
  // where the write happens rather than a read earlier.
  const linked = await db.queryOne<{ id: string }>(
    `UPDATE ipy_attachment
        SET shoot_session_id = $2,
            record_id = CASE WHEN record_id IS NULL THEN $3 ELSE record_id END
      WHERE id = $1
      RETURNING id`,
    [attachmentId, session.id, session.recordId],
  );

  const attachedToRecord = Boolean(linked && !attachment.record_id && session.recordId);
  logger.debug(
    { attachmentId, sessionId: session.id, attachedToRecord },
    'capture: photo filed against a visit',
  );
  return { capturedAt, sessionId: session.id, attachedToRecord };
}

/**
 * Re-run matching for photos that arrived before their visit did.
 *
 * The offline case, and it is not rare: the phone uploads photos over wi-fi at
 * the office while the visit that explains them is still sitting in the capture
 * queue. Those photos are processed with no session to find. When the visit
 * finally syncs, this picks them back up.
 *
 * Scoped to the visit's own window and user, so it can only ever claim photos
 * that were genuinely taken during it.
 *
 * It also takes photos back off an unnamed auto group (see grouping.ts). Those
 * groups are a guess about where one visit ended and the next began; this
 * session is somebody's statement that they were at a named property between
 * two times. The statement wins. A group that has already been given a property
 * is off-limits — that is a decision, not a guess — as is any photo somebody
 * filed by hand, which `record_id IS NULL` in the SET already protects.
 */
export async function matchOrphansForSession(sessionId: string): Promise<number> {
  const session = await db.queryOne<{
    user_id: string; record_id: string | null; started_at: Date; ended_at: Date | null;
  }>(
    `SELECT user_id, record_id, started_at, ended_at FROM ipy_shoot_session WHERE id = $1`,
    [sessionId],
  );
  if (!session) return 0;

  const { rows } = await db.query<{ id: string }>(
    `UPDATE ipy_attachment a
        SET shoot_session_id = $1,
            record_id = CASE WHEN a.record_id IS NULL THEN $2 ELSE a.record_id END
      WHERE a.uploaded_by = $3
        AND a.captured_at IS NOT NULL
        AND a.captured_at >= $4
        AND ($5::timestamptz IS NULL OR a.captured_at <= $5)
        AND a.shoot_session_id IS DISTINCT FROM $1
        AND (
          a.shoot_session_id IS NULL
          OR EXISTS (
            SELECT 1 FROM ipy_shoot_session g
             WHERE g.id = a.shoot_session_id
               AND g.origin = 'auto'
               AND g.record_id IS NULL
          )
        )
      RETURNING a.id`,
    [sessionId, session.record_id, session.user_id, session.started_at, session.ended_at],
  );

  if (rows.length) logger.info({ sessionId, claimed: rows.length }, 'capture: orphaned photos filed against a visit');
  return rows.length;
}
