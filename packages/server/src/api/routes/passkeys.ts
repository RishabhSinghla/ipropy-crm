/**
 * Passkeys — Face ID, Touch ID and Android biometric sign-in (WebAuthn).
 *
 * The device holds the private key and only releases a signature after its own
 * biometric check; the server stores a public key and never sees a fingerprint.
 * That also makes these credentials phishing-resistant: a passkey is bound to
 * this origin and simply will not sign for another one.
 *
 * Sign-in here is *usernameless* — the browser offers whichever passkey it has
 * for this site, so on a phone it is one tap and a face, with nothing typed.
 * That is only possible because `credential_id` is globally unique, which is
 * what lets a raw assertion identify the account.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { config } from '../../config.js';
import { db, queryOne } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getUser, loadUser, requireAuth, signAccessToken } from '../../middleware/auth.js';
import { BadRequestError, UnauthorizedError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export const passkeyRouter = Router();

const passkeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' },
});

/**
 * The Relying Party ID must be the site's registered domain — not the origin,
 * and never a port. Derived from APP_URL so a deployment does not need another
 * environment variable to get this subtly wrong.
 */
function relyingParty(): { rpID: string; origin: string; rpName: string } {
  const url = new URL(config.appUrl);
  return { rpID: url.hostname, origin: url.origin, rpName: 'iPropy CRM' };
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

async function storeChallenge(challenge: string, userId: string | null, kind: 'register' | 'login'): Promise<void> {
  await db.query(
    `INSERT INTO ipy_webauthn_challenge (challenge, user_id, kind, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [challenge, userId, kind, new Date(Date.now() + CHALLENGE_TTL_MS)],
  );
  // Opportunistic sweep; there is no scheduled job for a table this small.
  await db.query(`DELETE FROM ipy_webauthn_challenge WHERE expires_at < now()`).catch(() => undefined);
}

/** Consumes the challenge: valid exactly once, so a replay finds nothing. */
async function takeChallenge(challenge: string, kind: 'register' | 'login'): Promise<{ user_id: string | null } | null> {
  const row = await queryOne<{ user_id: string | null }>(
    `DELETE FROM ipy_webauthn_challenge
     WHERE challenge = $1 AND kind = $2 AND expires_at > now()
     RETURNING user_id`,
    [challenge, kind],
  );
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Enrolment (signed in)
// ---------------------------------------------------------------------------

passkeyRouter.post('/register/options', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { rpID, rpName } = relyingParty();

  const existing = await db.query<{ credential_id: string; transports: string[] }>(
    `SELECT credential_id, transports FROM ipy_webauthn_credential WHERE user_id = $1`,
    [user.id],
  );

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: Buffer.from(user.id),
    userName: user.email,
    userDisplayName: user.fullName,
    attestationType: 'none', // we do not need to know the make of the device
    // Stops the same phone enrolling twice and quietly shadowing its own key.
    excludeCredentials: existing.rows.map((c) => ({
      id: c.credential_id,
      transports: c.transports as never,
    })),
    authenticatorSelection: {
      // `platform` = the biometric sensor built into this device, which is
      // what "sign in with Face ID" means. residentKey/required is what makes
      // the usernameless sign-in below possible.
      authenticatorAttachment: 'platform',
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  await storeChallenge(options.challenge, user.id, 'register');
  res.json(options);
}));

passkeyRouter.post('/register/verify', requireAuth, asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { rpID, origin } = relyingParty();
  const { response, label } = z.object({
    response: z.record(z.unknown()),
    label: z.string().max(80).optional(),
  }).parse(req.body);

  const clientData = JSON.parse(
    Buffer.from(String((response as { response?: { clientDataJSON?: string } }).response?.clientDataJSON ?? ''), 'base64').toString(),
  ) as { challenge?: string };
  if (!clientData.challenge) throw new BadRequestError('Malformed passkey response');

  const stored = await takeChallenge(clientData.challenge, 'register');
  if (!stored || stored.user_id !== user.id) throw new BadRequestError('This enrolment expired — try again');

  const verification = await verifyRegistrationResponse({
    response: response as never,
    expectedChallenge: clientData.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new BadRequestError('Could not verify this device');
  }

  const { credential } = verification.registrationInfo;
  await db.query(
    `INSERT INTO ipy_webauthn_credential (user_id, credential_id, public_key, counter, transports, device_label)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (credential_id) DO UPDATE
       SET public_key = EXCLUDED.public_key, counter = EXCLUDED.counter`,
    [
      user.id,
      credential.id,
      Buffer.from(credential.publicKey).toString('base64url'),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      label ?? null,
    ],
  );

  res.json({ ok: true });
}));

passkeyRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT id, device_label, created_at, last_used_at
     FROM ipy_webauthn_credential WHERE user_id = $1 ORDER BY created_at DESC`,
    [getUser(req).id],
  );
  res.json(rows.rows);
}));

