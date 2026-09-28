/**
 * When somebody is due to be chased, as a chip.
 *
 * **Pulled out of `IpropyWorkspace` on 27 September 2026**, when the owner
 * asked for the record header's strip to carry the same chip the queue row
 * does: *"Next followup Button Show Today, tomorrow, pending Overdue Day,
 * month and Year"*. Two screens now need the same answer, and a second copy of
 * four colour strings is a second thing to keep in step — the first time they
 * disagree, the same date reads as urgent in one place and ordinary in the
 * other.
 *
 * **27 September 2026, earlier:** *"The followup Button Should be Rounded and
 * Lighter colour and also remove icon from followup button."* The icon said
 * the word the chip already says, and an alarm bell on every row of a queue
 * reads as a queue full of alarms.
 */
import { type JSX } from 'react';
import { formatDate } from '@ipropy/shared';
import { followUpChip, type FollowUpChip as FollowUpChipValue, type FollowUpTone } from '../lib/followUpDates';
import { cn } from '../lib/utils';

/*
  The owner's colours, one per state. Each text colour clears WCAG AA against
  its tint; Pending uses the darker of his two slates, because #64748b on
  #f1f5f9 falls just short.
*/
export const FOLLOW_UP_STYLE: Record<FollowUpTone, string> = {
  today: 'bg-[#fffbeb] text-[#b45309] dark:bg-amber-950/50 dark:text-amber-300',
  tomorrow: 'bg-[#eff6ff] text-[#1d4ed8] dark:bg-blue-950/50 dark:text-blue-300',
  overdue: 'bg-[#fef2f2] text-[#b91c1c] dark:bg-red-950/50 dark:text-red-300',
  pending: 'bg-[#f1f5f9] text-[#475569] dark:bg-slate-800 dark:text-slate-300',
};

/**
 * Two sizes, swapped rather than layered.
 *
 * `cn` is plain clsx with no Tailwind merging, so a caller appending `px-3` to
 * a chip that already says `px-2.5` leaves Tailwind's own stylesheet order to
 * pick between them — the same lottery that made every column header in the
 * CRM scroll away once. A state swaps the whole string out.
 *
 * `hero` is the record header's row beside the face — small, because three
 * chips stacked there set the height of the whole header (28 September 2026).
 */
const FOLLOW_UP_SIZE = {
  row: 'px-2.5 py-0.5 text-2xs',
  hero: 'h-6 px-2 text-[10px] normal-case tracking-normal',
} as const;

export function FollowUpBadge({ due, date, className, size = 'row' }: {
  due: FollowUpChipValue; date: unknown; className?: string; size?: keyof typeof FOLLOW_UP_SIZE;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-semibold uppercase tracking-wide',
        FOLLOW_UP_SIZE[size],
        FOLLOW_UP_STYLE[due.tone],
        className,
      )}
      title={date ? `Follow-up ${formatDate(String(date))}` : undefined}
    >
      {due.label}
    </span>
  );
}

/**
 * The same chip straight from a stored date, for callers that hold the value
 * rather than the decision. Nothing when the date is empty — a record nobody
 * has promised to chase has no chip, rather than one reading "none".
 */
export function FollowUpFromValue({ value, className, size }: {
  value: unknown; className?: string; size?: 'row' | 'hero';
}): JSX.Element | null {
  const due = followUpChip(value);
  if (!due) return null;
  return <FollowUpBadge due={due} date={value} className={className} size={size} />;
}
