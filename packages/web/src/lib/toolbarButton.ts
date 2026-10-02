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
    'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium shadow-xs transition-colors',
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

/**
 * The colour a filter's own icon takes once that filter is on.
 *
 * **2 October 2026, the owner:** *"in the Left record pane their are buttons of
 * List, status, Task, Tag, Please change the colour of all tab's icons after
 * the select a button i.e List Icon Colour will be Blue, Status icon Colour
 * will be Yellow, Follow-up /Task Icon colour will be Green and Tag Icon
 * colour will be Red."*
 *
 * **Only the icon.** The pill itself keeps the look he set on 29 September —
 * quiet when off, a solid brand fill when on — so this is a mark *inside* the
 * selected button rather than a fifth arrangement of the row.
 *
 * The 300 steps are chosen so each one clears 3:1 on that solid fill, which is
 * the bar for something you read as a shape rather than as words: measured on
 * `--brand-700` (#5b21b6) they are 4.3, 4.9, 4.7 and 3.7 to one. An icon
 * nobody can see on the button they just pressed is worse than no colour.
 *
 * Off, the icon inherits the pill's own text colour: he asked for the change
 * to happen **on select**, and four tinted icons at rest read as four
 * warnings — the same reason the record's action circles are grey at rest.
 */
export type FilterKind = 'list' | 'status' | 'task' | 'tag';

const ON_ICON: Record<FilterKind, string> = {
  list: 'text-sky-300',
  status: 'text-amber-300',
  task: 'text-emerald-300',
  tag: 'text-red-300',
};

export function filterIcon(kind: FilterKind, on: boolean, extra?: string): string {
  return cn('h-3.5 w-3.5 shrink-0', on && ON_ICON[kind], extra);
}
