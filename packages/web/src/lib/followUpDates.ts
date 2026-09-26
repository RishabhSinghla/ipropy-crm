/**
 * The follow-up date, said the way a rep says it.
 *
 * **26 September 2026, the owner:** the queue card's task chip reads Today,
 * Tomorrow, Pending, or Overdue with how long for ("Overdue (1 day)",
 * "Overdue (2 months)"), and anywhere the date is changed it can be set in one
 * tap to Today, Tomorrow, Next Week or Next Month.
 *
 * Plain calendar days on this computer's clock, never UTC: in India a date
 * built with `toISOString()` before 5:30 in the morning is yesterday.
 */

export type FollowUpTone = 'today' | 'tomorrow' | 'overdue' | 'pending';

export interface FollowUpChip {
  label: string;
  tone: FollowUpTone;
}

/** "2026-09-26" for the calendar day `date` falls on here. */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A stored date or timestamp as a calendar day at midnight, or null. */
function asDay(value: unknown): Date | null {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return new Date(year!, month! - 1, day!);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

/** "1 day", "12 days", "1 month", "3 months", "1 year". */
export function howLongOverdue(days: number): string {
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return years === 1 ? '1 year' : `${years} years`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month' : `${months} months`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * The chip a follow-up date shows on a queue card, or null when none is set.
 *
 * Anything after tomorrow is "Pending": the task exists and is not due yet.
 * The exact date is one hover away (`title`), and on the record itself.
 */
export function followUpChip(value: unknown, now: Date = new Date()): FollowUpChip | null {
  const due = asDay(value);
  if (!due) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return { label: `Overdue (${howLongOverdue(-days)})`, tone: 'overdue' };
  if (days === 0) return { label: 'Today', tone: 'today' };
  if (days === 1) return { label: 'Tomorrow', tone: 'tomorrow' };
  return { label: 'Pending', tone: 'pending' };
}

/** The one-tap choices offered wherever a follow-up date is changed. */
export function quickFollowUpDates(now: Date = new Date()): { label: string; value: string }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const inDays = (days: number): Date => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  return [
    { label: 'Today', value: localDay(today) },
    { label: 'Tomorrow', value: localDay(inDays(1)) },
    { label: 'Next Week', value: localDay(inDays(7)) },
    { label: 'Next Month', value: localDay(sameDayNextMonth(today)) },
  ];
}

/** 31 January → 28 (or 29) February, never 3 March. */
function sameDayNextMonth(today: Date): Date {
  const lastDayOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 2, 0).getDate();
  return new Date(today.getFullYear(), today.getMonth() + 1, Math.min(today.getDate(), lastDayOfNextMonth));
}
