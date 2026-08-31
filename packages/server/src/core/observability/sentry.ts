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
import { redactContactDetails } from '@ipropy/shared';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

let started = false;
let activeDsn = '';

/** Matches `maxValueLength` below: past this, Sentry discards it anyway. */
const MAX_STRING = 2000;

/** Keys whose value is never worth the risk of sending anywhere. */
const SENSITIVE_KEY = /pass|secret|token|key|auth|cookie|session|otp|pin|aadhaar|pan|card|cvv/i;

/**
 * Remove what a bug report does not need.
 *
 * The rule is that Sentry should be able to tell you *what* broke and *where*,
 * and never *who for*. A stack trace and a route are the useful parts; the
 * buyer's phone number is not, and it is the part that turns a support tool
 * into a data transfer.
 */
function scrub(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  /*
    The depth limit used to be 6, and it leaked. A CRM request body nests
    further than that on its own — envelope, records array, record, values
    object, address, and the phone sits below all of it — so anything deeper
    than six levels came out untouched. Cycles are now handled by `seen` rather
    than by a shallow limit, which is what makes it safe to go deeper; the limit
    that remains is only a backstop against something pathological.
  */
  if (depth > 24) return '[too deep to check]';

  if (typeof value === 'string') {
    /*
      Truncate before scanning, and that is not an optimisation.

      Scanning cost is quadratic in length: 2,000 characters took 3ms, 8,000
      took 44ms, 32,000 took 600ms and 64,000 took 2.1 seconds. This runs inside
      the error handler, on the request path, so a single large error message —
      a base64 data URI in a failed upload, a long SQL string, a stack from a
      deep recursion — would block the event loop for seconds. An error reporter
      that can freeze the server is worse than no error reporter.

      2,000 is not arbitrary: it is the `maxValueLength` Sentry is configured
      with below, so everything past it was going to be thrown away at the far
      end regardless. Nothing is lost that would have been kept.
    */
    const capped = value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} more characters]`
      : value;

    return redactContactDetails(capped);
  }

  if (!value || typeof value !== 'object') return value;

  // A repeat is a cycle. Dropping it is right: the first occurrence was scrubbed
  // and returning the raw object here would hand back everything below it.
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1, seen));

  /*
    Anything that is not a plain object is turned into a string and scrubbed as
    one. A Map, a Buffer, a class instance with a private field — walking those
    with Object.entries finds nothing and returns the original, so the contents
    escape untouched.
  */
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    try {
      return scrub(String(value), depth + 1, seen);
    } catch {
      return '[unreadable]';
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(inner, depth + 1, seen);
  }
  return out;
}

/** A URL keeps its shape and loses its search terms — which are people's names. */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // The path is scrubbed as well as kept. This branch used to return it
    // untouched while the fallback below scrubbed, so an address sitting in a
    // path survived purely because the URL happened to be absolute.
    return scrub(`${url.origin}${url.pathname}`) as string;
  } catch {
    // Not absolute, so no query to strip beyond what scrub already removed.
    return scrub(raw.split('?')[0] ?? raw) as string;
  }
}

function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  try {
    if (event.request) {
      // A query string carries search terms, which in a CRM are people's names.
      delete event.request.cookies;
      if (event.request.query_string) event.request.query_string = '[redacted]';
      // The URL carries the same query string a second time, and this was
      // missed: the browser half stripped it and the server half did not.
      if (event.request.url) event.request.url = safeUrl(event.request.url);
      /*
        Never scrubbed — removed. A request body in this CRM is a person, and a
        filter can only catch the parts that have a shape. A name has none.
      */
      delete event.request.data;
      if (event.request.headers) event.request.headers = scrub(event.request.headers) as Record<string, string>;
    }

    /*
      Where a thrown Error's text actually lands.

      This was the real hole. `message` is only set for `captureMessage`; an
      ordinary `throw new Error(\`No lead for \${mobile}\`)` — which is how this
      codebase raises nearly everything — puts that text in
      `exception.values[].value` instead, and nothing here touched it. So the
      single most likely way for a customer's number to reach Sentry was the one
      path left open.
    */
    for (const entry of event.exception?.values ?? []) {
      if (entry.value) entry.value = scrub(entry.value) as string;
      // Local variables captured from a stack frame are function arguments —
      // in this codebase that means record ids, phone numbers and query params.
      for (const frame of entry.stacktrace?.frames ?? []) {
        if (frame.vars) frame.vars = scrub(frame.vars) as Record<string, unknown>;
      }
    }

    // Tags and contexts are free-form and anything can be put in them.
    if (event.tags) event.tags = scrub(event.tags) as typeof event.tags;
    if (event.contexts) event.contexts = scrub(event.contexts) as typeof event.contexts;
    if (event.breadcrumbs) event.breadcrumbs = scrub(event.breadcrumbs) as typeof event.breadcrumbs;
    if (event.transaction) event.transaction = scrub(event.transaction) as string;

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
      sendDefaultPii: false,
      maxValueLength: 2000,
      /*
        `sendDefaultPii: false` does NOT stop the request body being captured,
        and this code used to say it did. The SDK gates that on
        `maxRequestBodySize !== 'none'` alone — see
        @sentry/core/integrations/http/server-subscription.js:56 — which defaults
        to capturing up to 10 KB.

        So every 5xx was sending the body that caused it, and in this application
        the body of a failing request is a lead: their name, their number, their
        budget. The scrubber caught the number and the email; a name is not
        machine-detectable and was going out whole.

        Turned off at the source here, and deleted again in `beforeSend` below.
        Twice on purpose: this one is an SDK default that could change under us,
        and that one cannot.
      */
      integrations: [
        Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none', breadcrumbs: false }),
      ],
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
export const __testing = { scrub, beforeSend, safeUrl };