passkeyRouter.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.query(
    `DELETE FROM ipy_webauthn_credential WHERE id = $1 AND user_id = $2`,
    [req.params.id, getUser(req).id],
  );
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Sign-in (public)
// ---------------------------------------------------------------------------

passkeyRouter.post('/login/options', passkeyLimiter, asyncHandler(async (_req, res) => {
  const { rpID } = relyingParty();
  // No allowCredentials: the browser picks from the passkeys it holds for this
  // site, so the user types nothing at all before the biometric prompt.
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  await storeChallenge(options.challenge, null, 'login');
  res.json(options);
}));

passkeyRouter.post('/login/verify', passkeyLimiter, asyncHandler(async (req, res) => {
  const { rpID, origin } = relyingParty();
  const { response } = z.object({ response: z.record(z.unknown()) }).parse(req.body);

  const raw = response as { id?: string; response?: { clientDataJSON?: string } };
  const clientData = JSON.parse(Buffer.from(String(raw.response?.clientDataJSON ?? ''), 'base64').toString()) as { challenge?: string };
  if (!clientData.challenge || !raw.id) throw new BadRequestError('Malformed passkey response');

  const stored = await takeChallenge(clientData.challenge, 'login');
  if (!stored) throw new UnauthorizedError('This sign-in expired — try again');

  const cred = await queryOne<{
    id: string; user_id: string; public_key: string; counter: string; transports: string[]; is_active: boolean;
  }>(
    `SELECT c.id, c.user_id, c.public_key, c.counter, c.transports, u.is_active
     FROM ipy_webauthn_credential c
     JOIN ipy_user u ON u.id = c.user_id AND u.deleted_at IS NULL
     WHERE c.credential_id = $1`,
    [raw.id],
  );
  if (!cred) throw new UnauthorizedError('This device is not registered');
  if (!cred.is_active) throw new UnauthorizedError('This account has been deactivated');

  const verification = await verifyAuthenticationResponse({
    response: response as never,
    expectedChallenge: clientData.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: raw.id,
      publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
      counter: Number(cred.counter),
      transports: cred.transports as never,
    },
  });

  if (!verification.verified) throw new UnauthorizedError('Biometric check failed');

  const { newCounter } = verification.authenticationInfo;
  // A counter that fails to advance is WebAuthn's only clone signal. Authenticators
  // that always report 0 are exempt — that is a legitimate, common choice.
  if (Number(cred.counter) > 0 && newCounter <= Number(cred.counter)) {
    logger.warn({ credentialId: cred.id }, 'passkey signature counter did not advance — possible cloned credential');
    throw new UnauthorizedError('This device could not be verified. Sign in with your password.');
  }

  await db.query(
    `UPDATE ipy_webauthn_credential SET counter = $2, last_used_at = now() WHERE id = $1`,
    [cred.id, newCounter],
  );

  const user = await loadUser(cred.user_id);
  if (!user) throw new UnauthorizedError('Account not found');

  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await db.query(
    `INSERT INTO ipy_session (user_id, refresh_token, user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [user.id, refreshToken, req.headers['user-agent'] ?? null, req.ip ?? null, new Date(Date.now() + 30 * 86_400_000)],
  );

  res.json({ token: signAccessToken(user), refreshToken, user });
}));
