/**
 * Notifications to the installed app, through Firebase.
 *
 * A phone running the native app has no service worker, so Web Push cannot
 * reach it. Firebase Cloud Messaging does, and on iPhone Firebase forwards to
 * APNs — one code path for both platforms, which is the only reason to involve
 * Firebase in an app that otherwise needs nothing from Google.
 *
 * **No SDK.** `firebase-admin` is forty megabytes and pulls in gRPC to do what
 * is, underneath, a signed JWT exchanged for an access token and one POST. The
 * whole of that is below, on Node's own crypto. The deploy image is already
 * slow enough to build that a free-tier Render build has failed for want of
 * resources, and this saves a fifth of `node_modules`.
 *
 * Like every other integration here, it degrades rather than throws: with no
 * service account pasted in, `sendFcm` returns having done nothing and the
 * in-app notification and the Web Push both still land.
 */
import { createSign } from 'node:crypto';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmMessage {
  title: string;
  body: string;
  /** Where tapping it should land, as an in-app path. */
  link: string;
  kind: string;
  /** Collapses repeats about the same record into one notification. */
  tag: string;
}

/**
 * The service account, as pasted into Admin → Integrations.
 *
 * Cached for the life of the process. It changes when somebody pastes a new
 * one, which is a restart-shaped event; re-reading it per notification would
 * be a database round trip on every alert the CRM sends.
 */
let cachedAccount: ServiceAccount | null | undefined;

async function serviceAccount(): Promise<ServiceAccount | null> {
  if (cachedAccount !== undefined) return cachedAccount;

  const row = await db.query<{ credentials: Record<string, unknown> }>(
    `SELECT credentials FROM ipy_integration WHERE provider = 'fcm' AND is_active = true`,
  );
  const raw = row.rows[0]?.credentials;

  /*
    Accepted two ways, because both are what a person actually has in front of
    them. Firebase hands you a JSON file to download; an admin either pastes
    its whole contents into one box, or the settings form has already parsed it
    into fields. Insisting on one shape is how a correct key gets rejected.
  */
  const parsed = typeof raw?.serviceAccount === 'string'
    ? safeParse(raw.serviceAccount as string)
    : (raw as unknown as ServiceAccount | undefined);

  if (!parsed?.project_id || !parsed.client_email || !parsed.private_key) {
    cachedAccount = null;
    return null;
  }
  cachedAccount = {
    project_id: parsed.project_id,
    client_email: parsed.client_email,
    // A key pasted through a JSON field arrives with its newlines escaped.
    // Left as-is, signing fails with an unhelpful OpenSSL error.
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
  };
  return cachedAccount;
}

function safeParse(text: string): ServiceAccount | undefined {
  try { return JSON.parse(text) as ServiceAccount; } catch { return undefined; }
}

/** Called after an admin saves the card, so the next send uses the new key. */
export function invalidateFcm(): void {
  cachedAccount = undefined;
  cachedToken = null;
}

/** Is the app able to be notified at all? Read by the readiness check. */
export async function fcmConfigured(): Promise<boolean> {
  return (await serviceAccount()) !== null;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(account: ServiceAccount): Promise<string | null> {
  // Sixty seconds of headroom: a token that expires in flight is a send that
  // fails with 401 and looks exactly like a wrong key.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(account.private_key));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });

  if (!res.ok) {
    logger.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, 'fcm token exchange failed');
    return null;
  }

  const body = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type FcmOutcome = 'sent' | 'skipped' | 'failed' | 'expired';

/**
 * Send one notification to one device.
 *
 * `expired` is the answer that matters: Firebase says `UNREGISTERED` or
 * `INVALID_ARGUMENT` when the app has been uninstalled or the token rotated,
 * and the caller deletes that row. Without it every future notification retries
 * a dead handset for ever, and the failure count makes a healthy system look
 * broken.
 */
export async function sendFcm(token: string, message: FcmMessage): Promise<FcmOutcome> {
  const account = await serviceAccount();
  if (!account) return 'skipped';

  const bearer = await accessToken(account);
  if (!bearer) return 'failed';

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: message.title, body: message.body },
          /*
            Every value has to be a string — FCM rejects the whole message if
            one is a number, with an error that names the request rather than
            the field. `link` is what the app reads on tap.
          */
          data: { link: message.link, kind: message.kind, tag: message.tag },
          android: {
            priority: 'HIGH',
            notification: {
              // Collapses "Lead updated" three times in a minute into one line
              // rather than three, which is the difference between a useful
              // notification shade and one people switch off.
              tag: message.tag,
              channel_id: 'ipropy-alerts',
            },
          },
          apns: {
            payload: {
              // `content-available` alone delivers silently. A CRM alert is
              // meant to be seen, so the alert body is declared explicitly.
              aps: { sound: 'default', 'thread-id': message.tag },
            },
          },
        },
      }),
    },
  );

  if (res.ok) return 'sent';

  const text = await res.text();
  if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text)) return 'expired';
  logger.warn({ status: res.status, body: text.slice(0, 200) }, 'fcm send failed');
  return 'failed';
}
