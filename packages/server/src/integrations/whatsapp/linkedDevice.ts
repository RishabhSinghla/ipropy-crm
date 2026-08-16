/**
 * WhatsApp through a phone that is already signed in.
 *
 * There are three ways a message can leave this CRM, and they are not
 * alternatives so much as a ladder:
 *
 *   1. Meta's Cloud API (`provider.ts`) — sanctioned, needs approval and a
 *      paid BSP, charges per conversation, and only lets you write freely
 *      inside a 24-hour window.
 *   2. A linked phone (this file) — the same trick WhatsApp Web uses. The rep's
 *      own number, no approval, no window, no fee, and WhatsApp does not permit
 *      it.
 *   3. `deviceSend.ts` — the CRM writes the message and a person taps send.
 *
 * The third is the floor and never goes away: a queued message belonging to
 * somebody with no linked phone still waits in Outreach for a thumb, exactly as
 * before. This file only intercepts rows it can actually send.
 *
 * ## The part that decides whether this works
 *
 * Nothing here is difficult except not getting the number banned, and that is
 * decided by behaviour rather than by technique. WhatsApp tolerates a number
 * that answers people who wrote first and sends at a human pace; it removes one
 * that wakes up and fires sixty messages at strangers. So the pacing, the daily
 * ceiling and the warm-up live in the database and are enforced on the way out
 * of the CRM, not in the bridge.
 *
 * That placement is the whole point. The bridge is a script on a laptop that
 * gets restarted, run twice by accident, and edited by whoever is curious.
 * Anything it remembers about pacing is forgotten on restart, and the first
 * thing an amnesiac bridge does is send the backlog in one burst. So the CRM
 * hands out **one message at a time per number** and refuses the next until the
 * gap has passed. A bridge polling in a tight loop cannot make the CRM go
 * faster, and a bridge that crashes mid-send loses at most one message.
 */
import { toE164 } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { getSettings } from '../../core/settings/integrations.js';
import { bus } from '../../core/events/bus.js';
import { organisationTimezone } from '../../core/capture/captureTime.js';
import { isOptedOut } from './consent.js';
import { logDeviceMessage } from './deviceSend.js';

// ---------------------------------------------------------------------------
// Pacing and ceilings
// ---------------------------------------------------------------------------

/**
 * The shortest gap between two messages from one number, and how much random
 * padding sits on top.
 *
 * Forty seconds plus up to eighty is an average of about eighty seconds, so a
 * number does roughly forty-five an hour flat out. The jitter matters more than
 * the floor: a perfectly even cadence is itself a signal, because people do not
 * send messages exactly every forty seconds for an hour.
 */
export const MIN_GAP_SECONDS = 40;

/**
 * The most human-typed replies one number will send in a rolling hour.
 *
 * Not a pacing policy — the pacing is the daily cap and the gap, and typed
 * replies deliberately skip both. This is the stop on a runaway loop: nobody
 * types a hundred and twenty messages in an hour, so hitting this means code
 * is sending them, and the number is worth more than the backlog.
 */
export const HUMAN_HOURLY_CEILING = 120;

/** Typed replies actually sent from this number in the last rolling hour. */
async function sentInLastHour(linkId: string): Promise<number> {
  const row = await db.queryOne<{ n: string }>(
    `SELECT count(*) AS n FROM ipy_device_send
      WHERE wa_link_id = $1 AND priority = 'immediate'
        AND status = 'sent' AND completed_at > now() - interval '1 hour'`,
    [linkId],
  );
  return Number(row?.n ?? 0);
}
export const GAP_JITTER_SECONDS = 80;

/**
 * How many a number may send in a day, by how long it has been linked.
 *
 * A number that has been quietly conversing for years and a number linked this
 * morning look completely different to whatever WhatsApp uses to spot
 * automation, and the new one is the one that gets removed. Starting at
 * twenty-five and reaching the full allowance after a fortnight costs almost
 * nothing on a property desk, where the honest daily volume is tens rather than
 * hundreds.
 */
const WARM_UP: { afterDays: number; cap: number }[] = [
  { afterDays: 14, cap: 200 },
  { afterDays: 7, cap: 100 },
  { afterDays: 3, cap: 50 },
  { afterDays: 0, cap: 25 },
];

