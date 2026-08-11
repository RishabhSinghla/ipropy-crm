/**
 * Site-visit capture sessions.
 *
 * One tap at the gate opens a session against a property; every photo shot
 * afterwards belongs to it until the next one opens. That is the whole idea —
 * the property's identity is bound once, at the only moment somebody actually
 * knows it, instead of being reconstructed from a camera roll that evening.
 *
 * Three rules the design turns on:
 *
 * There is no "finish" button. Nobody presses it reliably after ten visits, and
 * a session left open until midnight would swallow the next property's photos.
 * A session closes when the next one opens, or when the sweep decides it has
 * gone quiet — see `closeStaleSessions`.
 *
 * Opening is idempotent. The capture screen writes to IndexedDB first and syncs
 * when there is signal, because these sites often have none. A queued request
 * gets retried, sometimes after it already succeeded, so `client_ref` (minted
 * on the device) makes asking twice safe.
 *
 * Time decides which session a photo belongs to; the person decides which
 * property a session is. GPS is recorded for grouping and review, never for
 * identification: adjacent builder floors are well inside a phone fix's error.
 */
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * How long an open session survives without being closed by a new one.
 *
 * Long enough to cover a thorough walkthrough with a chatty owner, short enough
 * that forgetting about it does not attach the evening's photos to the morning's
 * property. Sessions are cheap to re-open and expensive to un-mix.
 */
export const SESSION_IDLE_MINUTES = 90;

export interface ShootSession {
  id: string;
  recordId: string | null;
  userId: string;
  startedAt: Date;
  endedAt: Date | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  status: 'capturing' | 'ready' | 'reviewed';
  transcript: string | null;
  parsed: Record<string, unknown>;
  clientRef: string;
  deviceLabel: string | null;
  notes: string | null;
  /** The attachment holding what was said at the gate, once one exists. */
  voiceNoteId: string | null;
  voiceStatus: 'none' | 'pending' | 'done' | 'failed';
}

