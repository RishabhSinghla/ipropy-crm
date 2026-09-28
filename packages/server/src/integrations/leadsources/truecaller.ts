/**
 * Verifying a visitor's own mobile number through Truecaller.
 *
 * This is the only Truecaller product that is code in this CRM. It proves that
 * the person filling in the enquiry form owns the number they typed — it does
 * **not** look anybody up, which Truecaller does not sell (see CLAUDE.md).
 *
 * The flow, in four moves:
 *
 *  1. the browser asks us for a nonce and gets a deep link back;
 *  2. it opens that link, and Truecaller shows the person a consent dialog;
 *  3. Truecaller posts `{ requestId, accessToken, endpoint }` to our callback;
 *  4. we fetch the profile from that endpoint with that token.
 *
 * **The callback carries no signature**, so step 3 authenticates nothing on its
 * own. Two things make it safe, and both are tested:
 *
 *  * the `requestId` must be a nonce *we* minted and are still waiting on, so a
 *    stranger cannot announce a verification that never started here;
 *  * the `endpoint` must be Truecaller's own host, or we would hand the access
 *    token to whoever asked and believe the profile they sent back.
 *
 * The real proof of identity is step 4: the profile comes from Truecaller over
 * TLS, in answer to a token only they issued.
 */
import { randomBytes } from 'node:crypto';
import { db } from '../../db/pool.js';
import { getIntegrationConfig } from '../../core/settings/integrations.js';
import { logger } from '../../utils/logger.js';

export const TRUECALLER_PROVIDER = 'truecaller';

/** Long enough that nobody guesses one, inside Truecaller's 8–64 character rule. */
const NONCE_BYTES = 24;

/** A verification the visitor walked away from is worth nothing later. */
const VERIFICATION_LIVES_FOR_MINUTES = 10;

/** Truecaller asks for a 2xx within three seconds, so the profile fetch gets less. */
const PROFILE_FETCH_TIMEOUT_MS = 8000;

export interface TruecallerStart {
  nonce: string;
  /** The link the browser opens. Built here so the app key lives in one place. */
  deepLink: string;
}

export interface TruecallerResult {
  status: 'pending' | 'verified' | 'failed' | 'unknown';
  name: string | null;
  phone: string | null;
}

/** The card in Admin → Integrations, or null when nobody has switched it on. */
function truecallerSettings(): { appKey: string; partnerName: string } | null {
  const config = getIntegrationConfig(TRUECALLER_PROVIDER);
  const appKey = config?.appKey?.trim();
  if (!appKey) return null;
  return { appKey, partnerName: config?.partnerName?.trim() || 'iPropy' };
}

export function truecallerIsSwitchedOn(): boolean {
  return truecallerSettings() !== null;
}

/**
 * Only Truecaller's own hosts may be handed the access token.
 *
 * Their callback names the endpoint to fetch the profile from, and that
 * callback is unauthenticated — so without this, anyone could point us at
 * their own server, collect the token, and answer with any profile they liked.
 * Pure and exported because it is the single line that keeps this safe.
 */
export function isTruecallerEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'truecaller.com' || url.hostname.endsWith('.truecaller.com');
}

/**
 * A name and a number out of a profile whose field names nobody here could read.
 *
 * Truecaller's mobile-web documentation is unreachable from this container, so
 * rather than insist on one shape this reads the ones their published samples
 * show and answers null otherwise. The whole profile is stored beside it, so
 * the first real verification corrects this rather than losing a lead.
 */
export function nameAndPhoneFrom(profile: unknown): { name: string | null; phone: string | null } {
  const root = (profile ?? {}) as Record<string, unknown>;

  const nameField = root.name;
  const nameParts = typeof nameField === 'object' && nameField !== null
    ? [(nameField as Record<string, unknown>).first, (nameField as Record<string, unknown>).last]
    : [nameField];
  const name = nameParts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ') || null;

  const numbers = root.phoneNumbers;
  const first = Array.isArray(numbers) ? numbers[0] : numbers;
  const phone = first === undefined || first === null ? null : String(first).replace(/\D/g, '') || null;

  return { name, phone };
}

