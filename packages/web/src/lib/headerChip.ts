import { followUpChip } from './followUpDates';

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
export const HEADER_CHIP_SHAPE = 'items-center rounded-full border text-[13px] font-bold';

/** The ordinary tone: light, a hairline, dark type. */
export const HEADER_CHIP_TONE = 'border-[var(--border)] bg-[var(--surface-muted)] text-slate-800 dark:bg-slate-800 dark:text-slate-100';

/**
 * The one tone that is not the ordinary one, for a chase date that has passed.
 *
 * **28 September 2026, the owner, after seeing the strip:** *"bring the
 * overdue red back on followup chip."* It is the right exception to make —
 * the other four facts on that line are states, and this one is a debt. Today
 * and Tomorrow keep the ordinary chip, because a queue where three chips
 * shout is a queue where none of them does.
 *
 * The pair is the one `FOLLOW_UP_STYLE` already used and already clears AA in
 * both themes, so the colours themselves are not a new decision.
 *
 * **It is a separate string rather than something appended to the tone
 * above**, which is the rule this repo has been bitten by twice: two `bg-*`
 * utilities in one class list are decided by where they sit in Tailwind's own
 * stylesheet, not by the order they are typed. A state swaps the string out.
 */
export const HEADER_CHIP_OVERDUE = 'border-[#fecaca] bg-[#fef2f2] text-[#b91c1c] dark:border-red-900 dark:bg-red-950 dark:text-red-300';

export const HEADER_CHIP = `${HEADER_CHIP_SHAPE} ${HEADER_CHIP_TONE}`;

/** The chip's own breathing room. Separate, so a control that needs its own
 *  height — the call pill is a button — can set that without restating the rest. */
export const HEADER_CHIP_PAD = 'px-3 py-1';

/**
 * Which tone a chase date's chip wears.
 *
 * A function rather than a ternary in the strip's own JSX, because this is
 * the decision the owner asked for and it is the one thing here worth being
 * able to test without a browser: `tests/headerChipTone.test.ts` walks a real
 * yesterday, today, tomorrow and next month through it.
 *
 * **It cannot be proved end to end**, and that is the product working rather
 * than a gap: `POST /api/records/:module` refuses a chase date in the past —
 * *"Next Follow-up is a task: choose today or a future date"* — so a record
 * only becomes overdue by the clock passing, and a spec cannot manufacture
 * one through the API it is meant to be driving.
 */
export function headerChipTone(value: unknown): string {
  return followUpChip(value)?.tone === 'overdue' ? HEADER_CHIP_OVERDUE : HEADER_CHIP_TONE;
}
