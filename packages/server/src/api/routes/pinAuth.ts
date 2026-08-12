/**
 * Fast four-digit unlock for one explicitly trusted browser/device.
 *
 * The PIN is not an account password. Sign-in requires both the PIN and a
 * random 256-bit HttpOnly cookie installed during an authenticated enrolment.
 * The database stores only hashes of both, so a database leak cannot be used
 * to try all 10,000 PINs offline. Five failures lock only that device.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, queryOne, transaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getUser, requireAuth, verifyPassword } from '../../middleware/auth.js';
import { issueSession } from '../../core/auth/session.js';
import {
  clearPinDeviceCookie, hashDevicePin, PIN_DEVICE_DAYS, pinDeviceToken,
  pinDeviceTokenHash, pinIsTooCommon, setPinDeviceCookie, verifyDevicePin,
} from '../../core/auth/devicePin.js';
import { NotFoundError, RateLimitError, UnauthorizedError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export const pinAuthRouter = Router();

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.security.loginRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Try again in a few minutes.' },
});

const pinSchema = z.string().regex(/^\d{4}$/, 'Enter exactly four digits');
const enrolSchema = z.object({
  pin: pinSchema,
  currentPassword: z.string().min(1),
  label: z.string().trim().min(1).max(80).optional(),
});

interface PinDeviceRow {
  id: string;
  user_id: string;
  pin_hash: string;
  failed_attempts: number;
  locked_until: string | null;
}

pinAuthRouter.get('/status', asyncHandler(async (req, res) => {
  const rawToken = pinDeviceToken(req);
  if (!rawToken) { res.json({ available: false }); return; }

  const device = await queryOne<{
    label: string | null; first_name: string; locked_until: string | null;
  }>(
    `SELECT d.label, u.first_name, d.locked_until
       FROM ipy_pin_device d
       JOIN ipy_user u ON u.id = d.user_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND d.expires_at > now()
        AND u.deleted_at IS NULL AND u.is_active = true`,
    [pinDeviceTokenHash(rawToken)],
  );

  if (!device) {
    clearPinDeviceCookie(res);
    res.json({ available: false });
    return;
  }

  res.json({
    available: true,
    label: device.label,
    userHint: device.first_name,
    lockedUntil: device.locked_until,
  });
}));

pinAuthRouter.post('/enrol', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = enrolSchema.parse(req.body);
  if (pinIsTooCommon(input.pin)) {
    throw new ValidationError('Choose a less common four-digit PIN');
  }

  // Setting a durable quick-unlock credential is sensitive: an unattended,
  // already-open browser must not be able to silently enrol itself.
  const account = await queryOne<{ password_hash: string | null }>(
    `SELECT password_hash FROM ipy_user WHERE id = $1 AND deleted_at IS NULL AND is_active = true`,
    [user.id],
  );
  if (!account?.password_hash || !(await verifyPassword(input.currentPassword, account.password_hash))) {
    throw new UnauthorizedError('Current password is incorrect');
  }

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = pinDeviceTokenHash(rawToken);
  const pinHash = await hashDevicePin(rawToken, input.pin);
  const previousToken = pinDeviceToken(req);

  await transaction(async (tx) => {
    // Re-enrolling this browser replaces its previous PIN without affecting
    // the same person's phone or another trusted browser.
    if (previousToken) {
      await tx.query(
        `UPDATE ipy_pin_device SET revoked_at = now()
          WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL`,
        [user.id, pinDeviceTokenHash(previousToken)],
      );
    }

    await tx.query(
      `INSERT INTO ipy_pin_device
         (user_id, token_hash, pin_hash, label, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        user.id,
        tokenHash,
        pinHash,
        input.label ?? null,
        new Date(Date.now() + PIN_DEVICE_DAYS * 86_400_000),
      ],
    );

    // A forgotten old browser should not remain trusted forever. Keep the ten
    // newest active devices and revoke anything older.
    await tx.query(
      `UPDATE ipy_pin_device SET revoked_at = now()
        WHERE id IN (
          SELECT id FROM ipy_pin_device
           WHERE user_id = $1 AND revoked_at IS NULL
           ORDER BY created_at DESC OFFSET 10
        )`,
      [user.id],
    );
  });

  setPinDeviceCookie(res, rawToken);
  res.status(201).json({ ok: true });
}));

pinAuthRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const current = pinDeviceToken(req);
  const currentHash = current ? pinDeviceTokenHash(current) : null;
  const devices = await db.query<{
    id: string; token_hash: string; label: string | null; created_at: string;
    last_used_at: string | null; expires_at: string; locked_until: string | null;
  }>(
    `SELECT id, token_hash, label, created_at, last_used_at, expires_at, locked_until
       FROM ipy_pin_device
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [getUser(req).id],
  );
  res.json(devices.rows.map(({ token_hash, ...device }) => ({
    ...device,
    is_current: token_hash === currentHash,
  })));
}));

pinAuthRouter.post('/login', pinLimiter, asyncHandler(async (req, res) => {
  const { pin } = z.object({ pin: pinSchema }).parse(req.body);
  const rawToken = pinDeviceToken(req);
  if (!rawToken) throw new UnauthorizedError('PIN sign-in is unavailable on this device');
  const tokenHash = pinDeviceTokenHash(rawToken);

  const result = await transaction(async (tx): Promise<
    { state: 'ok'; userId: string } | { state: 'wrong' | 'locked' | 'missing'; deviceId?: string; userId?: string }
  > => {
    const device = await tx.queryOne<PinDeviceRow>(
      `SELECT d.id, d.user_id, d.pin_hash, d.failed_attempts, d.locked_until
         FROM ipy_pin_device d
         JOIN ipy_user u ON u.id = d.user_id
        WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND d.expires_at > now()
          AND u.deleted_at IS NULL AND u.is_active = true
        FOR UPDATE OF d`,
      [tokenHash],
    );
    if (!device) return { state: 'missing' };

    if (device.locked_until && new Date(device.locked_until).getTime() > Date.now()) {
      return { state: 'locked', deviceId: device.id, userId: device.user_id };
    }

    const matches = await verifyDevicePin(rawToken, pin, device.pin_hash);
    if (!matches) {
      const attempts = device.failed_attempts + 1;
      const lock = attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
      await tx.query(
        `UPDATE ipy_pin_device
            SET failed_attempts = $2, locked_until = $3, last_failed_at = now()
          WHERE id = $1`,
        [device.id, attempts >= 5 ? 0 : attempts, lock],
      );
      return { state: lock ? 'locked' : 'wrong', deviceId: device.id, userId: device.user_id };
    }

    await tx.query(
      `UPDATE ipy_pin_device
          SET failed_attempts = 0, locked_until = NULL, last_used_at = now()
        WHERE id = $1`,
      [device.id],
    );
    return { state: 'ok', userId: device.user_id };
  });

  if (result.state !== 'ok') {
    logger.warn({ deviceId: result.deviceId, userId: result.userId, state: result.state }, 'trusted-device PIN sign-in rejected');
    if (result.state === 'missing') clearPinDeviceCookie(res);
    if (result.state === 'locked') {
      throw new RateLimitError('This device is temporarily locked. Use your password or passkey, or try again in 15 minutes.');
    }
    throw new UnauthorizedError(result.state === 'missing'
      ? 'PIN sign-in is unavailable on this device'
      : 'Incorrect PIN');
  }

  res.json(await issueSession(result.userId, req));
}));

pinAuthRouter.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const current = pinDeviceToken(req);
  const removed = await queryOne<{ token_hash: string }>(
    `UPDATE ipy_pin_device SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING token_hash`,
    [req.params.id, getUser(req).id],
  );
  if (!removed) throw new NotFoundError('Trusted device not found');
  if (current && removed.token_hash === pinDeviceTokenHash(current)) clearPinDeviceCookie(res);
  res.json({ ok: true });
}));
