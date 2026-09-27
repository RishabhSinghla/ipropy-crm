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
 * Dark purple is the brand's own step 800, which is a fill rather than a tint —
 * so the count chip on top is white at a low opacity, never a slate step that
 * would read grey on purple.
 */
import { cn } from './utils';

/** The button itself. `on` means this filter is narrowing the list right now. */
export function toolbarButton(on: boolean, extra?: string): string {
  return cn(
    // Fully round, on the owner's prototype of 27 September 2026 — a row of
    // pills rather than a row of tabs.
    'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white shadow-xs transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1',
    // A filter that is on is lighter and ringed, not a different colour: the
    // row has to stay one row of purple pills for the "on" one to stand out
    // at all.
    on ? 'bg-brand-700 ring-2 ring-brand-300 dark:ring-brand-700' : 'bg-brand-900 hover:bg-brand-800',
    extra,
  );
}

/** The number beside the label, on the same fill. */
export function toolbarCount(extra?: string): string {
  return cn('rounded-full bg-brand-700 px-1.5 py-px text-[10px] font-semibold tabular-nums text-white', extra);
}