/** Mint a nonce and hand back the link the browser opens. */
export async function startTruecallerVerification(): Promise<TruecallerStart | null> {
  const settings = truecallerSettings();
  if (!settings) return null;

  const nonce = randomBytes(NONCE_BYTES).toString('base64url');

  await db.query(
    `INSERT INTO ipy_truecaller_request (nonce, expires_at)
     VALUES ($1, now() + ($2::text || ' minutes')::interval)`,
    [nonce, String(VERIFICATION_LIVES_FOR_MINUTES)],
  );

  const params = new URLSearchParams({
    requestNonce: nonce,
    partnerKey: settings.appKey,
    partnerName: settings.partnerName,
    lang: 'en',
    title: 'verify',
  });

  return { nonce, deepLink: `truecallersdk://truesdk/web_verify?${params.toString()}` };
}

/**
 * What Truecaller posts to the callback URL once the person has consented.
 *
 * Never throws: the caller has already answered 200, because Truecaller wants
 * one inside three seconds and retries otherwise.
 */
export async function acceptTruecallerCallback(body: unknown): Promise<void> {
  const { requestId, accessToken, endpoint } = (body ?? {}) as Record<string, unknown>;
  if (typeof requestId !== 'string' || typeof accessToken !== 'string' || typeof endpoint !== 'string') {
    return;
  }

  // A nonce we are not waiting on is somebody else's announcement, not ours.
  const waiting = await db.queryOne<{ nonce: string }>(
    `SELECT nonce FROM ipy_truecaller_request
      WHERE nonce = $1 AND status = 'pending' AND expires_at > now()`,
    [requestId],
  );
  if (!waiting) {
    logger.warn({ requestId }, 'truecaller callback for a verification nobody started here');
    return;
  }

  if (!isTruecallerEndpoint(endpoint)) {
    await failVerification(requestId, `Refused a profile endpoint that is not Truecaller's: ${endpoint}`);
    return;
  }

  try {
    const profile = await fetchTruecallerProfile(endpoint, accessToken);
    await db.query(
      `UPDATE ipy_truecaller_request SET status = 'verified', profile = $2 WHERE nonce = $1`,
      [requestId, JSON.stringify(profile)],
    );
  } catch (err) {
    await failVerification(requestId, (err as Error).message);
  }
}

async function fetchTruecallerProfile(endpoint: string, accessToken: string): Promise<unknown> {
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Truecaller answered ${res.status} for the profile`);
  return res.json();
}

async function failVerification(nonce: string, why: string): Promise<void> {
  logger.error({ nonce, why }, 'truecaller verification failed');
  await db.query(
    `UPDATE ipy_truecaller_request SET status = 'failed', error = $2 WHERE nonce = $1`,
    [nonce, why],
  );
}

/**
 * What the waiting browser is told.
 *
 * Only the name and the number — the two things the person agreed to share
 * with this business for this form. The access token is never stored and the
 * rest of the profile never leaves the server.
 */
export async function readTruecallerResult(nonce: string): Promise<TruecallerResult> {
  const row = await db.queryOne<{ status: string; profile: unknown }>(
    `SELECT status, profile FROM ipy_truecaller_request WHERE nonce = $1 AND expires_at > now()`,
    [nonce],
  );
  if (!row) return { status: 'unknown', name: null, phone: null };
  if (row.status !== 'verified') {
    return { status: row.status as TruecallerResult['status'], name: null, phone: null };
  }
  return { status: 'verified', ...nameAndPhoneFrom(row.profile) };
}

/** Sweep what nobody came back for. Called from the scheduler's ordinary tick. */
export async function forgetExpiredTruecallerRequests(): Promise<void> {
  await db.query(`DELETE FROM ipy_truecaller_request WHERE expires_at < now() - interval '1 hour'`);
}
