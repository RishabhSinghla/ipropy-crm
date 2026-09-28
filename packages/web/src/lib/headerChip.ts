/**
 * The chip every fact in a record's header wears.
 *
 * Shared by the field strip and the call-disposition control, so the same fact
 * cannot look different depending on which screen you arrived from.
 *
 * Three tones and no more: the ordinary one, the stage's own admin-chosen
 * colour (applied by the caller through `badgeVars`), and overdue.
 */
import { followUpChip } from './followUpDates';

export const HEADER_CHIP_SHAPE = 'h-8 items-center rounded-full border text-[13px] font-bold';

/**
 * The same chip, small — the record hero's row beside the face.
 *
 * A whole second string rather than `HEADER_CHIP_SHAPE` with `h-6` written
 * after it: `cn` is plain clsx, so two height utilities in one class list are
 * decided by Tailwind's own stylesheet order and `h-8` won. On screen that was
 * a chip that ignored every attempt to shrink it.
 */
export const HEADER_CHIP_SHAPE_SM = 'h-6 items-center rounded-full border text-[10px] font-bold';

/**
 * Every ordinary fact: a light chip with a border, in the brand's own colour.
 *
 * Brand steps rather than slate, so the chips move when an admin changes the
 * Brand colour — `applyBrandColour` rewrites those CSS variables at runtime,
 * and a raw hue would look identical today and stop moving the moment somebody
 * picks a different theme.
 *
 * **Plain steps, never an opacity modifier.** Each of these resolves to a bare
 * `var(--brand-…)`, and Tailwind can only apply `/40` to a colour whose
 * channels it can see — so `bg-brand-950/40` compiles to nothing at all and the
 * light rule is the only one left, which is a chip that stays light on a dark
 * page. That has already been found once, in a browser, and by nothing else.
 */
export const HEADER_CHIP_TONE =
  'border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-100';

/**
 * A chase date that has already passed.
 *
 * Deliberately **not** a brand token: this is a warning, and a warning that
 * changed colour with the theme would stop reading as one the day somebody
 * picks a red brand. Red is the fact, not the decoration.
 */
export const HEADER_CHIP_OVERDUE =
  'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300';

export const HEADER_CHIP = `${HEADER_CHIP_SHAPE} ${HEADER_CHIP_TONE}`;

/** The chip's own breathing room. Separate, so a control that needs its own
 *  height — the call pill is a button — can set that without restating the rest. */
export const HEADER_CHIP_PAD = 'px-3 py-1';

/**
 * Which tone a chase date wears.
 *
 * It asks `followUpChip` — the same function the queue's own chip reads — so
 * the header and the queue can never disagree about whether somebody is
 * overdue. A second copy of "is this date in the past" is how they would.
 */
export function headerChipTone(value: unknown): string {
  return followUpChip(value)?.tone === 'overdue' ? HEADER_CHIP_OVERDUE : HEADER_CHIP_TONE;
}
