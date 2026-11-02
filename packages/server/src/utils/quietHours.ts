/*
  Quiet hours: a daily window in which background timers do not touch the database.

  Neon powers the database down after five minutes with no queries. The CRM's own
  timers (scheduler tick, WhatsApp poll, health checks...) used to query every few
  minutes around the clock, so it never slept. Inside this window each of those
  timers simply skips its turn; the next turn after the window ends picks up
  whatever came due, because every one of them asks the database "what is due
  now" rather than "what happened since I last looked".

  Only timers use this. Incoming webhooks and anything a person does always work.
*/
import { config } from '../config.js';

export interface QuietWindow {
  enabled: boolean;
  /** "HH:MM", 24-hour, in `timeZone`. */
  start: string;
  end: string;
  timeZone: string;
}

const DEFAULT_START = 0 * 60 + 30;
const DEFAULT_END = 6 * 60 + 30;

/** "HH:MM" to minutes since midnight; null when it is not a valid time. */
function minutesOf(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minutesIn(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const min = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + min;
}

/**
 * Is `at` inside the window? A window may cross midnight (22:00-06:00).
 * A bad setting never throws: a bad time falls back to the default, a bad
 * time zone means "never quiet" (the safe direction: the CRM just stays awake).
 */
export function isQuietAt(at: Date, window: QuietWindow): boolean {
  if (!window.enabled) return false;
  const start = minutesOf(window.start) ?? DEFAULT_START;
  const end = minutesOf(window.end) ?? DEFAULT_END;
  if (start === end) return false;
  let now: number;
  try {
    now = minutesIn(window.timeZone, at);
  } catch {
    return false;
  }
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Is it quiet hours right now, by the configured window? */
export function isQuietHours(at: Date = new Date()): boolean {
  return isQuietAt(at, config.quietHours);
}
