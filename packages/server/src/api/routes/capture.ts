/**
 * Site capture — what the phone talks to at the gate.
 *
 * One request does the whole tap: create the property if it is new, open the
 * session, record where and when. One round trip on purpose, because this is
 * used standing outside a builder floor in Greenfield where signal is a
 * rumour, and every extra round trip is another chance to half-succeed.
 *
 * Everything here is idempotent on `clientRef`, a UUID the device mints before
 * it queues the request. The capture screen writes to IndexedDB first and syncs
 * later, so a request will be retried — sometimes after it already succeeded
 * and the response was lost. Retrying must not produce a second visit or a
 * duplicate property.
 */
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { db, transaction } from '../../db/pool.js';
import { getDriver } from '../../core/storage/index.js';
import { buildStorageKey } from '../../core/storage/keys.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { canAccessRecord } from '../../core/permissions/index.js';
import { recordService } from '../../core/entity/recordService.js';
import {
  assignSessionRecord, currentSession, getSession, listSessions, openSession,
} from '../../core/capture/sessions.js';

export const captureRouter = Router();
captureRouter.use(requireAuth);

/**
 * A phone clock is not authoritative and a queued request can be old, but
 * neither justifies accepting a timestamp from next year — that would open a
 * session whose window swallows every photo ever uploaded afterwards.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60_000;

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/i;

/**
 * Disk-buffered, and capped well below the photo limit.
 *
 * A gate note is twenty seconds — a couple of hundred kilobytes. Anything
 * arriving here in the tens of megabytes is a misdirected video upload, and
 * accepting it would put a file the transcription provider will reject into a
 * queue that then retries it.
 */
const voiceUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const startSchema = z.object({
  /** Minted on the device before queueing. The idempotency key. */
  clientRef: z.string().min(8).max(64),
  startedAt: z.string().datetime({ offset: true }).optional(),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative().max(100_000).optional(),
  }).optional(),
  /** Point at an existing property… */
  recordId: z.string().uuid().optional(),
  /** …or hand over the values to create one. */
  property: z.object({
    module: z.string().min(1).default('properties'),
    values: z.record(z.unknown()),
  }).optional(),
  deviceLabel: z.string().max(80).optional(),
  notes: z.string().max(4000).optional(),
});

/**
 * Clamp a device-supplied start time into something a window can be built from.
 *
 * Deliberately clamps rather than rejects: a phone with a skewed clock should
 * still get its visit recorded, just anchored to a time the server will stand
 * behind. Losing the shoot because the handset was twenty minutes fast is a
 * worse outcome than a slightly wrong start.
 */
export function clampStartedAt(input: string | undefined, now = new Date()): Date {
  if (!input) return now;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return now;
  if (parsed.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) return now;
  if (parsed.getTime() < now.getTime() - MAX_BACKDATE_MS) return new Date(now.getTime() - MAX_BACKDATE_MS);
  return parsed;
}

/**
 * Start a visit.
 *
 * 201 with the session, or 200 with the existing one when this `clientRef` has
 * been seen — so the device can treat a replay as success rather than having to
 * reason about whether its earlier attempt landed.
 */