export function warmUpCap(linkedAt: Date | string | null, now = new Date()): number {
  if (!linkedAt) return WARM_UP[WARM_UP.length - 1]!.cap;
  const days = (now.getTime() - new Date(linkedAt).getTime()) / 86_400_000;
  return WARM_UP.find((step) => days >= step.afterDays)?.cap ?? WARM_UP[WARM_UP.length - 1]!.cap;
}

/**
 * The hour of day where this business is, not where the server is.
 *
 * `new Date().getHours()` reads the process timezone, which is UTC in every
 * container unless somebody sets TZ. In India that is five and a half hours
 * early, so a "no sending after 9pm" rule written the obvious way starts
 * refusing at half past two in the afternoon and allows sending at half past
 * three in the morning. This codebase has already shipped that bug once, in the
 * filter engine, and the fix there was the same: ask Intl.
 */
export function hourInZone(timeZone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    return hour ? Number(hour) % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/** Sending hours, deliberately wider than office hours and narrower than a day. */
export const SEND_FROM_HOUR = 8;
export const SEND_UNTIL_HOUR = 21;

export function withinSendingHours(timeZone: string, now = new Date()): boolean {
  const hour = hourInZone(timeZone, now);
  return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
}

// ---------------------------------------------------------------------------
// The link record
// ---------------------------------------------------------------------------

export type LinkStatus = 'pending' | 'connected' | 'logged_out' | 'disabled';

export interface WaLink {
  id: string;
  userId: string;
  userName: string | null;
  handle: string | null;
  label: string | null;
  status: LinkStatus;
  qr: string | null;
  qrExpiresAt: string | null;
  linkedAt: string | null;
  lastSeenAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  sentToday: number;
  sentTotal: number;
  dailyCap: number;
  takesUnassigned: boolean;
}

interface LinkRow {
  id: string; user_id: string; user_name: string | null; handle: string | null;
  label: string | null; status: LinkStatus; qr: string | null; qr_expires_at: string | null;
  linked_at: string | null; last_seen_at: string | null; last_sent_at: string | null;
  last_error: string | null; sent_today: number; sent_today_on: string | null;
  sent_total: number; daily_cap: number | null; takes_unassigned: boolean;
}

const LINK_COLUMNS = `
  l.id, l.user_id, trim(u.first_name || ' ' || u.last_name) AS user_name,
  l.handle, l.label, l.status, l.qr, l.qr_expires_at, l.linked_at, l.last_seen_at,
  l.last_sent_at, l.last_error, l.sent_today, l.sent_today_on, l.sent_total,
  l.daily_cap, l.takes_unassigned`;

/**
 * Today's count, read as zero when the stored count belongs to a previous day.
 *
 * The counter is reset lazily rather than by a nightly job: a job that has to
 * run for a limit to be correct is a limit that silently doubles the first time
 * the job does not run.
 */
function sentToday(row: LinkRow, today: string): number {
  return row.sent_today_on === today ? row.sent_today : 0;
}

function todayIn(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function toLink(row: LinkRow, today: string): WaLink {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    handle: row.handle,
    label: row.label,
    status: row.status,
    qr: row.qr,
    qrExpiresAt: row.qr_expires_at,
    linkedAt: row.linked_at,
    lastSeenAt: row.last_seen_at,
    lastSentAt: row.last_sent_at,
    lastError: row.last_error,
    sentToday: sentToday(row, today),
    sentTotal: row.sent_total,
    dailyCap: row.daily_cap ?? warmUpCap(row.linked_at),
    takesUnassigned: row.takes_unassigned,
  };
}

export function isLinkedSendingEnabled(): boolean {
  return getSettings().whatsappLinked.active;
}

export async function listLinks(): Promise<WaLink[]> {
  const today = todayIn(await organisationTimezone());
  const res = await db.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM ipy_wa_link l
     JOIN ipy_user u ON u.id = l.user_id
     ORDER BY l.created_at`,
  );
  return res.rows.map((r) => toLink(r, today));
}

export async function linkForUser(userId: string): Promise<WaLink | null> {
  const today = todayIn(await organisationTimezone());
  const row = await db.queryOne<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM ipy_wa_link l
     JOIN ipy_user u ON u.id = l.user_id
     WHERE l.user_id = $1 AND l.status IN ('pending','connected')
     LIMIT 1`,
    [userId],
  );
  return row ? toLink(row, today) : null;
}

