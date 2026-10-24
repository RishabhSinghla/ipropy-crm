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
}

export const DEFAULT_LIMITS: GuardLimits = { perUserDaily: 60, perNumberDaily: 15, minSpacingSeconds: 10 };

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
  };
}

export interface SendCounts {
  userToday: number;
  numberToday: number;
  /** Seconds since the company number last sent anything from the CRM; null when never today. */
  secondsSinceLast: number | null;
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; code: 'USER_DAILY_CAP' | 'NUMBER_DAILY_CAP' | 'TOO_SOON'; message: string; retryAfterSeconds?: number };

/** Pure: the rules, given the counts. Tested without a database. */
export function decideSend(limits: GuardLimits, counts: SendCounts): GuardVerdict {
  if (counts.secondsSinceLast !== null && counts.secondsSinceLast < limits.minSpacingSeconds) {
    const wait = Math.ceil(limits.minSpacingSeconds - counts.secondsSinceLast);
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
export async function currentCounts(userId: string, handle: string): Promise<SendCounts> {
  const tz = await organisationTimezone();
  const row = await db.queryOne<{ user_today: string; number_today: string; since: string | null }>(
    `WITH today AS (SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS start)
     SELECT COUNT(*) FILTER (WHERE m.sent_by = $2 AND m.created_at >= today.start)         AS user_today,
            COUNT(*) FILTER (WHERE c.handle = $3 AND m.created_at >= today.start)          AS number_today,
            EXTRACT(EPOCH FROM (now() - MAX(m.created_at)))                                AS since
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
       CROSS JOIN today
      WHERE m.provider = $4 AND m.direction = 'outbound' AND m.sent_by IS NOT NULL
        AND m.status <> 'failed' AND m.created_at >= now() - interval '1 day'`,
    [tz, userId, handle, OPENWA_PROVIDER],
  );
  return {
    userToday: Number(row?.user_today ?? 0),
    numberToday: Number(row?.number_today ?? 0),
    secondsSinceLast: row?.since === null || row?.since === undefined ? null : Number(row.since),
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
export async function assertWithinLimits(userId: string, handle: string): Promise<void> {
  const verdict = decideSend(guardLimits(), await currentCounts(userId, handle));
  if (!verdict.ok) throw new BadRequestError(verdict.message);
}
