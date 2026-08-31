/**
 * Telling somebody when the CRM breaks.
 *
 * Until now, a failure reached the owner only when a rep happened to mention
 * it. There was no other path from a broken thing to a person who could fix it,
 * and the reps least likely to report a problem are the ones least confident
 * with the software — so the errors that mattered most were the least likely to
 * be heard about.
 *
 * Three decisions worth keeping:
 *
 * **The address lives in Admin → Integrations, not in an environment variable.**
 * A Sentry DSN is not a secret — it sits in the JavaScript of every website that
 * uses one, and it can only *write* events. Putting it on the integrations page
 * means turning error reporting on is a paste and a save, with no redeploy and
 * nobody touching Render. An env var still works and wins if both are set,
 * because that one is read before the database and so catches a boot failure
 * this cannot.
 *
 * **Nothing here may ever break a request.** Every entry point is wrapped: no
 * DSN, an unreachable Sentry, a malformed address — all of them end with the
 * CRM running exactly as it did before. Error reporting that can take down the
 * thing it reports on is worse than none.
 *
 * **What gets sent is filtered on the way out.** A CRM error carries customer
 * names, phone numbers and email addresses in its request body, its query
 * string and often its message. Sending that to a third party by accident is a
 * privacy incident dressed as a debugging tool, so `beforeSend` strips it —
 * see `scrub()` below.
 */
import * as Sentry from '@sentry/node';
import type { ErrorEvent, EventHint } from '@sentry/node';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

let started = false;
let activeDsn = '';

/** Keys whose value is never worth the risk of sending anywhere. */
const SENSITIVE_KEY = /pass|secret|token|key|auth|cookie|session|otp|pin|aadhaar|pan|card|cvv/i;

/** Anything shaped like a way to contact a real person. */
const CONTACT_SHAPED = [
  // Email.
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // Indian mobile, with or without country code and separators.
  /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g,
];

/**
 * Remove what a bug report does not need.
 *
 * The rule is that Sentry should be able to tell you *what* broke and *where*,
 * and never *who for*. A stack trace and a route are the useful parts; the
 * buyer's phone number is not, and it is the part that turns a support tool
 * into a data transfer.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;

  if (typeof value === 'string') {
    let out = value;
    for (const pattern of CONTACT_SHAPED) out = out.replace(pattern, '[redacted]');
    return out;
  }

  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(inner, depth + 1);
    }
    return out;
  }

  return value;
}

function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  try {
    if (event.request) {
      // A query string carries search terms, which in a CRM are people's names.
      delete event.request.cookies;
      if (event.request.query_string) event.request.query_string = '[redacted]';
      if (event.request.data) event.request.data = scrub(event.request.data);
      if (event.request.headers) event.request.headers = scrub(event.request.headers) as Record<string, string>;
    }
    if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>;
    if (event.message) event.message = scrub(event.message) as string;
    // Who it happened to is useful; how to contact them is not.
    if (event.user) event.user = { id: event.user.id };
    return event;
  } catch {
    // A scrubber that throws must drop the event, never send it unscrubbed.
    return null;
  }
}

/**
 * Start reporting, or stop.
 *
 * Safe to call repeatedly: the settings page calls it on every save, and a DSN
 * that has not changed is left alone rather than re-initialised.
 */
export function configureSentry(dsn: string, environment?: string): void {
  const next = (dsn || '').trim();

  if (!next) {
    if (started) logger.info('error reporting switched off');
    started = false;
    activeDsn = '';
    return;
  }
  if (next === activeDsn && started) return;

  try {
    Sentry.init({
      dsn: next,
      environment: environment || (config.isProd ? 'production' : 'development'),
      // Errors only. Performance tracing on a five-person CRM is a bill and a
      // dashboard nobody opens; it can be turned on later if it is ever wanted.
      tracesSampleRate: 0,
      // The request body is the single richest source of customer data in this
      // application, so it is never attached.
      sendDefaultPii: false,
      maxValueLength: 2000,
      beforeSend,
    });
    started = true;
    activeDsn = next;
    logger.info({ environment: environment || (config.isProd ? 'production' : 'development') },
      'error reporting is on');
  } catch (err) {
    // Never fatal. A wrong DSN means no reporting, not no CRM.
    logger.warn({ err }, 'could not start error reporting — carrying on without it');
    started = false;
  }
}

/** Whether anything is listening. Used by the admin page to say so. */
export function sentryIsOn(): boolean {
  return started;
}

/**
 * Report one error by hand.
 *
 * For the places that already catch and log — a failed workflow task, a media
 * job that gave up. Those are exactly the failures nobody sees today, because
 * they are handled well enough not to reach a user and badly enough that
 * nothing gets fixed.
 */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  if (!started) return;
  try {
    Sentry.captureException(err, context ? { extra: scrub(context) as Record<string, unknown> } : undefined);
  } catch {
    // Reporting a failure must not itself become one.
  }
}

/** Exposed for the test that proves customer data never leaves. */
export const __testing = { scrub, beforeSend };
