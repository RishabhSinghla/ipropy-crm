import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

// Throttle so a crash loop can't hammer the endpoint with thousands of posts.
let lastReportAt = 0;
const MIN_INTERVAL_MS = 10_000;

/**
 * Best-effort error reporting. Posts a JSON payload to the configured Sentry
 * DSN (legacy Store API) when SENTRY_DSN is set; otherwise this is a no-op.
 * Fire-and-forget — reporting must never take the request path down.
 */
export function reportError(err: unknown, context: { path?: string; userId?: string; requestId?: string }): void {
  if (!config.sentry.dsn) return;

  const now = Date.now();
  if (now - lastReportAt < MIN_INTERVAL_MS) return;
  lastReportAt = now;

  const message = err instanceof Error ? err.message : String(err);
  const body = {
    event_id: randomUUID().replace(/-/g, ''),
    platform: 'node',
    message,
    level: 'error',
    timestamp: new Date().toISOString(),
    server_name: process.env.HOSTNAME ?? 'ipropy-server',
    environment: config.env,
    exception: {
      values: [
        {
          type: err instanceof Error ? err.constructor.name : 'UnknownError',
          value: message,
        },
      ],
    },
    extra: { path: context.path, userId: context.userId, requestId: context.requestId },
  };

  void fetch(config.sentry.dsn, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}
