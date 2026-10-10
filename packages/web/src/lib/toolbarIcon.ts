/**
 * One look for every icon on the main toolbar: no box, one size, and a colour
 * of its own.
 *
 * **10 October 2026, the owner:** *"In the Main Toolbar also check Dashboard,
 * Filter, Export/import Icon size and Button (We want to see all icons only in
 * Separated colour 'Without Button/Box' And Size should Same … so that we can
 * identify all icons easily."*
 *
 * They were three different boxes — a ghost circle, a bordered square and a
 * bordered rounded square — at 14px and 20px. One function means a new icon
 * on that bar starts out looking like its neighbours. Icons are not text, so
 * the colours only need 3:1 against the bar.
 */
import { cn } from './utils';

export type ToolbarIconTone = 'dashboard' | 'filter' | 'exchange' | 'bell' | 'theme';

/*
  The bar is the dark brand in both themes, so every hue is a light step —
  and five different families, so no two icons can be mistaken for each other
  (*"Please change the all icon colour separately /different in Main Menu
  bar"*, 10 October 2026). Each clears 3:1 on `brand-800`, the rule for icons.
*/
const TONE: Record<ToolbarIconTone, string> = {
  dashboard: 'text-pink-300',
  filter: 'text-sky-300',
  exchange: 'text-emerald-300',
  bell: 'text-amber-300',
  theme: 'text-orange-200',
};

/** Every toolbar icon is drawn at this size. */
export const TOOLBAR_ICON_SIZE = 'h-4 w-4';

/**
 * The button around a toolbar icon. No border and no fill at rest; a faint
 * circle on hover, and a ring in the icon's own colour while it is on (a
 * panel open, a filter applied), so "on" is visible without a box.
 */
export function toolbarIcon(tone: ToolbarIconTone, on = false): string {
  return cn(
    'toolbar-action relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
    'hover:bg-white/15',
    TONE[tone],
    on && 'ring-2 ring-current',
  );
}