export async function getLink(id: string): Promise<WaLink | null> {
  const today = todayIn(await organisationTimezone());
  const row = await db.queryOne<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM ipy_wa_link l JOIN ipy_user u ON u.id = l.user_id WHERE l.id = $1`,
    [id],
  );
  return row ? toLink(row, today) : null;
}

/**
 * Start a link. The row exists before anything is scanned, because it is what
 * the bridge polls to discover that somebody is waiting for a code.
 *
 * Refused while the Cloud API is configured for the same organisation. A number
 * registered with Meta stops working in the WhatsApp app, so the two paths
 * cannot both be live for one number, and a rep who links the business number
 * here after connecting it there has quietly broken the sanctioned path.
 */
export async function createLink(input: {
  userId: string;
  label?: string | null;
  takesUnassigned?: boolean;
}): Promise<WaLink> {
  const existing = await linkForUser(input.userId);
  if (existing) return existing;

  if (input.takesUnassigned) await clearUnassignedFlag();

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_link (user_id, label, takes_unassigned)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.userId, input.label ?? null, Boolean(input.takesUnassigned)],
  );
  const link = await getLink(row!.id);
  if (!link) throw new Error('link row vanished immediately after insert');
  logger.info({ linkId: link.id, userId: input.userId }, 'whatsapp link created, waiting for a scan');
  return link;
}

async function clearUnassignedFlag(conn: Tx = db): Promise<void> {
  await conn.query(`UPDATE ipy_wa_link SET takes_unassigned = false WHERE takes_unassigned`);
}

export async function setTakesUnassigned(id: string, value: boolean): Promise<void> {
  if (value) await clearUnassignedFlag();
  await db.query(`UPDATE ipy_wa_link SET takes_unassigned = $2, updated_at = now() WHERE id = $1`, [id, value]);
}

export async function setDailyCap(id: string, cap: number | null): Promise<void> {
  if (cap !== null && (!Number.isFinite(cap) || cap < 1)) {
    throw new BadRequestError('A daily limit must be a positive number, or blank to use the warm-up schedule');
  }
  await db.query(`UPDATE ipy_wa_link SET daily_cap = $2, updated_at = now() WHERE id = $1`, [id, cap]);
}

/**
 * Remove a link.
 *
 * Deleted rather than marked `disabled`, so the rep can start again cleanly and
 * the partial unique index stops blocking a fresh link for the same person. The
 * bridge notices the row is gone and drops the session.
 */
export async function removeLink(id: string): Promise<void> {
  const res = await db.query(`DELETE FROM ipy_wa_link WHERE id = $1`, [id]);
  if (!res.rowCount) throw new NotFoundError('That WhatsApp link no longer exists');
}

// ---------------------------------------------------------------------------
// What the bridge writes back
// ---------------------------------------------------------------------------

/** How long a pairing code stays scannable. WhatsApp rotates it about this often. */
const QR_TTL_SECONDS = 60;

export async function setQr(id: string, qr: string): Promise<void> {
  await db.query(
    `UPDATE ipy_wa_link
     SET qr = $2, qr_expires_at = now() + ($3 || ' seconds')::interval,
         status = CASE WHEN status = 'connected' THEN 'pending' ELSE status END,
         last_seen_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, qr, QR_TTL_SECONDS],
  );
}

export async function markConnected(id: string, handle: string): Promise<void> {
  const e164 = toE164(handle) ?? handle;
  await db.query(
    `UPDATE ipy_wa_link
     SET status = 'connected', handle = $2, qr = NULL, qr_expires_at = NULL,
         linked_at = COALESCE(linked_at, now()), last_seen_at = now(),
         last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, e164],
  );
  logger.info({ linkId: id, handle: e164 }, 'whatsapp link connected');
}

export async function markLoggedOut(id: string, reason?: string | null): Promise<void> {
  await db.query(
    `UPDATE ipy_wa_link
     SET status = 'logged_out', qr = NULL, qr_expires_at = NULL,
         last_error = $2, last_seen_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, reason ?? null],
  );
  logger.warn({ linkId: id, reason }, 'whatsapp link logged out');
}

