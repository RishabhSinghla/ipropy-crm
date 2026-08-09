/**
 * The companion app's endpoint.
 *
 * Mounted outside `requireAuth`: a phone syncing in the background has a device
 * token, not a user session. Sessions expire in hours and refresh in a browser;
 * a background sync cannot re-authenticate a person at 6am, so it carries its
 * own long-lived credential which the user can revoke from Settings.
 *
 * Deliberately tiny. The app is the hardest thing in this system to update — it
 * needs a rebuild, a re-install and a person holding the phone — so it does as
 * little thinking as possible and this end does the rest.
 */
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { BadRequestError } from '../../utils/errors.js';
import {
  attachRecording, authenticateDevice, syncCalls, type DeviceCallEntry,
} from '../../integrations/telephony/deviceSync.js';

export const deviceRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
});

/**
 * Its own budget, keyed on the device token.
 *
 * The general per-user limiter would key every phone in the office to the same
 * bucket during a first-run backfill — thirty handsets uploading a year of call
 * history at once is exactly the case that has to work.
 */
const deviceLimit = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `dev:${bearer(req.headers.authorization) ?? req.ip ?? 'unknown'}`,
});
deviceRouter.use(deviceLimit);

function bearer(header: string | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Called on app start to confirm the token still works and show who it belongs to. */
deviceRouter.get('/ping', asyncHandler(async (req, res) => {
  const device = await authenticateDevice(bearer(req.headers.authorization) ?? undefined);
  res.json({ ok: true, deviceId: device.id, userId: device.userId });
}));

const entrySchema = z.object({
  externalId: z.string().min(1).max(64),
  number: z.string().max(32),
  type: z.number().int().min(0).max(10),
  timestamp: z.number().int().positive(),
  durationSeconds: z.number().int().min(0).max(86_400),
  contactName: z.string().max(120).nullable().optional(),
});

deviceRouter.post('/calls', asyncHandler(async (req, res) => {
  const device = await authenticateDevice(bearer(req.headers.authorization) ?? undefined);

  const input = z.object({
    appVersion: z.string().max(20).optional(),
    // Capped so one runaway batch cannot hold a connection for minutes. The
    // app pages through a first-run backfill rather than sending it all at once.
    entries: z.array(entrySchema).max(500),
  }).parse(req.body);

  if (input.appVersion) {
    const { db } = await import('../../db/pool.js');
    await db.query(`UPDATE ipy_device SET app_version = $2 WHERE id = $1`, [device.id, input.appVersion]);
  }

  res.json(await syncCalls(device, input.entries as DeviceCallEntry[]));
}));

deviceRouter.post('/recordings', upload.single('audio'), asyncHandler(async (req, res) => {
  const device = await authenticateDevice(bearer(req.headers.authorization) ?? undefined);

  const input = z.object({ externalId: z.string().min(1).max(64) }).parse(req.body);
  const file = req.file;
  if (!file) throw new BadRequestError('No audio file uploaded');

  const result = await attachRecording({
    device,
    externalId: input.externalId,
    audio: file.buffer,
    mimeType: file.mimetype || 'audio/mpeg',
    fileName: file.originalname || 'recording',
  });

  // A recording with no matching call is not an error the phone can act on —
  // the call row may simply not have synced yet. Told plainly so the app can
  // keep the file and retry rather than deleting it.
  res.json(result.callId ? { ok: true, callId: result.callId } : { ok: false, reason: 'no_matching_call' });
}));
