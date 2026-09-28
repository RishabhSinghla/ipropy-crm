/**
 * The buttons that filter a list, drawn once.
 *
 * **27 September 2026, the owner:** *"In the Toolbar, there are three buttons
 * of All Leads, Lead Status, Follow-ups, we want to change these button colour
 * into Dark Purple"* — and, in the same message, a fourth beside them for the
 * call disposition.
 *
 * Four copies of one button is the mistake this repo keeps finding months
 * later: one of them learns a new "this filter is on" treatment and the others
 * do not, so the same toolbar reads as two toolbars. The shape and both states
 * live here; each caller supplies its own icon, label and count.
 *
 * **29 September 2026:** these are pale controls with a darker brand stroke.
 * The active filter gains one tint step rather than turning into a solid block,
 * so the toolbar remains calm while still making its state obvious.
 */
import { cn } from './utils';

/** The button itself. `on` means this filter is narrowing the list right now. */
export function toolbarButton(on: boolean, extra?: string): string {
  return cn(
    // Fully round, on the owner's prototype of 27 September 2026 — a row of
    // pills rather than a row of tabs.
    'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium shadow-xs transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1',
    on
      ? 'border-brand-500 bg-brand-100 text-brand-900 ring-1 ring-brand-300 hover:bg-brand-200 dark:border-brand-600 dark:bg-brand-900/70 dark:text-brand-100 dark:ring-brand-700'
      : 'border-brand-300 bg-brand-50 text-brand-800 hover:border-brand-400 hover:bg-brand-100 dark:border-brand-700 dark:bg-brand-950/35 dark:text-brand-200 dark:hover:bg-brand-900/55',
    extra,
  );
}

/** The number beside the label, on the same fill. */
export function toolbarCount(extra?: string): string {
  return cn('rounded-full bg-brand-100 px-1.5 py-px text-[10px] font-semibold tabular-nums text-brand-800 dark:bg-brand-900/80 dark:text-brand-100', extra);
}