export async function touchSeen(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.query(
    `UPDATE ipy_wa_link SET last_seen_at = now() WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}

/**
 * The links the bridge is responsible for.
 *
 * Includes `pending` ones, because a row waiting for a scan is precisely what
 * tells the bridge to open a session and produce a code. Excludes `disabled`
 * and `logged_out`: reconnecting a number somebody switched off, or one
 * WhatsApp ended, is the bridge deciding something that is not its decision.
 */
export async function linksForBridge(): Promise<WaLink[]> {
  const today = todayIn(await organisationTimezone());
  const res = await db.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM ipy_wa_link l
     JOIN ipy_user u ON u.id = l.user_id
     WHERE l.status IN ('pending','connected')
     ORDER BY l.created_at`,
  );
  return res.rows.map((r) => toLink(r, today));
}

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

export interface ClaimedSend {
  sendId: string;
  linkId: string;
  handle: string;
  body: string;
  name: string | null;
}

export interface ClaimResult {
  messages: ClaimedSend[];
  /** Seconds until it is worth asking again. Purely advisory; the CRM re-checks. */
  retryAfterSeconds: number;
  /** Why nothing was handed out, when nothing was. For the bridge's log. */
  idleReason?: string;
}

/**
 * Hand the bridge at most one message per linked number.
 *
 * One, not a batch. A batch would let the bridge decide the spacing, and the
 * whole reason pacing lives here is that the bridge cannot be trusted to
 * remember anything across a restart.
 *
 * Every gate is re-checked at this moment rather than trusted from when the
 * message was queued, because the interesting ones can all change in between:
 * somebody replies STOP, a rep deletes the lead, the day rolls over and the cap
 * resets, or the clock passes nine in the evening.
 */
export async function claimOutbox(): Promise<ClaimResult> {
  if (!isLinkedSendingEnabled()) {
    return { messages: [], retryAfterSeconds: 60, idleReason: 'linked sending is switched off' };
  }

  const timeZone = await organisationTimezone();
  const now = new Date();
  const today = todayIn(timeZone, now);

  const links = (await linksForBridge()).filter((l) => l.status === 'connected');
  if (!links.length) {
    return { messages: [], retryAfterSeconds: 30, idleReason: 'no connected numbers' };
  }

  const messages: ClaimedSend[] = [];
  const reasons: string[] = [];

  // A reply somebody typed goes first, and goes now.
  //
  // Every limit below this exists because *unsolicited automated* traffic is
  // what costs a number. Someone answering a customer who just messaged them is
  // the ordinary use of WhatsApp, and holding that for up to eighty seconds, or
  // until eight in the morning, makes a chat window nobody will use. The one
  // limit an immediate send keeps is consent, re-read inside claimOneFor: a
  // person typing into a thread cannot overrule an opt-out either.
  //
  // The ceiling is per hour rather than per day, and generous, because it is
  // not really a policy — it is a stop on a loop. A person cannot type a
  // hundred replies in an hour; code with a bug can.
  const open = withinSendingHours(timeZone, now);
  for (const link of links) {
    if (await sentInLastHour(link.id) >= HUMAN_HOURLY_CEILING) {
      reasons.push(`${link.handle ?? link.id}: ${HUMAN_HOURLY_CEILING} messages in the last hour`);
      continue;
    }
    const claimed = await claimOneFor(link, today, 'immediate');
    if (claimed) messages.push(claimed);
  }
  if (messages.length) {
    return { messages, retryAfterSeconds: 1 };
  }

  if (!open) {
    return {
      messages: [],
      retryAfterSeconds: 600,
      idleReason: `outside sending hours (${SEND_FROM_HOUR}:00–${SEND_UNTIL_HOUR}:00 ${timeZone})`,
    };
  }

  for (const link of links) {
    if (link.sentToday >= link.dailyCap) {
      reasons.push(`${link.handle ?? link.id}: daily limit of ${link.dailyCap} reached`);
      continue;
    }
    const waited = link.lastSentAt ? (now.getTime() - new Date(link.lastSentAt).getTime()) / 1000 : Infinity;
    const gap = MIN_GAP_SECONDS + Math.random() * GAP_JITTER_SECONDS;
    if (waited < gap) continue;

    const claimed = await claimOneFor(link, today, 'paced');
    if (claimed) messages.push(claimed);
  }

  return {
    messages,
    // One second while a person is mid-conversation, twenty when idle. The
    // bridge polls; this is what stops it hammering and what stops a typed
    // reply sitting behind a twenty-second sleep.
    retryAfterSeconds: messages.length ? MIN_GAP_SECONDS : 20,
    ...(messages.length ? {} : reasons.length ? { idleReason: reasons.join('; ') } : {}),
  };
}

