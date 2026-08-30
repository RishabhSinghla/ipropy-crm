import crypto from 'node:crypto';
import type { Request } from 'express';
import type { AuthUser } from '@ipropy/shared';
import { config } from '../../config.js';
import { db } from '../../db/pool.js';
import { loadUser, signAccessToken } from '../../middleware/auth.js';
import { getSubordinateUserIds } from '../permissions/index.js';
import { UnauthorizedError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

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
  // Only the hash is stored. The server needs to recognise a token, never to
  // reproduce one, so keeping the original is all risk and no use — anyone who
  // read this table held a working month-long login for every member of staff.
  await db.query(
    `INSERT INTO ipy_session (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [user.id, hashRefreshToken(refreshToken), req.headers['user-agent'] ?? null, req.ip ?? null, refreshExpiry()],
  );
  await db.query(`UPDATE ipy_user SET last_login_at = now() WHERE id = $1`, [user.id]);

  return {
    token: signAccessToken(user),
    refreshToken,
    user: { ...user, subordinateIds: await getSubordinateUserIds(user) },
  };
}


/** What goes in the column. Plain SHA-256: the input is 48 random bytes, so
 *  there is nothing to brute-force and nothing for a salt to do. */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * How long a just-rotated token still answers.
 *
 * Two browser tabs hitting a 401 at the same moment both present the same old
 * token. The second one is not an attack and must not be treated as one, so a
 * replaced token keeps working for this long and returns the same successor.
 * After it, a replay means somebody else has the token.
 */
const ROTATION_GRACE_MS = 60_000;

export interface RotationResult {
  userId: string;
  /** The new refresh token to hand back. The caller must return it. */
  refreshToken: string;
}

/**
 * Exchange a refresh token for a new one, or refuse.
 *
 * Rotation is what makes a leaked token a short problem instead of a month-long
 * one. Reuse detection is what makes it a *noticed* problem: a token presented
 * after its grace window has already been exchanged by somebody, and if that
 * somebody was not this caller then two parties hold it. There is no way to tell
 * which one is the thief, so every session that user has is revoked and both are
 * made to sign in again.
 */
export async function rotateRefreshToken(token: string, req: Request): Promise<RotationResult> {
  const hash = hashRefreshToken(token);
  const session = await db.queryOne<{
    id: string; user_id: string; expires_at: string; revoked_at: string | null;
    replaced_by: string | null; rotated_at: string | null;
  }>(
    `SELECT id, user_id, expires_at, revoked_at, replaced_by, rotated_at
       FROM ipy_session WHERE token_hash = $1`,
    [hash],
  );

  if (!session) throw new UnauthorizedError('Session expired — please sign in again');

  if (session.replaced_by) {
    const rotatedAt = session.rotated_at ? new Date(session.rotated_at).getTime() : 0;
    if (Date.now() - rotatedAt > ROTATION_GRACE_MS) {
      // Replayed long after it was exchanged. Two parties hold this token.
      await db.query(
        `UPDATE ipy_session SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [session.user_id],
      );
      logger.warn({ userId: session.user_id }, 'refresh token reuse detected; revoked every session');
      throw new UnauthorizedError('Session expired — please sign in again');
    }
    // Inside the window: a second tab, not a thief. It gets nothing new, and
    // the access token it already received is what it carries on with.
    throw new RetryableRefresh();
  }

  if (session.revoked_at || new Date(session.expires_at) < new Date()) {
    throw new UnauthorizedError('Session expired — please sign in again');
  }

  const next = crypto.randomBytes(48).toString('base64url');
  const inserted = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_session (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [session.user_id, hashRefreshToken(next), req.headers['user-agent'] ?? null, req.ip ?? null, refreshExpiry()],
  );

  await db.query(
    `UPDATE ipy_session SET replaced_by = $2, rotated_at = now(), revoked_at = now() WHERE id = $1`,
    [session.id, inserted?.id ?? null],
  );

  return { userId: session.user_id, refreshToken: next };
}

/** A concurrent refresh, not a failure. The caller reissues an access token
 *  without minting a new refresh token. */
export class RetryableRefresh extends Error {}
