/**
 * The round action buttons in a record's header.
 *
 * One neutral circle for all of them, from the owner's screenshot on
 * 19 September 2026. Each button used to *sit* in the colour of the thing it
 * opened — amber, green, blue, red — and four tinted circles in a row read as
 * four warnings rather than as four ordinary controls.
 *
 * The colour moved to the hover instead, on his instruction: *"make the icon
 * color change with solid when hover"*. At rest they are one weight of grey;
 * under the cursor the one you are about to press fills with its own colour,
 * so it says what it is exactly when that matters and never before.
 *
 * It lives here rather than in `IpropyWorkspace.tsx` because the WhatsApp
 * screen wears the same header, and a second copy of these three strings is a
 * second thing to keep in step — the first time they disagree, the same
 * button looks different depending on which page you came from.
 */
export const ACTION_BASE = 'inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors hover:border-transparent hover:text-white';

/*
  The resting colours are separate from the shape on purpose. A button that is
  *on* — the star — needs its own background, and writing `bg-amber-500` after
  `bg-slate-50` in the same class list does not win: Tailwind decides which of
  two `bg-*` utilities applies by where they sit in its own stylesheet, not by
  the order they are typed. That is the same rule that made every column header
  in the CRM scroll away once. So a state swaps this string out rather than
  trying to beat it.
*/
export const ACTION_REST = 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';

export const ACTION_CIRCLE = `${ACTION_BASE} ${ACTION_REST}`;
