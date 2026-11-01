/**
 * The brakes on a linked-device connection.
 *
 * WhatsApp does not officially bless gateways like OpenWA, and the thing that
 * gets a number restricted is not linking a device — it is a pattern that
 * looks like a machine: many messages, to many strangers, close together. So
 * the CRM, which is the only thing that can ask OpenWA to send, puts four
 * limits in front of it, all of them here and all of them checked **before**
 * a message row is written:
 *
 *  1. a daily cap per CRM user;
 *  2. a daily cap per customer number (a rep cannot spam one person either);
 *  3. a minimum gap between any two sends from the company number;
 *  4. the send must be to a number tied to a chat or record the user may open
 *     (decided in the route, where the user's permissions are known).
 *
 * There is no "send to many" endpoint anywhere: the request takes one `to`,
 * and the campaign and workflow paths send *templates*, which this provider
 * does not have, so they refuse to use it (and campaigns are refused by name).
 *
 * The defaults are deliberately conservative and live on the integration card
 * so an admin can see and change them. They are clamped, so a typo cannot
 * switch the brakes off.
 */
import { getIntegrationConfig } from '../../../core/settings/integrations.js';
import { organisationTimezone } from '../../../core/settings/timezone.js';
import { db } from '../../../db/pool.js';
import { BadRequestError } from '../../../utils/errors.js';
import { OPENWA_PROVIDER } from './openwa.js';

export interface GuardLimits {
  perUserDaily: number;
  perNumberDaily: number;
  minSpacingSeconds: number;
  /** Quiet hours in the organisation's timezone: no CRM sends from `quietFrom` (inclusive) to `quietTo` (exclusive), 0-23. Null = off. */
  quietFrom: number | null;
  quietTo: number | null;
}

export const DEFAULT_LIMITS: GuardLimits = { perUserDaily: 60, perNumberDaily: 15, minSpacingSeconds: 10, quietFrom: null, quietTo: null };

