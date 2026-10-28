/**
 * "A customer has been waiting for a reply" — tell the person who holds the chat.
 *
 * Design: `docs/designs/whatsapp-unanswered-chat-watch.md`. The one rule that shapes everything: **this has no send
 * path.** It reads conversations and writes notifications. It never messages a customer, so it can be wrong in only
 * one direction — an alert somebody did not need.
 *
 * Each minute it finds chats whose customer message has had no reply for longer than the admin's limit, claims each
 * one with a single guarded UPDATE (so two server instances, a restart or a slow tick can never alert twice for the
 * same message), then notifies. The wait is counted in *working* minutes, inside the business hours setting, so a
 * message at 22:00 starts counting at opening time instead of greeting the rep at 09:30 with "waiting 11 hours".
 */
import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { notify, notifyMany } from '../../../core/notifications/index.js';
import { HOLDER, OPTED_OUT } from './inbox.js';

/** Older than this and a chat is not alerted about: first switch-on, or a long outage, must not flood anybody. */
export const WAIT_FLOOR_MINUTES = 360;
const MAX_PER_TICK = 50;
// Large on purpose: the SQL below already removes everything too fresh to count, so this is only a runaway guard,
// not a slice that recent traffic could fill and hide older waiting chats behind.
const CANDIDATE_LIMIT = 2000;
const TICK_MS = 60_000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface WatchSettings { enabled: boolean; firstMinutes: number; secondMinutes: number }

const clampMinutes = (value: unknown, fallback: number): number => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 5), 240);
};

/** Invalid values are clamped, never rejected: an admin typo must not switch the safety net off or flood the team. */
export function readWatchSettings(raw: { enabled?: unknown; first?: unknown; second?: unknown }): WatchSettings {
  const firstMinutes = clampMinutes(raw.first, 15);
  let secondMinutes = clampMinutes(raw.second, 60);
  if (secondMinutes < firstMinutes + 5) secondMinutes = firstMinutes + 5;
  return { enabled: raw.enabled === true, firstMinutes, secondMinutes };
}