/**
 * Take one waiting message for this number and mark it claimed, in one
 * statement so two polls cannot both take it.
 *
 * The record join repeats what the human queue already does: a soft-deleted
 * lead keeps its row, so nothing about the queued message breaks when somebody
 * deletes the person it is addressed to, and without this the CRM cheerfully
 * messages them anyway.
 */
async function claimOneFor(
  link: WaLink,
  today: string,
  priority: 'paced' | 'immediate',
): Promise<ClaimedSend | null> {
  const row = await db.queryOne<{ id: string; handle: string; body: string; name: string | null }>(
    `UPDATE ipy_device_send d
     SET status = 'claimed', claimed_at = now(), wa_link_id = $1,
         attempts = d.attempts + 1, assigned_to = COALESCE(d.assigned_to, $2)
     WHERE d.id = (
       SELECT s.id FROM ipy_device_send s
       LEFT JOIN ipy_record r ON r.id = s.record_id
       -- 'opened' as well as 'pending', and this is not a detail. A queued
       -- message also sits in Outreach as a one-tap job, and merely *looking*
       -- at it there marks it opened. Claiming only 'pending' therefore meant a
       -- message could become permanently unsendable by the phone because
       -- somebody glanced at the queue — which is exactly what happened on the
       -- first real reply ever typed into the linked Inbox. Neither status
       -- means sent; markSent and skip have always treated the two the same.
       WHERE s.status IN ('pending', 'opened')
         AND s.priority = $3
         AND (s.assigned_to = $2 ${link.takesUnassigned ? 'OR s.assigned_to IS NULL' : ''})
         AND (s.record_id IS NULL OR r.is_deleted = false)
       ORDER BY s.created_at
       LIMIT 1
       -- OF s, not a bare FOR UPDATE. The deleted-lead check is an outer join,
       -- and Postgres refuses to lock the nullable side of one: a plain
       -- FOR UPDATE here fails outright with "cannot be applied to the nullable
       -- side of an outer join". Only the queue row needs locking anyway.
       FOR UPDATE OF s SKIP LOCKED
     )
     RETURNING d.id, d.handle, d.body, d.name`,
    [link.id, link.userId, priority],
  );
  if (!row) return null;

  // Consent is re-read here rather than trusted from queue time. A message can
  // sit in this queue for days, and "they told us to stop yesterday" is exactly
  // the case that matters.
  if (await isOptedOut(row.handle)) {
    await db.query(
      `UPDATE ipy_device_send
       SET status = 'skipped', completed_at = now(),
           reason = 'Opted out before this could be sent'
       WHERE id = $1`,
      [row.id],
    );
    logger.info({ sendId: row.id }, 'linked send skipped — recipient has opted out');
    return null;
  }

  // Counted at claim rather than at confirmation. Overcounting by one costs a
  // message; undercounting lets a crashed bridge reclaim and resend past the
  // ceiling, which costs the number.
  await db.query(
    `UPDATE ipy_wa_link
     SET sent_today = CASE WHEN sent_today_on = $2::date THEN sent_today + 1 ELSE 1 END,
         sent_today_on = $2::date,
         last_sent_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [link.id, today],
  );

  return { sendId: row.id, linkId: link.id, handle: row.handle, body: row.body, name: row.name };
}

/**
 * What happened to a claimed message.
 *
 * A success writes the same conversation and timeline rows a human tap would,
 * so nothing downstream has to know which path a message took. The one
 * difference is honest: the message is recorded as `sent` rather than
 * `handed_off`, because unlike the wa.me path we genuinely watched it leave.
 */
export async function reportResult(input: {
  sendId: string;
  ok: boolean;
  error?: string | null;
  providerMessageId?: string | null;
}): Promise<void> {
  const row = await db.queryOne<{
    handle: string; body: string; record_id: string | null; attempts: number;
    wa_link_id: string | null; assigned_to: string | null; message_id: string | null;
  }>(
    `SELECT handle, body, record_id, attempts, wa_link_id, assigned_to, message_id
     FROM ipy_device_send WHERE id = $1 AND status = 'claimed'`,
    [input.sendId],
  );
  if (!row) {
    logger.warn({ sendId: input.sendId }, 'result reported for a message that was not claimed');
    return;
  }

  if (input.ok) {
    await db.query(
      `UPDATE ipy_device_send SET status = 'sent', completed_at = now() WHERE id = $1`,
      [input.sendId],
    );
    if (row.wa_link_id) {
      await db.query(`UPDATE ipy_wa_link SET sent_total = sent_total + 1 WHERE id = $1`, [row.wa_link_id]);
    }
    // A send the Inbox already drew updates that bubble. Calling
    // logDeviceMessage here instead would write a second message row and the
    // reply would appear twice in the thread the moment the phone confirmed it.
    if (row.message_id) {
      const updated = await db.queryOne<{ conversation_id: string; body: string | null }>(
        `UPDATE ipy_message
            SET status = 'sent', provider_message_id = COALESCE($2, provider_message_id),
                error_message = NULL
          WHERE id = $1
        RETURNING conversation_id, body`,
        [row.message_id, input.providerMessageId ?? null],
      );
      // So the clock on the bubble becomes a tick while somebody is looking at
      // it, rather than on the next refetch.
      if (updated) {
        bus.emitAsync('message.sent', {
          conversationId: updated.conversation_id,
          messageId: row.message_id,
          direction: 'outbound',
          channel: 'whatsapp',
          body: updated.body,
          handle: row.handle,
          recordId: row.record_id,
        });
      }
      return;
    }
    await logDeviceMessage({
      handle: row.handle,
      body: row.body,
      recordId: row.record_id,
      sentBy: row.assigned_to,
      via: 'linked',
      providerMessageId: input.providerMessageId ?? null,
    });
    return;
  }

  // Two tries, then it goes back to being a job for a person. A number that
  // keeps refusing one recipient is telling you something about that recipient,
  // and retrying it forever is how a queue turns into a loop.
  const giveUp = row.attempts >= 2;
  await db.query(
    `UPDATE ipy_device_send
     SET status = $2, claimed_at = NULL, wa_link_id = NULL,
         reason = COALESCE($3, reason),
         completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
     WHERE id = $1`,
    [
      input.sendId,
      giveUp ? 'failed' : 'pending',
      input.error ? `Could not send from the linked phone: ${input.error}` : null,
    ],
  );
  // Only once it has actually given up. Saying "failed" in the thread while a
  // retry is still coming would have somebody re-typing a message that is
  // about to send itself.
  if (giveUp && row.message_id) {
    const failed = await db.queryOne<{ conversation_id: string }>(
      `UPDATE ipy_message SET status = 'failed', error_message = $2 WHERE id = $1
       RETURNING conversation_id`,
      [row.message_id, input.error ?? 'The linked phone could not send this message'],
    );
    if (failed) {
      bus.emitAsync('message.sent', {
        conversationId: failed.conversation_id,
        messageId: row.message_id,
        direction: 'outbound',
        channel: 'whatsapp',
        body: row.body,
        handle: row.handle,
        recordId: row.record_id,
      });
    }
  }
  logger.warn(
    { sendId: input.sendId, error: input.error, giveUp },
    giveUp ? 'linked send failed twice; leaving it for a person' : 'linked send failed; will retry',
  );
}

/** Release anything a dead bridge left claimed, so it is not stuck forever. */
export async function releaseStaleClaims(olderThanMinutes = 10): Promise<number> {
  const res = await db.query(
    `UPDATE ipy_device_send
     SET status = 'pending', claimed_at = NULL, wa_link_id = NULL
     WHERE status = 'claimed' AND claimed_at < now() - ($1 || ' minutes')::interval`,
    [olderThanMinutes],
  );
  if (res.rowCount) {
    logger.info({ released: res.rowCount }, 'released whatsapp sends left claimed by a stopped bridge');
  }
  return res.rowCount ?? 0;
}
