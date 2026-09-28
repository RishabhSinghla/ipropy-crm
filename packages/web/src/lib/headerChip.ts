/**
 * The chip every fact in a record's header wears.
 *
 * **28 September 2026, the owner**, of the middle pane in both modules:
 * *"All of them into Round Chip/Box/Card In Light Colour with a Border, All
 * chips colour will same except Leads/Inventory Status … And All chips also
 * be Bolder in Font size."*
 *
 * So there is one look and one exception. The stage keeps the colour an admin
 * picked for it in the dropdown editor, because on that chip the colour *is*
 * the fact; everything beside it — the source, the contact type, the chase
 * date, how the last call went — is a word, and five hues in a row leave none
 * of them saying anything.
 *
 * It lives here rather than in either component for the reason this repo
 * keeps re-learning: the key strip and the call pill both draw it, and a
 * second copy of one class string is a second thing to keep in step — the
 * first time they disagree, two chips an inch apart stop looking like a set.
 *
 * **This reverses his own instruction of 26 September** — *"Colour Always Fix
 * With Dark Purple as theme button"* for the call pill. He has worked the
 * screen since; the later decision is the one that stands, and both are
 * written down rather than one quietly overwriting the other.
 */
export const HEADER_CHIP = 'items-center rounded-full border border-[var(--border)] bg-[var(--surface-muted)] text-[13px] font-bold text-slate-800 dark:bg-slate-800 dark:text-slate-100';

/** The chip's own breathing room. Separate, so a control that needs its own
 *  height — the call pill is a button — can set that without restating the rest. */
export const HEADER_CHIP_PAD = 'px-3 py-1';