async function loadSettings(): Promise<WatchSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM ipy_setting WHERE key LIKE 'whatsapp.wait_watch.%'`,
  );
  const by = Object.fromEntries(rows.map((r) => [r.key.replace('whatsapp.wait_watch.', ''), r.value]));
  return readWatchSettings({ enabled: by.enabled, first: by.first_minutes, second: by.second_minutes });
}

// ---------------------------------------------------------------------------
// The clock: minutes that fall inside business hours
// ---------------------------------------------------------------------------

export interface BusinessHours { start: string; end: string; days: number[]; timezone: string }

let warnedAboutHours = false;

/** Reads the `business_hours` setting; null (always open) when it is missing or cannot be trusted. */
export function parseBusinessHours(raw: unknown): BusinessHours | null {
  const v = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  const time = /^(\d{1,2}):(\d{2})$/;
  const start = typeof v?.start === 'string' ? v.start : '';
  const end = typeof v?.end === 'string' ? v.end : '';
  const days = Array.isArray(v?.days) ? (v!.days as unknown[]).filter((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) as number[] : [];
  const timezone = typeof v?.timezone === 'string' ? v.timezone : '';
  const ok = time.test(start) && time.test(end) && days.length > 0 && minutesOf(end) > minutesOf(start) && validZone(timezone);
  if (!ok) {
    if (!warnedAboutHours) {
      warnedAboutHours = true;
      logger.warn('waiting-for-reply alerts: business_hours is missing or malformed, so the business counts as always open');
    }
    return null;
  }
  return { start, end, days, timezone };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function validZone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return timezone !== ''; } catch { return false; }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(at: number, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    });
    formatters.set(timezone, f);
  }
  const map: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(at))) map[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday ?? '');
  return { y: Number(map.year), mo: Number(map.month), d: Number(map.day), h: Number(map.hour), mi: Number(map.minute), dow };
}

/** The instant at which the clocks in `timezone` read y-mo-d h:mi. Converted through Intl so DST is the zone's, not ours. */
function instantOf(y: number, mo: number, d: number, h: number, mi: number, timezone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const p = parts(result, timezone);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    result += guess - seen;
  }
  return result;
}

/** Whole minutes between `since` and `now` that fall inside open hours. `hours` null means always open. */
export function waitedMinutes(since: Date, now: Date, hours: BusinessHours | null): number {
  const from = since.getTime();
  const to = now.getTime();
  if (to <= from) return 0;
  if (!hours) return Math.floor((to - from) / 60_000);

  const startMin = minutesOf(hours.start);
  const endMin = minutesOf(hours.end);
  let total = 0;
  // Walk local calendar days from the day `since` falls on to the day `now` falls on.
  const first = parts(from, hours.timezone);
  const last = parts(to, hours.timezone);
  const dayCount = Math.round((Date.UTC(last.y, last.mo - 1, last.d) - Date.UTC(first.y, first.mo - 1, first.d)) / 86_400_000);
  for (let i = 0; i <= dayCount; i += 1) {
    const day = new Date(Date.UTC(first.y, first.mo - 1, first.d + i));
    const dow = day.getUTCDay();
    if (!hours.days.includes(dow)) continue;
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth() + 1; const d = day.getUTCDate();
    const open = instantOf(y, mo, d, Math.floor(startMin / 60), startMin % 60, hours.timezone);
    const close = instantOf(y, mo, d, Math.floor(endMin / 60), endMin % 60, hours.timezone);
    const overlap = Math.min(close, to) - Math.max(open, from);
    if (overlap > 0) total += overlap;
  }
  return Math.floor(total / 60_000);
}

async function loadHours(): Promise<BusinessHours | null> {
  const row = await db.queryOne<{ value: unknown }>(`SELECT value FROM ipy_setting WHERE key = 'business_hours'`);
  return parseBusinessHours(row?.value);
}

// ---------------------------------------------------------------------------
// Which chats are waiting
// ---------------------------------------------------------------------------

export interface WaitingChat {
  conversationId: string;
  name: string;
  waitedMinutes: number;
  recordId: string | null;
  recordModule: string | null;
  holder: string | null;
  /** The exact text of `last_inbound_seen_at`, passed back untouched: a JS Date would drop microseconds and the claim would never match. */
  seenText: string;
  nudge1Claimed: boolean;
  nudge2Claimed: boolean;
}

/** A reply is anything we sent after the customer's last message, by our own clock, that did not fail. */
const NO_REPLY = `NOT EXISTS (
  SELECT 1 FROM ipy_message reply
   WHERE reply.conversation_id = c.id AND reply.direction = 'outbound'
     AND reply.status <> 'failed' AND reply.received_at > c.last_inbound_seen_at
)`;

/**
 * The chats whose customer is waiting longer than `firstMinutes` (and under the floor). The tick and the admin tile
 * both read this, so they cannot disagree about what "waiting" means.
 */
export async function findWaitingChats(opts: { firstMinutes: number; excludeClaimed?: boolean; limit?: number; now?: Date }): Promise<WaitingChat[]> {
  const claimed = opts.excludeClaimed
    ? `AND ((c.wait_nudge_1_at IS NULL OR c.wait_nudge_1_at < c.last_inbound_seen_at)
         OR (c.wait_nudge_2_at IS NULL OR c.wait_nudge_2_at < c.last_inbound_seen_at))`
    : '';
  const { rows } = await db.query<{
    id: string; contact_name: string | null; handle: string; record_id: string | null; record_module: string | null; holder: string | null;
    seen_text: string; seen_iso: string; n1: boolean; n2: boolean;
  }>(
    `SELECT c.id, c.contact_name, c.handle, c.record_id, c.record_module, ${HOLDER} AS holder,
            c.last_inbound_seen_at::text AS seen_text,
            to_char(c.last_inbound_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS seen_iso,
            (c.wait_nudge_1_at IS NOT NULL AND c.wait_nudge_1_at >= c.last_inbound_seen_at) AS n1,
            (c.wait_nudge_2_at IS NOT NULL AND c.wait_nudge_2_at >= c.last_inbound_seen_at) AS n2
       FROM ipy_conversation c
      WHERE c.channel = 'whatsapp' AND c.wa_account_id IS NULL
        AND c.last_inbound_seen_at IS NOT NULL
        AND c.last_inbound_at > now() - interval '7 days'
        -- Working minutes can never exceed wall-clock minutes, so a message younger than the limit cannot qualify yet.
        AND c.last_inbound_seen_at < now() - ($2 || ' minutes')::interval
        AND (c.status IN ('open', 'pending')
             OR (c.status = 'snoozed' AND c.snoozed_until IS NOT NULL AND c.snoozed_until < now()))
        AND NOT ${OPTED_OUT}
        AND ${NO_REPLY}
        ${claimed}
      ORDER BY c.last_inbound_at DESC
      LIMIT $1`,
    [CANDIDATE_LIMIT, String(opts.firstMinutes)],
  );
  const hours = await loadHours();
  const now = opts.now ?? new Date();
  const found: WaitingChat[] = [];
  for (const r of rows) {
    const waited = waitedMinutes(new Date(r.seen_iso), now, hours);
    if (waited <= opts.firstMinutes || waited > WAIT_FLOOR_MINUTES) continue;
    found.push({
      conversationId: r.id, name: r.contact_name || r.handle, waitedMinutes: waited, recordId: r.record_id, recordModule: r.record_module,
      holder: r.holder, seenText: r.seen_text, nudge1Claimed: r.n1, nudge2Claimed: r.n2,
    });
    if (opts.limit && found.length >= opts.limit) break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/** One guarded statement decides who alerts: it only succeeds for the exact message read and only while still unanswered. */
async function claim(chat: WaitingChat, level: 1 | 2): Promise<boolean> {
  const column = level === 1 ? 'wait_nudge_1_at' : 'wait_nudge_2_at';
  const row = await db.queryOne<{ id: string }>(
    `UPDATE ipy_conversation c SET ${column} = clock_timestamp()
      WHERE c.id = $1 AND c.last_inbound_seen_at = $2::timestamptz
        AND (c.${column} IS NULL OR c.${column} < c.last_inbound_seen_at)
        AND ${NO_REPLY}
      RETURNING c.id`,
    [chat.conversationId, chat.seenText],
  );
  return Boolean(row);
}

async function activeAdmins(): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM ipy_user WHERE is_admin = true AND is_active = true`);
  return rows.map((r) => r.id);
}