captureRouter.post('/sessions', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const input = startSchema.parse(req.body);

  if (input.recordId && input.property) {
    throw new BadRequestError('Send either recordId or property, not both');
  }

  // Checked before anything is created: a retry must not make a second
  // property, and must not close the visit that legitimately followed it.
  const replay = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_shoot_session WHERE client_ref = $1`, [input.clientRef],
  );
  if (replay) {
    res.status(200).json({ session: await getSession(replay.id), replayed: true });
    return;
  }

  if (input.recordId) {
    const owner = await db.queryOne<{ module_name: string }>(
      `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`, [input.recordId],
    );
    if (!owner) throw new NotFoundError('Property not found');
    if (!(await canAccessRecord(scope, owner.module_name, input.recordId, 'edit'))) {
      throw new ForbiddenError('You cannot capture against this property');
    }
  }

  const startedAt = clampStartedAt(input.startedAt);

  // Property and session in one transaction: a session pointing at a property
  // that failed to save, or a property with no visit attached, are both worse
  // than the request simply failing and being retried from the queue.
  const session = await transaction(async (tx) => {
    let recordId = input.recordId ?? null;
    if (input.property) {
      const created = await recordService.createRecord(
        scope, input.property.module, input.property.values, { conn: tx },
      );
      recordId = created.id;
    }
    return openSession({
      userId: user.id,
      clientRef: input.clientRef,
      recordId,
      startedAt,
      lat: input.location?.lat ?? null,
      lng: input.location?.lng ?? null,
      accuracyM: input.location?.accuracy ?? null,
      deviceLabel: input.deviceLabel ?? null,
      notes: input.notes ?? null,
    }, tx);
  });

  res.status(201).json({ session, replayed: false });
}));

/** What this user is shooting into right now — how the screen knows to say "in progress". */
captureRouter.get('/sessions/current', asyncHandler(async (req, res) => {
  res.json({ session: await currentSession(getUser(req).id) });
}));

/** The evening review list. */
captureRouter.get('/sessions', asyncHandler(async (req, res) => {
  const status = req.query.status as 'capturing' | 'ready' | 'reviewed' | undefined;
  res.json(await listSessions(getUser(req).id, {
    limit: Number(req.query.limit) || 50,
    status: status && ['capturing', 'ready', 'reviewed'].includes(status) ? status : undefined,
  }));
}));

captureRouter.get('/sessions/:id', asyncHandler(async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session || session.userId !== getUser(req).id) throw new NotFoundError('Session not found');
  res.json(session);
}));

/**
 * Attach the voice note recorded at the gate.
 *
 * Separate from starting the visit, and deliberately so: the tap must land even
 * with no signal, and a twenty-second audio clip is a hundred times the payload
 * of the visit itself. Sending them together would make the one thing that must
 * not fail depend on the one most likely to.
 *
 * Transcription happens later, on the scheduler — the phone is not kept waiting
 * on a speech-to-text provider while somebody is walking into a property.
 */
captureRouter.post('/sessions/:id/voice', voiceUpload.single('audio'), asyncHandler(async (req, res) => {
  const user = getUser(req);
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('No audio uploaded');

  const session = await getSession(req.params.id);
  if (!session || session.userId !== user.id) {
    await unlink(file.path).catch(() => undefined);
    throw new NotFoundError('Session not found');
  }
  if (!file.mimetype.startsWith('audio/') && !file.mimetype.startsWith('video/')) {
    // iOS records into an mp4 container, which some browsers report as video/*.
    await unlink(file.path).catch(() => undefined);
    throw new BadRequestError('That does not look like an audio recording');
  }

  const ext = extname(file.originalname).toLowerCase();
  const key = await buildStorageKey({
    recordId: session.recordId,
    originalName: `voice-note${SAFE_EXT.test(ext) ? ext : '.m4a'}`,
    ext: SAFE_EXT.test(ext) ? ext : '.m4a',
  });

  const driver = await getDriver();
  await driver.save(key, createReadStream(file.path), file.mimetype);
  await unlink(file.path).catch(() => undefined);

  const attachment = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, category, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,'voice_note',$6) RETURNING id`,
    [session.recordId, `voice-note${SAFE_EXT.test(ext) ? ext : '.m4a'}`, file.mimetype, file.size, key, user.id],
  );

  // Replacing a note leaves the old audio in storage on purpose — it is the
  // only copy of something somebody said once, and orphaning it is recoverable
  // where deleting it is not.
  await db.query(
    `UPDATE ipy_shoot_session
        SET voice_note_id = $2, voice_status = 'pending', voice_attempts = 0,
            voice_error = NULL, updated_at = now()
      WHERE id = $1`,
    [req.params.id, attachment!.id],
  );

  res.status(201).json({ voiceNoteId: attachment!.id, session: await getSession(req.params.id) });
}));

/**
 * Attach a visit to the property it turned out to be about.
 *
 * The offline path arrives in this order: the tap happens at the gate with no
 * signal and no record, and both are reconciled on sync.
 */
captureRouter.patch('/sessions/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const { recordId } = z.object({ recordId: z.string().uuid() }).parse(req.body);

  const session = await getSession(req.params.id);
  if (!session || session.userId !== user.id) throw new NotFoundError('Session not found');

  const owner = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`, [recordId],
  );
  if (!owner) throw new NotFoundError('Property not found');
  if (!(await canAccessRecord(scope, owner.module_name, recordId, 'edit'))) {
    throw new ForbiddenError('You cannot capture against this property');
  }

  res.json(await assignSessionRecord(req.params.id, recordId));
}));
