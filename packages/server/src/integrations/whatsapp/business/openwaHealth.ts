/**
 * Is OpenWA alive, and is the phone still linked?
 *
 * The CRM keeps working when OpenWA is down — nothing here can stop a page
 * loading — but the people using the chat panel must be told, in words, that a
 * send will fail, and an admin must see the same fact on the Health page
 * without opening a log. So once a minute (only while the OpenWA card is on)
 * the CRM asks OpenWA for the session, remembers the answer in memory for the
 * chat panel's banner, writes it into `whatsapp.last_poll` — the row the
 * existing WhatsApp Health page already reads for "are replies reaching us?" —
 * and logs every change of state once, rather than every minute.
 */
import { db } from '../../../db/pool.js';
import { getIntegrationConfig } from '../../../core/settings/integrations.js';
import { logger } from '../../../utils/logger.js';
import { organisationTimezone } from '../../../core/settings/timezone.js';
import {
  describeSessionStatus, maskPhone, openWaSession, openWaStats, OPENWA_PROVIDER,
} from './openwa.js';

export type LinkState = 'ready' | 'needs-link' | 'unreachable' | 'unknown';

export interface LinkHealth {
  state: LinkState;
  /** One plain sentence for the banner and the Health page. */
  message: string;
  checkedAt: string | null;
  status: string | null;
  phoneMasked: string | null;
  /** Set while OpenWA's own daily allowance has paused sending, until it comes back. */
  pausedUntil?: string | null;
}

let current: LinkHealth = { state: 'unknown', message: 'OpenWA has not been checked yet.', checkedAt: null, status: null, phoneMasked: null };

export function currentLinkHealth(): LinkHealth {
  const until = openWaStats.pausedUntil;
  return until && Date.parse(until) > Date.now() ? { ...current, pausedUntil: until } : current;
}

/** A `session.status` webhook is fresher than the minute timer, so it updates the banner at once. */
export function rememberSessionStatus(status: string): void {
  const state: LinkState = status === 'ready' ? 'ready' : 'needs-link';
  record({
    state,
    message: state === 'ready'
      ? 'WhatsApp is linked and OpenWA is ready.'
      : `WhatsApp is not connected in OpenWA (${describeSessionStatus(status)}). Messages cannot be sent until it is.`,
    checkedAt: new Date().toISOString(),
    status,
    phoneMasked: current.phoneMasked,
  });
}

function record(next: LinkHealth): void {
  if (next.state !== current.state) {
    // One line per change, so a log is a short history instead of a minute-by-minute drone.
    (next.state === 'ready' ? logger.info : logger.warn).call(logger, { from: current.state, to: next.state, status: next.status }, 'OpenWA link state changed');
  }
  current = next;
}

/** Ask OpenWA now, remember the answer, and write it where the Health page looks. */
export async function checkOpenWaNow(): Promise<LinkHealth> {
  let next: LinkHealth;
  try {
    const s = await openWaSession({ fresh: true });
    const ready = s.status === 'ready';
    next = {
      state: ready ? 'ready' : 'needs-link',
      message: ready
        ? `Session "${s.name}" is ready.`
        : `Session "${s.name}" is ${describeSessionStatus(s.status)}. Messages cannot be sent until the phone is linked again.`,
      checkedAt: new Date().toISOString(),
      status: s.status,
      phoneMasked: maskPhone(s.phone),
    };
  } catch (err) {
    next = {
      state: 'unreachable',
      message: (err as Error).message,
      checkedAt: new Date().toISOString(),
      status: null,
      phoneMasked: current.phoneMasked,
    };
  }
  record(next);
  await writeSummary(next);
  return next;
}

async function sendsToday(): Promise<{ ok: number; failed: number }> {
  const tz = await organisationTimezone();
  const row = await db.queryOne<{ ok: string; failed: string }>(
    `SELECT COUNT(*) FILTER (WHERE status <> 'failed') AS ok,
            COUNT(*) FILTER (WHERE status = 'failed')  AS failed
       FROM ipy_message
      WHERE provider = $1 AND direction = 'outbound' AND sent_by IS NOT NULL
        AND created_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [OPENWA_PROVIDER, tz],
  );
  return { ok: Number(row?.ok ?? 0), failed: Number(row?.failed ?? 0) };
}

/** The numbers the Health page shows, all in one object. */
export async function openWaMetrics(): Promise<LinkHealth & {
  lastWebhookAt: string | null; rejectedWebhooks: number; unresolvedSenders: number;
  sendsToday: number; sendsFailedToday: number;
}> {
  const today = await sendsToday();
  return {
    ...current,
    lastWebhookAt: openWaStats.lastWebhookAt,
    rejectedWebhooks: openWaStats.rejectedWebhooks,
    unresolvedSenders: openWaStats.unresolvedSenders,
    sendsToday: today.ok,
    sendsFailedToday: today.failed,
  };
}

async function writeSummary(health: LinkHealth): Promise<void> {
  try {
    await db.query(
      `INSERT INTO ipy_setting (key, value, category, label, updated_at)
       VALUES ('whatsapp.last_poll', $1::jsonb, 'whatsapp', 'Last WhatsApp inbound check', now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ at: health.checkedAt, ok: health.state === 'ready', detail: `OpenWA: ${health.message}` })],
    );
  } catch (err) {
    logger.warn({ err }, 'could not write the OpenWA health summary');
  }
}

const EVERY_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let checking = false;

export function startOpenWaHealth(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Only while the card is switched on; a CRM that does not use OpenWA
    // should never talk to it.
    if (checking || !getIntegrationConfig(OPENWA_PROVIDER)) return;
    checking = true;
    void checkOpenWaNow()
      .catch((err) => logger.warn({ err }, 'OpenWA health check failed'))
      .finally(() => { checking = false; });
  }, EVERY_MS);
  timer.unref?.();
}

export function stopOpenWaHealth(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function __resetLinkHealth(): void {
  current = { state: 'unknown', message: 'OpenWA has not been checked yet.', checkedAt: null, status: null, phoneMasked: null };
}
