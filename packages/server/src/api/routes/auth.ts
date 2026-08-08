import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { db, queryOne } from '../../db/pool.js';
import { config } from '../../config.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  getUser, hashPassword, loadUser, requireAuth, signAccessToken, verifyPassword,
} from '../../middleware/auth.js';
import { BadRequestError, UnauthorizedError, ValidationError } from '../../utils/errors.js';
import { getSubordinateUserIds } from '../../core/permissions/index.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Try again in a few minutes.' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function refreshExpiry(): Date {
  const spec = config.auth.refreshExpiresIn;
  const m = spec.match(/^(\d+)([smhd])$/);
  const ms = m
    ? Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] ?? 86_400_000)
    : 30 * 86_400_000;
  return new Date(Date.now() + ms);
}

authRouter.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const row = await queryOne<{ id: string; password_hash: string | null; is_active: boolean }>(
    `SELECT id, password_hash, is_active FROM ipy_user WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email],
  );

  // Same message either way so the endpoint can't be used to enumerate accounts.
  if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
    throw new UnauthorizedError('Incorrect email or password');
  }
  if (!row.is_active) throw new UnauthorizedError('This account has been deactivated');

  const user = await loadUser(row.id);
  if (!user) throw new UnauthorizedError('Account not found');

  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await db.query(
    `INSERT INTO ipy_session (user_id, refresh_token, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [user.id, refreshToken, req.headers['user-agent'] ?? null, req.ip ?? null, refreshExpiry()],
  );
  await db.query(`UPDATE ipy_user SET last_login_at = now() WHERE id = $1`, [user.id]);

  res.json({
    token: signAccessToken(user),
    refreshToken,
    user: { ...user, subordinateIds: await getSubordinateUserIds(user) },
  });
}));

authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const token = z.object({ refreshToken: z.string().min(10) }).parse(req.body).refreshToken;
  const session = await queryOne<{ user_id: string; expires_at: string; revoked_at: string | null }>(
    `SELECT user_id, expires_at, revoked_at FROM ipy_session WHERE refresh_token = $1`,
    [token],
  );
  if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
    throw new UnauthorizedError('Session expired — please sign in again');
  }
  const user = await loadUser(session.user_id);
  if (!user?.isActive) throw new UnauthorizedError('Account is unavailable');
  res.json({ token: signAccessToken(user), user });
}));

authRouter.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  const token = (req.body as { refreshToken?: string })?.refreshToken;
  if (token) {
    await db.query(`UPDATE ipy_session SET revoked_at = now() WHERE refresh_token = $1`, [token]);
  } else {
    await db.query(`UPDATE ipy_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [getUser(req).id]);
  }
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  res.json({ ...user, subordinateIds: await getSubordinateUserIds(user) });
}));

const preferencesSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  /**
   * An uploaded avatar lives at `/api/files/<id>`, which `.url()` rejects for
   * not being absolute. Both forms are allowed, but only `http(s)` and our own
   * path — this value is rendered into an `<img src>`, where a `javascript:`
   * or `data:` URL would be an injection point that every user can set on
   * themselves.
   */
  avatarUrl: z.string()
    .refine((v) => /^\/api\/files\/[\w-]+$/.test(v) || /^https?:\/\//i.test(v),
      'Must be an uploaded file or an http(s) URL')
    .nullable().optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  currency: z.string().length(3).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  defaultDashboardId: z.string().uuid().nullable().optional(),
  extension: z.string().nullable().optional(),
});

authRouter.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = preferencesSchema.parse(req.body);

  const columnMap: Record<string, string> = {
    firstName: 'first_name', lastName: 'last_name', phone: 'phone', avatarUrl: 'avatar_url',
    timezone: 'timezone', locale: 'locale', currency: 'currency', theme: 'theme',
    defaultDashboardId: 'default_dashboard_id', extension: 'extension',
  };

  const sets: string[] = [];
  const params: unknown[] = [user.id];
  for (const [key, value] of Object.entries(input)) {
    const col = columnMap[key];
    if (!col) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_user SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  res.json(await loadUser(user.id));
}));

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

authRouter.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { currentPassword, newPassword } = passwordSchema.parse(req.body);

  const row = await queryOne<{ password_hash: string | null }>(
    `SELECT password_hash FROM ipy_user WHERE id = $1`, [user.id],
  );
  if (!row?.password_hash || !(await verifyPassword(currentPassword, row.password_hash))) {
    throw new UnauthorizedError('Current password is incorrect');
  }
  if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    throw new ValidationError('Password must contain upper case, lower case and a number');
  }

  await db.query(
    `UPDATE ipy_user SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
    [user.id, await hashPassword(newPassword)],
  );
  // Force other devices to re-authenticate after a password change.
  await db.query(`UPDATE ipy_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
  res.json({ ok: true });
}));

authRouter.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT id, user_agent, ip_address, created_at, expires_at, revoked_at
     FROM ipy_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [getUser(req).id],
  );
  res.json(rows.rows);
}));

authRouter.delete('/sessions/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.query(`UPDATE ipy_session SET revoked_at = now() WHERE id = $1 AND user_id = $2`, [
    req.params.id, getUser(req).id,
  ]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// API keys (for the partner portal and server-to-server integrations)
// ---------------------------------------------------------------------------

authRouter.post('/api-keys', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { name, expiresInDays } = z.object({
    name: z.string().min(1),
    expiresInDays: z.number().int().positive().max(3650).optional(),
  }).parse(req.body);

  const raw = `ipy_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = raw.slice(0, 8);
  const hash = await hashPassword(raw);
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;

  const row = await queryOne<{ id: string }>(
    `INSERT INTO ipy_api_key (name, key_prefix, key_hash, user_id, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name, prefix, hash, user.id, expiresAt],
  );

  // The plaintext key is shown exactly once.
  res.status(201).json({ id: row?.id, name, key: raw, prefix, expiresAt });
}));

authRouter.get('/api-keys', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT id, name, key_prefix, last_used_at, expires_at, revoked_at, created_at
     FROM ipy_api_key WHERE user_id = $1 ORDER BY created_at DESC`,
    [getUser(req).id],
  );
  res.json(rows.rows);
}));

authRouter.delete('/api-keys/:id', requireAuth, asyncHandler(async (req, res) => {
  const result = await db.query(
    `UPDATE ipy_api_key SET revoked_at = now() WHERE id = $1 AND user_id = $2`,
    [req.params.id, getUser(req).id],
  );
  if (!result.rowCount) throw new BadRequestError('API key not found');
  res.json({ ok: true });
}));
