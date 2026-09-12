import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { clearRefreshCookie, readRefreshToken, setRefreshCookie } from '../../core/auth/refreshCookie.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db, queryOne } from '../../db/pool.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import {
  getUser, hashPassword, loadUser, requireAuth, signAccessToken, verifyPassword,
} from '../../middleware/auth.js';
import { BadRequestError, UnauthorizedError, ValidationError } from '../../utils/errors.js';
import { getSubordinateUserIds, listCapabilities } from '../../core/permissions/index.js';
import { issueSession, hashRefreshToken, rotateRefreshToken, RetryableRefresh } from '../../core/auth/session.js';
import { clearPinDeviceCookie } from '../../core/auth/devicePin.js';

export const authRouter = Router();

/*
  Two buckets, because one was locking out the wrong people.

  This was keyed on the IP alone, which is how `express-rate-limit` behaves by
  default, and the whole team shares an IP: an office, or a mobile network's
  NAT. So twenty failed attempts on *one* account — somebody's password manager
  filling the wrong entry, or an attacker picking any single name — locked out
  every colleague behind that address for fifteen minutes, correct password and
  all. Measured: a second account with the right password got a 429.

  The tight bucket is therefore per account *and* address. An attacker working
  one account is stopped exactly as before, and a colleague at the next desk is
  not.

  The loose one is still per address, and is what stops the other attack the
  first bucket cannot see: spraying one password across a thousand names, where
  every account has a bucket of its own and none of them fills. It is set high
  enough that a busy office never meets it.

  `skipSuccessfulRequests` on both: signing in correctly costs nothing, so a
  working day of real logins cannot exhaust either.
*/
export const attemptedAccount = (req: { body?: unknown }): string => {
  const body = (req.body ?? {}) as { identifier?: unknown; email?: unknown };
  const raw = String(body.identifier ?? body.email ?? '').trim().toLowerCase();
  // A phone typed three ways is one account; `phoneKey` is the same reduction
  // the sign-in itself uses, so the bucket matches what is being attacked.
  return phoneKey(raw) ?? raw ?? '';
};

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.security.loginRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}|${attemptedAccount(req)}`,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Try again in a few minutes.' },
});

/** The spray guard: many names, one address. Deliberately generous. */
const loginSprayLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.security.loginRateLimit * 10,
  standardHeaders: false,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts from this connection. Try again in a few minutes.' },
});

const loginSchema = z.object({
  /** email or mobile number; `email` kept for older clients */
  identifier: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  password: z.string().min(1),
}).refine((v) => v.identifier ?? v.email, { message: 'Enter your email or mobile number' });

/**
 * Reduce a phone number to digits so stored and typed forms match.
 *
 * People type "+91 98765 43210", "098765 43210" and "9876543210" for the same
 * number, and the CRM's own `phone` column has all three shapes in it. The
 * last ten digits are the stable part for Indian mobiles — the country code
 * and any trunk zero are the bits that vary.
 */
function phoneKey(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

authRouter.post('/login', loginSprayLimiter, loginLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.parse(req.body);
  const identifier = (parsed.identifier ?? parsed.email ?? '').trim();
  const { password } = parsed;

  // Email or mobile. The phone branch compares on the last ten digits, since
  // the same number is stored with and without +91 across imported records.
  const mobile = phoneKey(identifier);
  const row = await queryOne<{ id: string; password_hash: string | null; is_active: boolean }>(
    `SELECT id, password_hash, is_active FROM ipy_user
     WHERE deleted_at IS NULL
       AND ( lower(email) = lower($1)
             OR ($2::text IS NOT NULL AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $2) )
     ORDER BY (lower(email) = lower($1)) DESC
     LIMIT 1`,
    [identifier, mobile],
  );

  // Same message either way so the endpoint can't be used to enumerate accounts.
  if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
    throw new UnauthorizedError('Incorrect email/mobile or password');
  }
  if (!row.is_active) throw new UnauthorizedError('This account has been deactivated');

  const session = await issueSession(row.id, req);
  /*
    The refresh token goes in an httpOnly cookie *and* in the body.

    The cookie is the protection; the body is what stops this deploy signing
    everybody out. A browser running the older bundle reads the body and files it
    in localStorage as before, and a browser running the newer one ignores the
    body and lets the cookie do the work. Both are correct at once, which is the
    only way to change where a credential lives without a forced logout.
  */
  setRefreshCookie(res, session.refreshToken);
  res.json(session);
}));

/*
  Refreshing rotates. A refresh token used to be good for its full thirty days
  however many times it was presented, so one that leaked stayed useful for a
  month with nothing to notice. Now each exchange mints a new one and retires the
  old, which turns a stolen token into a short problem and, better, a visible
  one: the moment a retired token is presented again, two parties are holding it.
*/
authRouter.post('/refresh', asyncHandler(async (req, res) => {
  // Cookie first, body second. See `readRefreshToken` for why the body is still
  // accepted at all.
  const token = readRefreshToken(req);
  if (!token) throw new UnauthorizedError('Session expired — please sign in again');

  let rotated: { userId: string; refreshToken: string } | null = null;
  let userId: string;
  try {
    rotated = await rotateRefreshToken(token, req);
    userId = rotated.userId;
  } catch (err) {
    if (!(err instanceof RetryableRefresh)) throw err;
    // A second tab refreshed a moment ago. Give it a fresh access token and
    // leave its refresh token alone rather than starting a rotation war.
    const session = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM ipy_session WHERE token_hash = $1`,
      [hashRefreshToken(token)],
    );
    if (!session) throw new UnauthorizedError('Session expired — please sign in again');
    userId = session.user_id;
  }

  const user = await loadUser(userId);
  if (!user?.isActive) throw new UnauthorizedError('Account is unavailable');

  // Rotation mints a replacement, so the cookie has to move with it or the next
  // refresh presents a retired token — which the server reads as theft and
  // answers by revoking the whole session family.
  if (rotated) setRefreshCookie(res, rotated.refreshToken);

  res.json({
    token: signAccessToken(user),
    user,
    // Absent on the concurrent-refresh path, where the caller keeps the one it has.
    ...(rotated ? { refreshToken: rotated.refreshToken } : {}),
  });
}));