function hourOrNull(raw: unknown): number | null {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

/** Pure: is this hour inside the quiet window? The window may wrap midnight (21 to 8). Equal ends mean off. */
export function inQuietHours(from: number | null, to: number | null, hour: number): boolean {
  if (from === null || to === null || from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

function clampedNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** The limits as configured on the card, clamped into a sensible range. */
export function guardLimits(): GuardLimits {
  const config = getIntegrationConfig(OPENWA_PROVIDER) ?? {};
  return {
    perUserDaily: clampedNumber(config.dailyCapPerUser, DEFAULT_LIMITS.perUserDaily, 1, 500),
    perNumberDaily: clampedNumber(config.dailyCapPerNumber, DEFAULT_LIMITS.perNumberDaily, 1, 100),
    // Never below 3 seconds: the whole point of the gap.
    minSpacingSeconds: clampedNumber(config.minSpacingSeconds, DEFAULT_LIMITS.minSpacingSeconds, 3, 600),
    quietFrom: hourOrNull(config.quietHoursFrom),
    quietTo: hourOrNull(config.quietHoursTo),
  };
}

/**
 * A person does not send on a metronome. When the minimum gap is 10 seconds or more, each check asks for up to half
 * as much again (random), so sends from one number never land at an exact rhythm. Short gaps (used in tests) get none.
 */
export function jitterSeconds(minSpacingSeconds: number, random: () => number = Math.random): number {
  return minSpacingSeconds >= 10 ? Math.round(random() * minSpacingSeconds * 0.5) : 0;
}

export interface SendCounts {
  userToday: number;
  numberToday: number;
  /** Seconds since the company number last sent anything from the CRM; null when never today. */
  secondsSinceLast: number | null;
  /** Extra random seconds on top of the minimum gap, decided by the caller. */
  jitter?: number;
  /** When the previous send happened (ms); the jitter is derived from it so retries see the same gap. */
  lastSentAtMs?: number | null;
  /** The hour of day (0-23) in the organisation's timezone right now. */
  localHour?: number;
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; code: 'USER_DAILY_CAP' | 'NUMBER_DAILY_CAP' | 'TOO_SOON' | 'QUIET_HOURS'; message: string; retryAfterSeconds?: number };

/** Pure: the rules, given the counts. Tested without a database. */
export function decideSend(limits: GuardLimits, counts: SendCounts): GuardVerdict {
  if (counts.localHour !== undefined && inQuietHours(limits.quietFrom, limits.quietTo, counts.localHour)) {
    return {
      ok: false, code: 'QUIET_HOURS',
      message: `WhatsApp messages from the CRM are paused between ${limits.quietFrom}:00 and ${limits.quietTo}:00 so customers are not messaged at night. Please send after ${limits.quietTo}:00.`,
    };
  }
  const gap = limits.minSpacingSeconds + (counts.jitter ?? 0);
  if (counts.secondsSinceLast !== null && counts.secondsSinceLast < gap) {
    const wait = Math.ceil(gap - counts.secondsSinceLast);
    return {
      ok: false, code: 'TOO_SOON', retryAfterSeconds: wait,
      message: `Messages from the company number are spaced out to keep it safe. Please wait ${wait} more second${wait === 1 ? '' : 's'}.`,
    };
  }
  if (counts.userToday >= limits.perUserDaily) {
    return {
      ok: false, code: 'USER_DAILY_CAP',
      message: `You have reached today's limit of ${limits.perUserDaily} WhatsApp messages from the CRM. It resets at midnight; an admin can change the limit in Integrations.`,
    };
  }
  if (counts.numberToday >= limits.perNumberDaily) {
    return {
      ok: false, code: 'NUMBER_DAILY_CAP',
      message: `This customer has already had ${limits.perNumberDaily} messages from the CRM today. Please continue from the phone or try tomorrow.`,
    };
  }
  return { ok: true };
}

/** What has gone out today, counted from the CRM's own rows. A failed message does not count: nothing was sent. */
export async function currentCounts(userId: string, handle: string, numberId: string | null = null): Promise<SendCounts> {
  const tz = await organisationTimezone();
  const row = await db.queryOne<{ user_today: string; number_today: string; since: string | null; last_ms: string | null }>(
    `WITH today AS (SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS start)
     SELECT COUNT(*) FILTER (WHERE m.sent_by = $2 AND m.created_at >= today.start)         AS user_today,
            COUNT(*) FILTER (WHERE c.handle = $3 AND m.created_at >= today.start)          AS number_today,
            EXTRACT(EPOCH FROM (now() - MAX(m.created_at)))                                AS since,
            (EXTRACT(EPOCH FROM MAX(m.created_at)) * 1000)::bigint                         AS last_ms
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
       CROSS JOIN today
      WHERE m.provider = $4 AND m.direction = 'outbound' AND m.sent_by IS NOT NULL
        AND m.status <> 'failed' AND m.created_at >= now() - interval '1 day'
        AND ($5::uuid IS NULL OR m.number_id = $5::uuid)`,
    [tz, userId, handle, OPENWA_PROVIDER, numberId],
  );
  return {
    userToday: Number(row?.user_today ?? 0),
    numberToday: Number(row?.number_today ?? 0),
    secondsSinceLast: row?.since === null || row?.since === undefined ? null : Number(row.since),
    lastSentAtMs: row?.last_ms ? Number(row.last_ms) : null,
  };
}

// One send is decided at a time. The check and the write of the queued row
// must not interleave with another send's, or two clicks in the same moment
// both see "nothing sent yet". (One server process today; if the CRM is ever
// scaled out, move this to a Postgres advisory lock.)
let tail: Promise<void> = Promise.resolve();

/** Take the one slot. Call the returned function once the queued row is written (or the send is abandoned). */
export function takeSendSlot(): Promise<() => void> {
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const turn = tail.then(() => release);
  tail = tail.then(() => mine);
  return turn;
}

/** Refuse, with the reason, if this send would break a limit. */
export async function assertWithinLimits(userId: string, handle: string, numberId: string | null = null): Promise<void> {
  // The spacing and daily caps are counted per number, so one agent's busy day never slows another's.
  const limits = guardLimits();
  const counts = await currentCounts(userId, handle, numberId);
  // Random-looking but fixed for a given previous send: a retry after the shown wait must not meet a longer gap.
  const seed = counts.lastSentAtMs ?? 0;
  const tz = await organisationTimezone();
  const localHour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date()));
  const verdict = decideSend(limits, { ...counts, localHour, jitter: jitterSeconds(limits.minSpacingSeconds, () => (seed % 997) / 997) });
  if (!verdict.ok) throw new BadRequestError(verdict.message);
}
