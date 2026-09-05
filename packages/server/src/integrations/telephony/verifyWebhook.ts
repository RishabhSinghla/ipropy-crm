/**
 * Proving a telephony callback came from the telephone company.
 *
 * The three telephony webhooks accepted anything at all. Every other webhook in
 * this codebase authenticates — WhatsApp and Facebook check an HMAC signature,
 * n8n checks a shared secret in constant time and refuses when none is set —
 * so this was an omission rather than a decision.
 *
 * What it cost, concretely. `POST /webhooks/telephony/x/recording` takes a call
 * id and a recording URL, writes the URL onto the call, and hands it to
 * `analyseCallRecording`, which downloads it. No host check, no private-network
 * check, no size limit. So an anonymous request could make the server fetch a
 * URL of the sender's choosing — the inside of a cloud network, a metadata
 * endpoint, or something with no end to it. `/status` could rewrite call
 * records, and `/incoming` handed back the agent's own phone number to whoever
 * asked.
 *
 * Two mechanisms, because the providers differ:
 *
 *  * **Twilio signs its requests.** HMAC-SHA1 over the full URL with every POST
 *    field appended in sorted order, keyed by the account's auth token, in
 *    `X-Twilio-Signature`. That is the real thing and it is what is checked.
 *  * **Everyone else does not.** Exotel and the rest authenticate by having been
 *    given a URL nobody else knows, which is not authentication. So they carry a
 *    shared secret, compared in constant time, exactly as the n8n routes do.
 *
 * **Unconfigured means refused, never allowed.** A check that only runs when a
 * credential happens to be set is not a check; it is a note saying somebody
 * meant to write one. This is the same trap the Google lead webhook fell into.
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import { getSettings } from '../../core/settings/integrations.js';

/** Constant-time compare that survives a length mismatch, which throws. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * The URL Twilio signed, which is the one it sent the request to.
 *
 * Render terminates TLS in front of the app, so `req.protocol` is `http` and
 * the host is in `x-forwarded-host`. Signing over the wrong URL fails every
 * request, which looks exactly like a wrong auth token.
 */
function signedUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim()
    || req.get('host') || '';
  return `${proto}://${host}${req.originalUrl}`;
}

/** Twilio's scheme: the URL, then every POST field name and value, sorted. */
export function twilioSignatureMatches(url: string, params: Record<string, unknown>, authToken: string, provided: string): boolean {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + String(params[key] ?? ''), url);

  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');
  return sameSecret(expected, provided);
}

export interface WebhookVerdict {
  ok: boolean;
  /** Why it was refused, for the log. Never sent to the caller. */
  reason?: string;
}

/**
 * Whether this telephony callback may be acted on.
 *
 * Returns a verdict rather than throwing so the caller decides the status code
 * — these routes answer 200 early and work afterwards, and a provider that gets
 * an error retries for hours.
 */
export function verifyTelephonyWebhook(req: Request, provider: string): WebhookVerdict {
  const telephony = getSettings().telephony;

  if (provider === 'twilio') {
    const { authToken } = telephony.twilio;
    if (!authToken) return { ok: false, reason: 'twilio has no auth token configured' };

    const provided = req.headers['x-twilio-signature'];
    if (typeof provided !== 'string' || !provided) return { ok: false, reason: 'no x-twilio-signature header' };

    const body = (req.body ?? {}) as Record<string, unknown>;
    return twilioSignatureMatches(signedUrl(req), body, authToken, provided)
      ? { ok: true }
      : { ok: false, reason: 'x-twilio-signature did not match' };
  }

  /*
    Everything else carries a shared secret. It may arrive as a header or in the
    query string, because several providers only let you configure a URL and
    nothing else — a secret in the URL is weaker than a signature, and it is the
    strongest thing some of them offer.
  */
  const expected = telephonyWebhookSecret(provider);
  if (!expected) return { ok: false, reason: `${provider} has no webhook secret configured` };

  const provided = (req.headers['x-telephony-secret'] as string | undefined)
    ?? (typeof req.query.secret === 'string' ? req.query.secret : '');

  return provided && sameSecret(expected, provided)
    ? { ok: true }
    : { ok: false, reason: 'shared secret did not match' };
}

/**
 * The shared secret for a non-Twilio provider.
 *
 * Read off the provider's own integration card so each one is separate: a
 * secret leaked by one telephony vendor must not authenticate another.
 */
export function telephonyWebhookSecret(provider: string): string {
  const telephony = getSettings().telephony;
  if (provider === 'exotel') return telephony.exotel.webhookSecret ?? '';
  return '';
}
