/**
 * The rules of the slow promotional drip — pure, so a test can pin every one of them without a database.
 *
 * Background (see docs/OPENWA.md, "The slow drip"): the CRM deliberately has no "send to many" button on the linked
 * phones, because a pattern of many messages to many strangers is what gets a WhatsApp number restricted. The owner has
 * decided to accept that risk for one promotional message over many weeks. This file is where "slow and safe" is
 * written down as numbers:
 *
 *  - a daily cap per number that starts low and rises slowly, with a hard ceiling in code (far below the 60 a day a
 *    single user may send by hand), which no setting can raise;
 *  - a random gap of at least a minute between sends, and only inside daytime hours of the organisation's timezone;
 *  - the messages are never word-for-word identical, and always end with a plain way to say STOP;
 *  - the queue pauses itself, and never starts itself again.
 */

/** Never higher, whatever is typed on the screen. The per-user cap for hand-typed messages is 60. */
export const HARD_MAX_PER_NUMBER_PER_DAY = 40;
export const DEFAULT_CAP_START = 20;
export const DEFAULT_CAP_STEP = 5;
export const DEFAULT_CAP_EVERY_DAYS = 3;
export const DEFAULT_CAP_MAX = 40;

/** Never closer than this, whatever is typed on the screen. */
export const MIN_GAP_SECONDS = 60;
export const MAX_GAP_SECONDS = 900;
export const DEFAULT_GAP_MIN = 60;
export const DEFAULT_GAP_MAX = 120;

export const DEFAULT_WINDOW_FROM = 10;
export const DEFAULT_WINDOW_TO = 18;

/** Three failed sends inside a day stops the queue. */
export const PAUSE_AFTER_FAILURES = 3;

export const MAX_VARIANTS = 6;
export const MAX_VARIANT_LENGTH = 900;
/** One drip is capped, so a typo cannot freeze a whole database into it. */
export const MOST_PER_DRIP = 60_000;

/** The line that ends every message. A STOP reply to it is read by the inbound path and honoured everywhere. */
export const OPT_OUT_LINE = 'Reply STOP to stop';

export const DEFAULT_VARIANTS: string[] = [
  'Hello {name}, IPROPY | Your Own Property Advisor — 20+ years of experience. '
  + 'Premium builder floors in Greenfields Colony, Faridabad. Buy / Sell / Rent / Exchange. '
  + 'Call 9811533633.\nIPROPY | Yogesh Bindal, A-1875 Mall Road, Greenfields Colony.',
  'Hi {name}, this is IPROPY | Your Own Property Advisor, with 20+ years of experience in Faridabad. '
  + 'We have premium builder floors in Greenfields Colony, and help you buy, sell, rent or exchange property. '
  + 'Call 9811533633.\nIPROPY | Yogesh Bindal, A-1875 Mall Road, Greenfields Colony.',
  'Namaste {name}, IPROPY | Your Own Property Advisor (20+ years of experience). '
  + 'Looking at premium builder floors in Greenfields Colony, Faridabad, or want to buy, sell, rent or exchange? '
  + 'Call 9811533633.\nIPROPY | Yogesh Bindal, A-1875 Mall Road, Greenfields Colony.',
  'Hello {name}, IPROPY | Your Own Property Advisor here — 20+ years helping families in Faridabad '
  + 'buy, sell, rent and exchange property, with premium builder floors in Greenfields Colony. '
  + 'Call 9811533633.\nIPROPY | Yogesh Bindal, A-1875 Mall Road, Greenfields Colony.',
];

// ---------------------------------------------------------------------------
// Settings, clamped so a typo cannot switch the brakes off
// ---------------------------------------------------------------------------

export interface DripSpeed {
  capStart: number;
  capStep: number;
  capEveryDays: number;
  capMax: number;
  gapMinSeconds: number;
  gapMaxSeconds: number;
  windowFrom: number;
  windowTo: number;
}