authRouter.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  const token = readRefreshToken(req);
  clearRefreshCookie(res);

  /*
    The whole chain, not the one link that was handed over.

    Rotation gives every exchange a new row and points the old one at it
    through `replaced_by`. Logging out revoked only the row whose hash matched,
    so a tab holding a token another tab had already rotated revoked something
    already superseded — and answered `{ ok: true }` while the session carried
    happily on.

    That is not an edge case here. Two tabs hitting a 401 together is the
    normal case the grace window exists for, so the token in the tab somebody
    presses Log out in is *routinely* a link or two behind. Measured before
    fixing: tab A refreshes, tab B logs out, tab A keeps working.

    Forward through `replaced_by` from whatever was presented, so every
    descendant dies with it.
  */
  /*
    "Did this token ever name a session" is a different question from "did this
    call revoke anything", and conflating them cost a whole session.

    The revoke below only touches rows that are still live, so logging out a
    session that was *already* logged out — a second click, a token a theft
    check had revoked — matched nothing, which read as "unknown token" and sent
    the fallback through to revoke every other session the user had. Signing
    out twice on a laptop would have signed them out of their phone.

    So recognition is asked first, and separately.
  */
  const known = token
    ? await db.queryOne<{ one: number }>(
      `SELECT 1 AS one FROM ipy_session WHERE token_hash = $1 LIMIT 1`,
      [hashRefreshToken(token)],
    )
    : null;

  if (known && token) {
    await db.query(
      `WITH RECURSIVE family AS (
         SELECT id, replaced_by FROM ipy_session WHERE token_hash = $1
         UNION ALL
         SELECT s.id, s.replaced_by FROM ipy_session s JOIN family f ON s.id = f.replaced_by
       )
       UPDATE ipy_session SET revoked_at = now()
        WHERE id IN (SELECT id FROM family) AND revoked_at IS NULL`,
      [hashRefreshToken(token)],
    );
  } else {
    // No token, or one no session has ever had: they asked to be logged out and
    // we know who they are, so end all of it rather than answering "ok" to
    // somebody who is still signed in.
    await db.query(`UPDATE ipy_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [getUser(req).id]);
  }
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  // How lists behave rides along here rather than on a probe of its own: every
  // client already fetches this at start-up, and the answer is the same for
  // everybody. See core/settings/ui.ts.
  const { uiSettings } = await import('../../core/settings/ui.js');
  /*
    Capabilities travel with the user, because the browser cannot hide a screen
    it has no opinion about.

    Admin was a route with no guard on it. The sidebar link was hidden from
    non-admins and the route was not, so a Sales Executive who typed /admin/users
    got the whole control panel — Modules & Fields, Dropdowns, Roles & Profiles,
    Integrations, a "New user" button — every control of which fails with a 403
    when pressed. The data was safe; the experience was a CRM that looked broken.

    Sent as a plain list rather than a single isAdmin flag, because the answer is
    not binary: a Sales Manager holds `records.import` and nothing else in the
    admin area, and Import Data lives there. Gating on isAdmin would have locked
    them out of the one screen they are meant to use.
  */
  const [subordinateIds, ui, capabilities] = await Promise.all([
    getSubordinateUserIds(user),
    uiSettings(),
    listCapabilities(user),
  ]);
  res.json({ ...user, subordinateIds, ui, capabilities });
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
});

authRouter.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = preferencesSchema.parse(req.body);

  const columnMap: Record<string, string> = {
    firstName: 'first_name', lastName: 'last_name', phone: 'phone', avatarUrl: 'avatar_url',
    timezone: 'timezone', locale: 'locale', currency: 'currency', theme: 'theme',
    defaultDashboardId: 'default_dashboard_id',
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

/**
 * Forgotten password, step one: ask for a link.
 *
 * Answers the same way whether or not the address exists. An endpoint that says
 * "no such user" is a tool for discovering who works here, and this one is
 * public. So the response is fixed and the work happens quietly behind it.
 *
 * Rate limited per account as well as per IP. Without that, anybody who knows
 * an address can fill that person's inbox by submitting this form in a loop,
 * and every one of those emails costs against a small monthly allowance.
 */
authRouter.post('/forgot-password', loginSprayLimiter, loginLimiter, asyncHandler(async (req, res) => {
  const { email } = z.object({ email: z.string().email().max(200) }).parse(req.body);

  // Said before anything else, and identically in every branch below.
  const answer = { ok: true as const };

  const user = await queryOne<{ id: string; email: string; first_name: string | null }>(
    `SELECT id, email, first_name FROM ipy_user
      WHERE lower(email) = lower($1) AND is_active = true`,
    [email],
  );
  if (!user) { res.json(answer); return; }

  const recent = await queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM ipy_password_reset
      WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [user.id],
  );
  if (Number(recent?.n ?? 0) >= 3) {
    logger.warn({ userId: user.id }, 'password reset throttled: three requests in an hour');
    res.json(answer);
    return;
  }

  // Random, long, and stored only as a hash. The plaintext exists in this
  // function and in one email, and nowhere else ever.
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await db.query(
    `INSERT INTO ipy_password_reset (user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, now() + interval '1 hour', $3)`,
    [user.id, tokenHash, req.ip ?? null],
  );

  const link = `${config.appUrl.replace(/\/+$/, '')}/reset-password?token=${token}`;
  const name = user.first_name?.trim() || 'there';

  try {
    const { sendEmail } = await import('../../integrations/email/service.js');
    await sendEmail({
      to: user.email,
      subject: 'Reset your iPropy password',
      html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#0f172a">
  <p>Hi ${escapeHtml(name)},</p>
  <p>Someone asked to reset the password for your iPropy account. If that was you, use the link below. It works once and expires in an hour.</p>
  <p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Choose a new password</a></p>
  <p style="color:#64748b;font-size:13px">If it was not you, nothing has changed and you can ignore this. Your current password still works.</p>
</div>`,
      // No open tracking on a security email. A pixel on a password reset is
      // both pointless and the sort of thing that gets a domain reported.
      track: false,
    });
  } catch (err) {
    // Never surfaced. A mail failure telling the caller the address exists is
    // the enumeration hole this endpoint is built to avoid.
    logger.error({ err, userId: user.id }, 'could not send a password reset email');
  }

  res.json(answer);
}));

