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
    // Fully round, on the owner's prototype of 27 September 2026 — a row of
    // pills rather than a row of tabs.
    'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium shadow-xs transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1',
    /*
      **29 September 2026, the owner:** *"we need Normal Toolbar Button in
      Light Color when button not selected or inactive but if we we Select or
      active a button or filter on a Button Then Theme Dark Color in toolbar
      and text colour also change to white or lighter."*

      So the row is quiet until something is narrowing the list, and the one
      that is reads as a solid brand pill with white on it. That is the third
      arrangement of this row in three days — a dark row throughout, then the
      active one darkest, now this — and it is the one where "on" and "off"
      are different *kinds* of thing rather than two shades of one.

      **Plain steps only, never an opacity modifier.** Every brand step here
      resolves to a bare `var(--brand-…)`, and Tailwind can only apply `/40`
      to a colour whose channels it can see — so `dark:bg-brand-900/70`
      compiles to nothing at all, the light rule is the only one left, and the
      row keeps its light fill on a dark page. That is visible only in a
      browser, in dark mode, and this repo has paid for it once already.
    */
    on
      ? 'border-brand-700 bg-brand-700 text-white shadow-sm hover:bg-brand-800 dark:border-brand-500 dark:bg-brand-600'
      : 'border-brand-200 bg-brand-50 text-brand-800 hover:border-brand-300 hover:bg-brand-100'
        + ' dark:border-brand-800 dark:bg-brand-950 dark:text-brand-200 dark:hover:bg-brand-900',
    extra,
  );
}

/**
 * The number beside the label. It sits on whichever fill the button wears, so
 * it moves with it — and a count that is a warning gets its own red.
 *
 * Plain steps, never an opacity modifier: every brand step resolves to a bare
 * `var(--brand-…)`, and Tailwind can only apply `/80` to a colour whose
 * channels it can see, so `dark:bg-brand-900/80` compiles to nothing at all.
 */
export function toolbarCount(on = false, warning = false): string {
  return cn(
    'rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums',
    /*
      **One whole string per state, never a tint layered on top.** `cn` is
      plain clsx with no tailwind-merge, so a caller passing `bg-red-600
      text-white` beside this function's own `text-brand-800` leaves both in
      the class list and Tailwind's stylesheet order picks the winner. That is
      how the overdue count came out dark red on red in dark mode — caught by
      the contrast scan, and by nothing else.
    */
    warning
      ? 'bg-red-600 text-white'
      : on
        ? 'bg-brand-900 text-white dark:bg-brand-800'
        : 'bg-brand-100 text-brand-800 dark:bg-brand-900 dark:text-brand-100',
  );
}