const whole = (raw: unknown, fallback: number, min: number, max: number): number => {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/** What was asked for, forced into the safe range. Anything missing takes the slow default. */
export function clampSpeed(asked: Partial<Record<keyof DripSpeed, unknown>> = {}): DripSpeed {
  const capMax = whole(asked.capMax, DEFAULT_CAP_MAX, 1, HARD_MAX_PER_NUMBER_PER_DAY);
  const capStart = whole(asked.capStart, DEFAULT_CAP_START, 1, capMax);
  const gapMinSeconds = whole(asked.gapMinSeconds, DEFAULT_GAP_MIN, MIN_GAP_SECONDS, MAX_GAP_SECONDS);
  const windowFrom = whole(asked.windowFrom, DEFAULT_WINDOW_FROM, 6, 20);
  // At least two hours of window, ending by 9 pm: promotional messages at night are what people report.
  const windowTo = whole(asked.windowTo, DEFAULT_WINDOW_TO, windowFrom + 2, 21);
  return {
    capStart,
    capStep: whole(asked.capStep, DEFAULT_CAP_STEP, 0, 10),
    capEveryDays: whole(asked.capEveryDays, DEFAULT_CAP_EVERY_DAYS, 1, 30),
    capMax,
    gapMinSeconds,
    gapMaxSeconds: whole(asked.gapMaxSeconds, Math.max(DEFAULT_GAP_MAX, gapMinSeconds + 30), gapMinSeconds, MAX_GAP_SECONDS),
    windowFrom,
    windowTo,
  };
}

/**
 * How many messages ONE number may send today. `activeDays` is the number of days (before today) the drip actually
 * sent something, so a week with the phones off does not ramp up on its own.
 *  day 1-3: 20, day 4-6: 25, day 7-9: 30 … until the ceiling.
 */
export function capForDay(activeDays: number, speed: DripSpeed): number {
  const steps = Math.floor(Math.max(0, activeDays) / speed.capEveryDays);
  return Math.min(speed.capMax, HARD_MAX_PER_NUMBER_PER_DAY, speed.capStart + steps * speed.capStep);
}

// ---------------------------------------------------------------------------
// Time: the daytime window and the random gap
// ---------------------------------------------------------------------------

/** Is this hour (0-23, organisation timezone) inside the sending window? */
export function inWindow(hour: number, speed: Pick<DripSpeed, 'windowFrom' | 'windowTo'>): boolean {
  return hour >= speed.windowFrom && hour < speed.windowTo;
}

/** The hour of day in a timezone. */
export function hourIn(timezone: string, now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(now));
}

/** A random wait between sends, in seconds: always at least the minimum, never an even beat. */
export function gapSeconds(speed: Pick<DripSpeed, 'gapMinSeconds' | 'gapMaxSeconds'>, random: () => number = Math.random): number {
  const lo = Math.max(MIN_GAP_SECONDS, speed.gapMinSeconds);
  const hi = Math.max(lo, speed.gapMaxSeconds);
  return Math.round(lo + random() * (hi - lo));
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/**
 * A first name worth greeting by, or null. Only letters (Hindi and English), one word, short: "Mr. Sharma 3BHK" or
 * "9811…" is not a name, and a wrong greeting is worse than none.
 */
export function usableFirstName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const first = raw.trim().split(/\s+/)[0] ?? '';
  if (!/^[\p{L}]{2,20}$/u.test(first)) return null;
  if (/^(mr|mrs|ms|dr|shri|smt|sh|mrs\.|mr\.)$/i.test(first)) return null;
  return first.charAt(0).toLocaleUpperCase() + first.slice(1).toLocaleLowerCase();
}

/** `{name}` becomes the first name; with none, the token and the space before it vanish ("Hello {name}," → "Hello,"). */
export function fillVariant(text: string, firstName: string | null): string {
  const filled = firstName
    ? text.replace(/\{name\}/gi, firstName)
    : text.replace(/\s*\{name\}/gi, '');
  return filled.replace(/[ \t]+\n/g, '\n').trim();
}

/** Every message ends with a plain way out. Not added twice if the wording already has it. */
export function withOptOut(text: string): string {
  return /reply\s+stop\s+to\s+stop\s*\.?\s*$/i.test(text.trim()) ? text.trim() : `${text.trim()}\n\n${OPT_OUT_LINE}`;
}

/** A stable pick, so a retry of the same person reads the same words, and the wordings share the list evenly. */
export function variantIndex(recordId: string, count: number): number {
  if (count <= 1) return 0;
  let h = 0;
  for (let i = 0; i < recordId.length; i += 1) h = (h * 31 + recordId.charCodeAt(i)) >>> 0;
  return h % count;
}

/** What one person is sent. */
export function composeMessage(variants: string[], recordId: string, firstName: string | null): { text: string; variant: number } {
  const variant = variantIndex(recordId, variants.length);
  return { text: withOptOut(fillVariant(variants[variant] ?? '', firstName)), variant };
}

