import crypto from 'node:crypto';
import type { Request } from 'express';
import type { AuthUser } from '@ipropy/shared';
import { config } from '../../config.js';
import { db } from '../../db/pool.js';
import { loadUser, signAccessToken } from '../../middleware/auth.js';
import { getSubordinateUserIds } from '../permissions/index.js';
import { UnauthorizedError } from '../../utils/errors.js';

export interface IssuedSession {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

function refreshExpiry(): Date {
  const match = config.auth.refreshExpiresIn.match(/^(\d+)([smhd])$/);
  const milliseconds = match
    ? Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 86_400_000)
    : 30 * 86_400_000;
  return new Date(Date.now() + milliseconds);
}

/**
 * Mint the same CRM session after any successful authentication method.
 *
 * Passwords, passkeys and a trusted-device PIN prove identity differently,
 * but the session returned to the web app must be identical. Keeping that in
 * one place prevents one sign-in path missing role-hierarchy data, expiry
 * rules or last-login tracking.
 */
export async function issueSession(userId: string, req: Request): Promise<IssuedSession> {
  const user = await loadUser(userId);
  if (!user?.isActive) throw new UnauthorizedError('Account is unavailable');

  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await db.query(
    `INSERT INTO ipy_session (user_id, refresh_token, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [user.id, refreshToken, req.headers['user-agent'] ?? null, req.ip ?? null, refreshExpiry()],
  );
  await db.query(`UPDATE ipy_user SET last_login_at = now() WHERE id = $1`, [user.id]);

  return {
    token: signAccessToken(user),
    refreshToken,
    user: { ...user, subordinateIds: await getSubordinateUserIds(user) },
  };
}
