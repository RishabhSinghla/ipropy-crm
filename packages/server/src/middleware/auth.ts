import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { AuthUser } from '@ipropy/shared';
import { config } from '../config.js';
import { db, queryOne } from '../db/pool.js';
import { UnauthorizedError } from '../utils/errors.js';
import { buildScopeContext, type ScopeContext } from '../core/permissions/index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      scope?: ScopeContext;
    }
  }
}

export interface TokenPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
}

export function signAccessToken(user: AuthUser): string {
  const payload: TokenPayload = { sub: user.id, email: user.email, isAdmin: user.isAdmin };
  return jwt.sign(payload, config.auth.jwtSecret, { expiresIn: config.auth.jwtExpiresIn } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, config.auth.jwtSecret) as TokenPayload;
  } catch {
    throw new UnauthorizedError('Session expired or invalid — please sign in again');
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

interface UserRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  phone: string | null;
  is_admin: boolean;
  is_active: boolean;
  role_id: string | null;
  role_name: string | null;
  profile_id: string | null;
  profile_name: string | null;
  timezone: string;
  locale: string;
  currency: string;
  theme: string;
  extension: string | null;
  default_dashboard_id: string | null;
  channel_partner_id: string | null;
  last_login_at: string | null;
}

export async function loadUser(userId: string): Promise<AuthUser | null> {
  const row = await queryOne<UserRow>(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, u.phone, u.is_admin,
            u.is_active, u.role_id, r.name AS role_name, u.profile_id, p.name AS profile_name,
            u.timezone, u.locale, u.currency, u.theme, u.extension,
            u.default_dashboard_id, u.channel_partner_id, u.last_login_at
     FROM ipy_user u
     LEFT JOIN ipy_role r ON r.id = u.role_id
     LEFT JOIN ipy_profile p ON p.id = u.profile_id
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
  );
  if (!row) return null;

  const groups = await db.query<{ group_id: string }>(
    `SELECT DISTINCT group_id FROM ipy_group_member
     WHERE (member_type = 'user' AND member_id = $1)
        OR (member_type = 'role' AND member_id = $2)`,
    [row.id, row.role_id],
  );

  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`.trim(),
    avatarUrl: row.avatar_url,
    phone: row.phone,
    isAdmin: row.is_admin,
    isActive: row.is_active,
    roleId: row.role_id,
    roleName: row.role_name,
    profileId: row.profile_id,
    profileName: row.profile_name,
    groupIds: groups.rows.map((g) => g.group_id),
    timezone: row.timezone,
    locale: row.locale,
    currency: row.currency,
    theme: (row.theme as AuthUser['theme']) ?? 'system',
    defaultDashboardId: row.default_dashboard_id,
    extension: row.extension,
    channelPartnerId: row.channel_partner_id,
    lastLoginAt: row.last_login_at,
  };
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  // Some embeds (document preview, tracking pixels) can only pass a query token.
  const q = req.query.access_token;
  if (typeof q === 'string' && q) return q;
  return null;
}

/** Require a signed-in user; attaches req.user and req.scope. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw new UnauthorizedError();
    const payload = verifyAccessToken(token);
    const user = await loadUser(payload.sub);
    if (!user) throw new UnauthorizedError('Account no longer exists');
    if (!user.isActive) throw new UnauthorizedError('Account is deactivated');
    req.user = user;
    req.scope = await buildScopeContext(user);
    next();
  } catch (err) {
    next(err);
  }
}

/** Attach the user when a token is present, but never reject. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (token) {
      const payload = verifyAccessToken(token);
      const user = await loadUser(payload.sub);
      if (user?.isActive) {
        req.user = user;
        req.scope = await buildScopeContext(user);
      }
    }
  } catch {
    // ignore — this route works unauthenticated
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new UnauthorizedError());
  if (!req.user.isAdmin) {
    return next(new UnauthorizedError('Administrator access required'));
  }
  next();
}

/** Convenience accessors that narrow the optional request fields. */
export function getUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export function getScope(req: Request): ScopeContext & { source: string } {
  if (!req.scope) throw new UnauthorizedError();
  return { ...req.scope, source: 'app' };
}

/**
 * API-key auth for server-to-server calls (portal integrations, webhooks that
 * need to write as a specific user).
 */
export async function requireApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !key) throw new UnauthorizedError('API key required');
    const prefix = key.slice(0, 8);
    const rows = await db.query<{ id: string; key_hash: string; user_id: string | null; expires_at: string | null; revoked_at: string | null }>(
      `SELECT id, key_hash, user_id, expires_at, revoked_at FROM ipy_api_key WHERE key_prefix = $1`,
      [prefix],
    );
    for (const row of rows.rows) {
      if (row.revoked_at) continue;
      if (row.expires_at && new Date(row.expires_at) < new Date()) continue;
      if (await bcrypt.compare(key, row.key_hash)) {
        if (!row.user_id) throw new UnauthorizedError('API key is not bound to a user');
        const user = await loadUser(row.user_id);
        if (!user) throw new UnauthorizedError('API key user no longer exists');
        req.user = user;
        req.scope = await buildScopeContext(user);
        await db.query(`UPDATE ipy_api_key SET last_used_at = now() WHERE id = $1`, [row.id]);
        return next();
      }
    }
    throw new UnauthorizedError('Invalid API key');
  } catch (err) {
    next(err);
  }
}
