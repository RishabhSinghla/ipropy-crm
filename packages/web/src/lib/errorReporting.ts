/**
 * Reporting a crash the rep never mentions.
 *
 * The server half of this catches what reaches an API route. It cannot see the
 * other half — a component that throws, a blank screen, a button that silently
 * does nothing — and that half is most of what a person means by "it's broken".
 *
 * Loaded lazily and started only when a DSN is configured, so a CRM with error
 * reporting switched off never downloads the library at all. That matters more
 * here than on the server: this is a bundle a phone on mobile data has to fetch
 * before anybody can look at a lead.
 *
 * What it sends is filtered exactly as the server's is. A CRM screen is full of
 * customer names and phone numbers, and a breadcrumb trail through it would
 * carry them to a third party — which is a privacy incident wearing the clothes
 * of a debugging tool.
 */
import { redactContactDetails } from '@ipropy/shared';

/*
  The same redaction the server uses, from the same file.

  These were two implementations, and they drifted immediately: twelve phone
  formats were fixed on the server and stayed broken here — which is the worse
  half, because a crash in the browser carries whatever was on the screen, and
  what is on the screen in a CRM is a person.
*/
const redact = redactContactDetails;

/**
 * A record's id is a UUID and tells you which record broke; a record's *name*
 * is a person. So a URL keeps its shape and loses its search terms.
 */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw, window.location.origin);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[unparseable]';
  }
}

let started = false;

export async function startErrorReporting(): Promise<void> {
  if (started) return;

  let dsn: string | null = null;
  let environment = 'production';
  try {
    const res = await fetch('/api/public/client-config');
    if (!res.ok) return;
    const cfg = await res.json() as { sentryDsn: string | null; environment?: string };
    dsn = cfg.sentryDsn;
    environment = cfg.environment ?? environment;
  } catch {
    // No config, no reporting. Never a reason to stop the app loading.
    return;
  }

  if (!dsn) return;

  try {
    const Sentry = await import('@sentry/react');
    Sentry.init({
      dsn,
      environment,
      // No tracing and no replay. Replay records the screen, and this screen is
      // full of customer names and numbers — that is a decision for the owner
      // to make deliberately, not something to switch on with error reporting.
      tracesSampleRate: 0,
      sendDefaultPii: false,
      beforeSend(event) {
        try {
          if (event.request?.url) event.request.url = safeUrl(event.request.url);
          if (event.message) event.message = redact(event.message);
          for (const value of event.exception?.values ?? []) {
            if (value.value) value.value = redact(value.value);
          }
          // A breadcrumb trail through a CRM is a list of who was looked at.
          event.breadcrumbs = (event.breadcrumbs ?? []).map((crumb) => ({
            ...crumb,
            message: crumb.message ? redact(crumb.message) : crumb.message,
            data: crumb.data && typeof crumb.data === 'object'
              ? Object.fromEntries(Object.entries(crumb.data).map(([k, v]) => [
                k, typeof v === 'string' ? redact(safeUrlIfUrl(v)) : v,
              ]))
              : crumb.data,
          }));
          // `extra` was never touched on this side, and it is where anything
          // attached by hand ends up.
          if (event.extra) {
            event.extra = Object.fromEntries(Object.entries(event.extra).map(([k, v]) => [
              k, typeof v === 'string' ? redact(v) : v,
            ]));
          }
          if (event.user) event.user = { id: event.user.id };
          return event;
        } catch {
          // A filter that throws drops the event rather than sending it raw.
          return null;
        }
      },
    });
    started = true;
  } catch {
    // A missing or broken SDK must never stop the CRM rendering.
  }
}

function safeUrlIfUrl(value: string): string {
  return /^https?:\/\//i.test(value) || value.startsWith('/') ? safeUrl(value) : value;
}
