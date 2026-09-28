/**
 * The chip every fact in a record's header wears.
 *
 * Shared by the field strip and call-disposition control. All facts use a
 * solid charcoal pill; status alone uses the admin's configured color.
 */
export const HEADER_CHIP_SHAPE = 'h-8 items-center rounded-full border text-[13px] font-bold';

/** Every fact except status wears one solid, readable charcoal tone. */
export const HEADER_CHIP_TONE = 'border-slate-700 bg-slate-700 text-white dark:border-slate-600 dark:bg-slate-600 dark:text-white';

export const HEADER_CHIP = `${HEADER_CHIP_SHAPE} ${HEADER_CHIP_TONE}`;

/** The chip's own breathing room. Separate, so a control that needs its own
 *  height — the call pill is a button — can set that without restating the rest. */
export const HEADER_CHIP_PAD = 'px-3 py-1';
