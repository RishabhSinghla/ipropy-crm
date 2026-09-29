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
    /*
      **28 September 2026, the owner:** *"Active Button Should Darker as Theme
      Colour in Tool bar in All modules."* It was the other way round — the
      button that was on went *lighter* and took a ring — and he is right that
      the darker one reads as the pressed one.

      Still one row of purple pills, so the difference is depth rather than
      hue: the resting pills are the mid step, the one that is on is the
      darkest there is and keeps its ring.
    */
    on
      ? 'bg-brand-950 ring-2 ring-brand-400 dark:ring-brand-600'
      : 'bg-brand-700 hover:bg-brand-800',
    extra,
  );
}

/** The number beside the label, on the same fill. */
export function toolbarCount(extra?: string): string {
  return cn('rounded-full bg-brand-700 px-1.5 py-px text-[10px] font-semibold tabular-nums text-white', extra);
}