/** The reasons a set of wordings could not be used, or null. */
export function variantsProblem(variants: unknown): string | null {
  if (!Array.isArray(variants) || variants.length === 0) return 'Write at least one wording of the message.';
  if (variants.length > MAX_VARIANTS) return `Use at most ${MAX_VARIANTS} wordings.`;
  const seen = new Set<string>();
  for (const v of variants) {
    if (typeof v !== 'string' || v.trim().length < 20) return 'Each wording needs to be a real message (at least 20 characters).';
    if (v.length > MAX_VARIANT_LENGTH) return `A wording is longer than ${MAX_VARIANT_LENGTH} characters.`;
    if (/https?:\/\//i.test(v)) return 'Leave links out: a link in a cold message is the quickest way to be reported. Give a phone number instead.';
    const key = v.trim().toLowerCase();
    if (seen.has(key)) return 'Two wordings are the same. Each one should be different.';
    seen.add(key);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Who is skipped
// ---------------------------------------------------------------------------

export type SkipReason =
  | 'no_mobile' | 'not_indian_mobile' | 'duplicate' | 'opted_out' | 'already_messaged'
  | 'not_on_whatsapp' | 'record_gone';

export const SKIP_WORDS: Record<SkipReason, string> = {
  no_mobile: 'no mobile number on the record',
  not_indian_mobile: 'not a valid Indian mobile number',
  duplicate: 'another record in this list has the same number',
  opted_out: 'asked not to be messaged',
  already_messaged: 'the queue has already messaged this number',
  not_on_whatsapp: 'not on WhatsApp',
  record_gone: 'the record was deleted or archived',
};

/** Ten digits starting 6-9 (an Indian mobile), from whatever was stored. Null when it is not one. */
export function indianMobileKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  const last = digits.length === 10 ? digits : digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : '';
  return /^[6-9]\d{9}$/.test(last) ? last : null;
}

// ---------------------------------------------------------------------------
// Choosing the number, and when to pause
// ---------------------------------------------------------------------------

export interface NumberState {
  id: string;
  label: string;
  status: string;
  paused: boolean;
  /** Drip messages this number has sent today. */
  sentToday: number;
  /** When it last sent one for the drip (ms), for taking turns. */
  lastSentAtMs: number | null;
  /** WhatsApp has limited this number (the session's `restriction`). */
  restricted: boolean;
}

/**
 * Round-robin: of the numbers that are ready, not paused by an admin and under today's cap, the one that sent least
 * recently goes next, so the work is shared evenly and no number sends twice in a row while another waits.
 */
export function chooseDripNumber(numbers: NumberState[], capToday: number): NumberState | null {
  const open = numbers.filter((n) => n.status === 'ready' && !n.paused && !n.restricted && n.sentToday < capToday);
  if (open.length === 0) return null;
  return [...open].sort((a, b) => (a.lastSentAtMs ?? 0) - (b.lastSentAtMs ?? 0) || a.sentToday - b.sentToday || a.id.localeCompare(b.id))[0] ?? null;
}

export type PauseCause = { why: 'number_down' | 'restricted' | 'failures'; message: string };

/**
 * Should the queue stop itself? A number an admin paused on purpose is just left out; a number that was linked and
 * has dropped, or one WhatsApp has restricted, or a third failed send in a day, stops everything — never to start
 * again without an admin pressing Resume.
 */
export function pauseCause(input: { numbers: NumberState[]; failuresLastDay: number }): PauseCause | null {
  const dropped = input.numbers.filter((n) => !n.paused && n.status !== 'ready');
  if (dropped.length > 0) {
    return { why: 'number_down', message: `${dropped.map((n) => n.label).join(', ')} is not connected (${dropped.map((n) => n.status).join(', ')}). Reconnect it, or take it off the queue, then press Resume.` };
  }
  const restricted = input.numbers.filter((n) => !n.paused && n.restricted);
  if (restricted.length > 0) {
    return { why: 'restricted', message: `WhatsApp has limited ${restricted.map((n) => n.label).join(', ')}. Do not push on: leave it alone for a few days, and use the official route for bulk messages.` };
  }
  if (input.failuresLastDay >= PAUSE_AFTER_FAILURES) {
    return { why: 'failures', message: `${input.failuresLastDay} messages failed to send in the last day. Look at the failures below before pressing Resume.` };
  }
  if (input.numbers.every((n) => n.paused)) {
    return { why: 'number_down', message: 'Every number on this queue is paused. Un-pause one on the WhatsApp numbers screen, then press Resume.' };
  }
  return null;
}