async function activeHolder(id: string | null): Promise<string | null> {
  if (!id) return null;
  const row = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE id = $1 AND is_active = true`, [id]);
  return row?.id ?? null;
}

async function alert(chat: WaitingChat, level: 1 | 2): Promise<void> {
  const link = chat.recordId ? `/${chat.recordModule || 'leads'}/${chat.recordId}` : '/chats';
  const base = {
    kind: 'whatsapp_wait',
    // Name and wait only: a lock screen shows this, and the message itself is not ours to put there.
    title: `${chat.name} is waiting for a reply`,
    body: `Waiting ${chat.waitedMinutes} working min`,
    link,
    recordId: chat.recordId,
  };
  const holder = level === 1 ? await activeHolder(chat.holder) : null;
  if (holder) { await notify({ ...base, userId: holder }); return; }
  const admins = await activeAdmins();
  if (!admins.length) { logger.warn({ conversationId: chat.conversationId }, 'waiting-for-reply alert skipped: no active admin'); return; }
  await notifyMany(admins, base);
}

let running = false;

/** One pass. Exported for the tests; the timer calls it every minute. Returns how many alerts it raised. */
export async function runWaitWatchOnce(now = new Date()): Promise<number> {
  const settings = await loadSettings();
  if (!settings.enabled) return 0;

  const waiting = await findWaitingChats({ firstMinutes: settings.firstMinutes, excludeClaimed: true, now });
  let raised = 0;
  let handled = 0;
  for (const chat of waiting) {
    if (handled >= MAX_PER_TICK) {
      logger.info({ left: waiting.length - handled }, 'waiting-for-reply alerts: more chats than one tick handles, the rest wait a minute');
      break;
    }
    // Levels are independent: a chat already past the second limit at switch-on gets the second alert only.
    const level: 1 | 2 | null = chat.waitedMinutes > settings.secondMinutes
      ? (chat.nudge2Claimed ? null : 2)
      : (chat.nudge1Claimed ? null : 1);
    if (!level) continue;
    handled += 1;
    try {
      if (!(await claim(chat, level))) continue;
      await alert(chat, level);
      raised += 1;
    } catch (err) {
      // The claim stands: losing one alert is the price of never alerting twice.
      logger.error({ err, conversationId: chat.conversationId }, 'waiting-for-reply alert failed');
    }
  }
  return raised;
}

let timer: NodeJS.Timeout | null = null;

export function startWaitWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runWaitWatchOnce().catch((err) => logger.error({ err }, 'waiting-for-reply tick failed')).finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
}

export function stopWaitWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
