/**
 * The six ribbon chips (New, Task, Call Log, Lost reason, List, Agent) each in
 * their own dark shade, with white text.
 *
 * **25 November 2026, the owner:** asked for this as a trial and, on
 * 26 November 2026, said to keep it.
 *
 * To go back to the plain white chips, set `DARK_RIBBON_CHIP_SHADES` to `false` — every chip then
 * wears the ordinary `toolbarButton` look again. Nothing else was changed.
 *
 * Plain Tailwind steps only, never an opacity modifier (see toolbarButton.ts).
 */
import { cn } from './utils';
import { toolbarButton, toolbarCount } from './toolbarButton';

export const DARK_RIBBON_CHIP_SHADES = true;

export type RibbonChipKind = 'new' | 'task' | 'calllog' | 'lost' | 'list' | 'agent';

// Resting = a dark shade; on = one step darker, with a ring so it still reads as chosen.
const REST: Record<RibbonChipKind, string> = {
  new: 'border-indigo-800 bg-indigo-700 text-white hover:bg-indigo-800',
  task: 'border-emerald-800 bg-emerald-700 text-white hover:bg-emerald-800',
  calllog: 'border-sky-800 bg-sky-700 text-white hover:bg-sky-800',
  lost: 'border-rose-800 bg-rose-700 text-white hover:bg-rose-800',
  list: 'border-violet-800 bg-violet-700 text-white hover:bg-violet-800',
  agent: 'border-amber-900 bg-amber-800 text-white hover:bg-amber-900',
};
const ON: Record<RibbonChipKind, string> = {
  new: 'border-indigo-950 bg-indigo-900 text-white ring-2 ring-indigo-300 hover:bg-indigo-900',
  task: 'border-emerald-950 bg-emerald-900 text-white ring-2 ring-emerald-300 hover:bg-emerald-900',
  calllog: 'border-sky-950 bg-sky-900 text-white ring-2 ring-sky-300 hover:bg-sky-900',
  lost: 'border-rose-950 bg-rose-900 text-white ring-2 ring-rose-300 hover:bg-rose-900',
  list: 'border-violet-950 bg-violet-900 text-white ring-2 ring-violet-300 hover:bg-violet-900',
  agent: 'border-amber-950 bg-amber-950 text-white ring-2 ring-amber-300 hover:bg-amber-950',
};

/** A ribbon chip's class list. With the trial off it is exactly the old button. */
export function ribbonChip(kind: RibbonChipKind, on: boolean, extra?: string): string {
  if (!DARK_RIBBON_CHIP_SHADES) return toolbarButton(on, extra);
  return cn(
    'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium shadow-xs transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1',
    on ? ON[kind] : REST[kind],
    extra,
  );
}

/** The number pill inside a chip: white on the dark fill. */
export function ribbonCount(on: boolean): string {
  if (!DARK_RIBBON_CHIP_SHADES) return toolbarCount(on);
  return 'rounded-full bg-white px-1.5 py-px text-[10px] font-semibold tabular-nums text-slate-900';
}