interface Row {
  id: string;
  record_id: string | null;
  user_id: string;
  started_at: Date;
  ended_at: Date | null;
  lat: string | number | null;
  lng: string | number | null;
  accuracy_m: string | number | null;
  status: 'capturing' | 'ready' | 'reviewed';
  transcript: string | null;
  parsed: Record<string, unknown>;
  client_ref: string;
  device_label: string | null;
  notes: string | null;
  voice_note_id: string | null;
  voice_status: 'none' | 'pending' | 'done' | 'failed';
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

function toSession(row: Row): ShootSession {
  return {
    id: row.id,
    recordId: row.record_id,
    userId: row.user_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lat: num(row.lat),
    lng: num(row.lng),
    accuracyM: num(row.accuracy_m),
    status: row.status,
    transcript: row.transcript,
    parsed: row.parsed ?? {},
    clientRef: row.client_ref,
    deviceLabel: row.device_label,
    notes: row.notes,
    voiceNoteId: row.voice_note_id,
    voiceStatus: row.voice_status,
  };
}

const COLUMNS = `id, record_id, user_id, started_at, ended_at, lat, lng, accuracy_m,
                 status, transcript, parsed, client_ref, device_label, notes,
                 voice_note_id, voice_status`;

export interface OpenSessionInput {
  userId: string;
  clientRef: string;
  recordId?: string | null;
  /** When the tap actually happened, which is not when it reached us if it was queued. */
  startedAt?: Date;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  deviceLabel?: string | null;
  notes?: string | null;
}

/**
 * Open a session, closing whatever this user had open.
 *
 * Returns the existing row unchanged when `client_ref` has been seen before, so
 * a retry from the offline queue is a no-op rather than a second visit — and
 * crucially does not re-close the session the retry's predecessor opened.
 */
export async function openSession(input: OpenSessionInput, conn: Tx = db): Promise<ShootSession> {
  const existing = await conn.queryOne<Row>(
    `SELECT ${COLUMNS} FROM ipy_shoot_session WHERE client_ref = $1`,
    [input.clientRef],
  );
  if (existing) return toSession(existing);

  const startedAt = input.startedAt ?? new Date();

  // Close the previous visit at this one's start, not at now(): if this request
  // sat in the offline queue for three hours, "now" would stretch the previous
  // session over this visit and both would claim the same photos.
  await closeOpenSessions(input.userId, startedAt, conn);

  const row = await conn.queryOne<Row>(
    `INSERT INTO ipy_shoot_session
       (record_id, user_id, started_at, lat, lng, accuracy_m, client_ref, device_label, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING ${COLUMNS}`,
    [
      input.recordId ?? null, input.userId, startedAt,
      input.lat ?? null, input.lng ?? null, input.accuracyM ?? null,
      input.clientRef, input.deviceLabel ?? null, input.notes ?? null,
    ],
  );
  return toSession(row!);
}

/**
 * Close every open session for a user at `at`.
 *
 * Guards against a zero-or-negative-length window: a queued request whose
 * `startedAt` predates a session already open would otherwise produce
 * `ended_at < started_at`, and the match query would find a range that contains
 * no instant at all.
 */
export async function closeOpenSessions(userId: string, at: Date, conn: Tx = db): Promise<number> {
  const { rows } = await conn.query<{ id: string }>(
    `UPDATE ipy_shoot_session
        SET ended_at = GREATEST($2::timestamptz, started_at),
            status = CASE WHEN status = 'capturing' THEN 'ready' ELSE status END,
            updated_at = now()
      WHERE user_id = $1 AND ended_at IS NULL
      RETURNING id`,
    [userId, at],
  );
  return rows.length;
}

/** The session this user is currently shooting into, if any. */
export async function currentSession(userId: string, conn: Tx = db): Promise<ShootSession | null> {
  const row = await conn.queryOne<Row>(
    `SELECT ${COLUMNS} FROM ipy_shoot_session
      WHERE user_id = $1 AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`,
    [userId],
  );
  return row ? toSession(row) : null;
}

export async function getSession(id: string, conn: Tx = db): Promise<ShootSession | null> {
  const row = await conn.queryOne<Row>(`SELECT ${COLUMNS} FROM ipy_shoot_session WHERE id = $1`, [id]);
  return row ? toSession(row) : null;
}

/**
 * Attach a session to the property record it turned out to be about.
 *
 * Separate from opening because the offline case runs in this order: the tap
 * happens at the gate with no signal, the record is created on sync, and only
 * then is there an id to point at.
 */
export async function assignSessionRecord(id: string, recordId: string, conn: Tx = db): Promise<ShootSession | null> {
  const row = await conn.queryOne<Row>(
    `UPDATE ipy_shoot_session SET record_id = $2, updated_at = now()
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, recordId],
  );
  return row ? toSession(row) : null;
}

/**
 * Close sessions nobody has closed by starting another one.
 *
 * The backstop for the day's last visit — there is no next session to close it,
 * so without this it stays open forever and keeps claiming photos. Run from the
 * scheduler.
 */
export async function closeStaleSessions(conn: Tx = db): Promise<number> {
  const { rows } = await conn.query<{ id: string }>(
    `UPDATE ipy_shoot_session
        SET ended_at = started_at + make_interval(mins => $1),
            status = CASE WHEN status = 'capturing' THEN 'ready' ELSE status END,
            updated_at = now()
      WHERE ended_at IS NULL
        AND started_at < now() - make_interval(mins => $1)
      RETURNING id`,
    [SESSION_IDLE_MINUTES],
  );
  if (rows.length) logger.info({ closed: rows.length }, 'capture: closed stale shoot sessions');
  return rows.length;
}

/**
 * The session a photo taken at `capturedAt` belongs to.
 *
 * An open session has no upper bound yet, so it matches anything after its
 * start — that is deliberate: photos from the visit in progress should attach
 * as they arrive, not wait for the session to close.
 */
export async function sessionForCapture(
  userId: string,
  capturedAt: Date,
  conn: Tx = db,
): Promise<ShootSession | null> {
  const row = await conn.queryOne<Row>(
    `SELECT ${COLUMNS} FROM ipy_shoot_session
      WHERE user_id = $1
        AND started_at <= $2
        AND (ended_at IS NULL OR ended_at >= $2)
      ORDER BY started_at DESC LIMIT 1`,
    [userId, capturedAt],
  );
  return row ? toSession(row) : null;
}

/** A user's visits, newest first — the evening review list. */
export async function listSessions(
  userId: string,
  opts: { limit?: number; status?: ShootSession['status'] } = {},
  conn: Tx = db,
): Promise<(ShootSession & { mediaCount: number; recordLabel: string | null })[]> {
  const { rows } = await conn.query<Row & { media_count: number; record_label: string | null }>(
    `SELECT ${COLUMNS.split(',').map((c) => `s.${c.trim()}`).join(', ')},
            (SELECT COUNT(*)::int FROM ipy_attachment a WHERE a.shoot_session_id = s.id) AS media_count,
            r.label AS record_label
       FROM ipy_shoot_session s
       LEFT JOIN ipy_record r ON r.id = s.record_id
      WHERE s.user_id = $1
        AND ($2::text IS NULL OR s.status = $2)
      ORDER BY s.started_at DESC
      LIMIT $3`,
    [userId, opts.status ?? null, Math.min(opts.limit ?? 50, 200)],
  );
  return rows.map((r) => ({
    ...toSession(r),
    mediaCount: r.media_count,
    recordLabel: r.record_label,
  }));
}
