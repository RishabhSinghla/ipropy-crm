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
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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
  keyGenerator: (req) => {
    const token = bearer(req.headers.authorization);
    if (token) return `dev:t:${token}`;
    return `dev:ip:${req.ip ? ipKeyGenerator(req.ip) : 'unknown'}`;
  },
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

  const now = Date.now();
  const oldest = now - 10 * 365 * 24 * 60 * 60 * 1000;
  if (input.entries.some((entry) => entry.timestamp > now + 5 * 60_000 || entry.timestamp < oldest)) {
    throw new BadRequestError('One or more call timestamps are outside the supported range');
  }

  if (input.appVersion) {
    const { db } = await import('../../db/pool.js');
    await db.query(`UPDATE ipy_device SET app_version = $2 WHERE id = $1`, [device.id, input.appVersion]);
  }

  res.json(await syncCalls(device, input.entries as DeviceCallEntry[]));
}));

/**
 * What the phone should be doing right now.
 *
 * The app asks rather than decides, and every answer here is a setting the
 * owner controls. That matters because the app is the hardest thing in this
 * system to change: a rebuild, a re-install, and somebody holding the handset.
 * A rep on last month's build still has to be switchable from the CRM.
 */
deviceRouter.get('/policy', asyncHandler(async (req, res) => {
  await authenticateDevice(bearer(req.headers.authorization) ?? undefined);
  const { currentPolicy } = await import('../../core/locations/index.js');
  const policy = await currentPolicy();
  res.json({
    location: policy,
    // Room to add the next thing the phone has to be told without shipping an
    // app that knows about it in advance.
  });
}));

const fixSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Unix milliseconds when the phone took the fix, not when it sent it. */
  recordedAt: z.number().int().positive(),
  accuracyM: z.number().min(0).max(100_000).nullable().optional(),
  speedMps: z.number().min(0).max(400).nullable().optional(),
  batteryPct: z.number().int().min(0).max(100).nullable().optional(),
});

/**
 * A batch of positions from one handset.
 *
 * Batched because a phone in a lift or a basement has no signal for twenty
 * minutes and then has all of it at once, and because one request an hour costs
 * far less battery than six.
 */
deviceRouter.post('/locations', asyncHandler(async (req, res) => {
  const device = await authenticateDevice(bearer(req.headers.authorization) ?? undefined);
  const input = z.object({
    fixes: z.array(fixSchema).max(500),
  }).parse(req.body);

  const { recordFixes } = await import('../../core/locations/index.js');
  const result = await recordFixes(device.userId, device.id, input.fixes);
  // 200 with a reason rather than an error when the feature is off: the phone
  // needs to stop sending, not to retry for ever.
  res.json(result);
}));

deviceRouter.post('/recordings', upload.single('audio'), asyncHandler(async (req, res) => {
  const device = await authenticateDevice(bearer(req.headers.authorization) ?? undefined);

  const input = z.object({ externalId: z.string().min(1).max(64) }).parse(req.body);
  const file = req.file;
  if (!file) throw new BadRequestError('No audio file uploaded');
  if (!file.mimetype.startsWith('audio/')) throw new BadRequestError('The recording must be an audio file');

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