/** Minimal escaping for the one name that reaches the email body. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

/**
 * Step two: hand back the token with a new password.
 *
 * The token is consumed inside the same statement that finds it, so two
 * simultaneous submissions cannot both succeed. Everything else follows
 * change-password exactly: sessions and device PINs die, because a reset is a
 * recovery from "somebody may have my account", not a convenience.
 */
authRouter.post('/reset-password', loginSprayLimiter, loginLimiter, asyncHandler(async (req, res) => {
  const { token, newPassword } = z.object({
    token: z.string().min(20).max(200),
    newPassword: z.string().min(8).max(200),
  }).parse(req.body);

  if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    throw new ValidationError('Password must contain upper case, lower case and a number');
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Claimed and checked in one write. A SELECT then UPDATE leaves a window
  // where the same link works twice.
  const claimed = await queryOne<{ user_id: string }>(
    `UPDATE ipy_password_reset
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [tokenHash],
  );
  if (!claimed) {
    throw new BadRequestError('That reset link has already been used or has expired. Ask for a new one.');
  }

  await db.query(
    `UPDATE ipy_user SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
    [claimed.user_id, await hashPassword(newPassword)],
  );
  await db.query(
    `UPDATE ipy_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [claimed.user_id],
  );
  await db.query(
    `UPDATE ipy_pin_device SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [claimed.user_id],
  );
  // Any other outstanding link for this account dies with it. Two reset emails
  // in a drawer is two ways in.
  await db.query(
    `UPDATE ipy_password_reset SET used_at = now()
      WHERE user_id = $1 AND used_at IS NULL`,
    [claimed.user_id],
  );
  clearPinDeviceCookie(res);

  logger.info({ userId: claimed.user_id }, 'password reset completed');
  res.json({ ok: true });
}));

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
  // A device PIN is deliberately a lower-friction credential. Changing the
  // account password is a security reset, so every trusted-device PIN must be
  // explicitly set up again afterward.
  await db.query(`UPDATE ipy_pin_device SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
  clearPinDeviceCookie(res);
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
