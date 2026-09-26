/**
 * A donut for one of the Calls page's filters — direction, picked up, or when.
 *
 * **25 September 2026, the owner:** a chart for each of the three dropdowns,
 * "not too big not too small", interactive, following the agent picked. So
 * each slice is a filter: clicking it applies that filter to the list below,
 * clicking it again clears it, and the counts are the list's own (the server
 * answers both from one filter definition).
 *
 * Identity never rides on colour alone: every slice is named with its count
 * and share in the legend beside it, which is also what a keyboard reaches.
 * Colours are the fixed categorical order (blue, orange, aqua, yellow), never
 * reassigned by size, so "Outgoing" is the same blue whichever agent is shown.
 */
import { type JSX, useState } from 'react';
import { cn } from '../lib/utils';

export interface DonutSlice {
  key: string;
  label: string;
  count: number;
  /** False for a slice that is not itself a filter, like "Other". */
  selectable?: boolean;
}

/*
  Slots 1–4 of the validated categorical palette, light and dark steps. As
  Tailwind classes rather than inline hex so the dark step is chosen by the
  theme, not guessed from a media query in here.
*/
const SLOT = [
  { fill: 'fill-[#2a78d6] dark:fill-[#3987e5]', swatch: 'bg-[#2a78d6] dark:bg-[#3987e5]' },
  { fill: 'fill-[#eb6834] dark:fill-[#d95926]', swatch: 'bg-[#eb6834] dark:bg-[#d95926]' },
  { fill: 'fill-[#1baf7a] dark:fill-[#199e70]', swatch: 'bg-[#1baf7a] dark:bg-[#199e70]' },
  { fill: 'fill-[#eda100] dark:fill-[#c98500]', swatch: 'bg-[#eda100] dark:bg-[#c98500]' },
];

const SIZE = 120;
const RADIUS = 56;
const THICKNESS = 16;
/** The surface-coloured gap between slices, in degrees. */
const GAP_DEGREES = 2;

export function CallDonut({ title, slices, selected, onSelect }: {
  title: string;
  slices: DonutSlice[];
  /** The slice whose filter is on, if any. */
  selected: string;
  onSelect: (key: string) => void;
}): JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null);
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  const shown = slices.filter((slice) => slice.count > 0);
  const focus = hovered ?? (selected || null);
  const focused = slices.find((slice) => slice.key === focus);

  let angle = 0;
  const arcs = shown.map((slice) => {
    const sweep = (slice.count / total) * 360;
    const gap = shown.length > 1 ? GAP_DEGREES : 0;
    const arc = { slice, start: angle + gap / 2, end: angle + sweep - gap / 2 };
    angle += sweep;
    return arc;
  });

  const choose = (slice: DonutSlice): void => {
    if (slice.selectable === false) return;
    onSelect(selected === slice.key ? '' : slice.key);
  };

  return (
    <section className="card flex min-w-0 flex-col gap-3 p-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="flex items-center gap-4">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={`${title}: ${slices.map((s) => `${s.label} ${s.count}`).join(', ')}`}
          className="shrink-0"
        >
          {total === 0 ? (
            <circle
              cx={SIZE / 2} cy={SIZE / 2} r={RADIUS - THICKNESS / 2}
              className="fill-none stroke-slate-200 dark:stroke-slate-700" strokeWidth={THICKNESS}
            />
          ) : arcs.map(({ slice, start, end }) => {
            const slot = SLOT[slices.indexOf(slice) % SLOT.length];
            const dimmed = Boolean(focus) && focus !== slice.key;
            return (
              <path
                key={slice.key}
                d={ringPath(start, end)}
                className={cn(
                  slot.fill, 'transition-opacity',
                  dimmed && 'opacity-30',
                  slice.selectable !== false && 'cursor-pointer',
                )}
                onMouseEnter={() => setHovered(slice.key)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => choose(slice)}
              >
                <title>{`${slice.label}: ${slice.count} (${percent(slice.count, total)})`}</title>
              </path>
            );
          })}
          {/* The middle says the whole, or the slice being pointed at. */}
          <text x="50%" y="47%" textAnchor="middle" className="fill-slate-900 text-lg font-bold dark:fill-slate-100">
            {(focused ? focused.count : total).toLocaleString('en-IN')}
          </text>
          <text x="50%" y="61%" textAnchor="middle" className="fill-slate-500 text-[9px] dark:fill-slate-400">
            {focused ? percent(focused.count, total) : 'calls'}
          </text>
        </svg>

        <ul className="min-w-0 flex-1 space-y-1">
          {slices.map((slice, index) => {
            const slot = SLOT[index % SLOT.length];
            const on = selected === slice.key;
            const canPick = slice.selectable !== false && slice.count > 0;
            return (
              <li key={slice.key}>
                <button
                  type="button"
                  disabled={!canPick}
                  onClick={() => choose(slice)}
                  onMouseEnter={() => setHovered(slice.key)}
                  onMouseLeave={() => setHovered(null)}
                  aria-pressed={on}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-xs transition-colors',
                    canPick && 'hover:bg-slate-100 dark:hover:bg-slate-800',
                    on && 'bg-slate-100 font-semibold dark:bg-slate-800',
                    !canPick && 'cursor-default',
                  )}
                >
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', slot.swatch)} />
                  <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">{slice.label}</span>
                  <span className="tabular-nums text-slate-900 dark:text-slate-100">{slice.count.toLocaleString('en-IN')}</span>
                  <span className="w-9 text-right tabular-nums text-muted">{percent(slice.count, total)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function percent(count: number, total: number): string {
  if (!total) return '0%';
  return `${Math.round((count / total) * 100)}%`;
}

/** One ring segment from `start` to `end` degrees, clockwise from twelve o'clock. */
function ringPath(start: number, end: number): string {
  const centre = SIZE / 2;
  const outer = RADIUS;
  const inner = RADIUS - THICKNESS;
  // A full circle cannot be drawn as one arc; stop a hair short of it.
  const stop = end - start >= 360 ? start + 359.99 : end;
  const point = (radius: number, degrees: number): string => {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return `${(centre + radius * Math.cos(radians)).toFixed(2)} ${(centre + radius * Math.sin(radians)).toFixed(2)}`;
  };
  const large = stop - start > 180 ? 1 : 0;
  return [
    `M ${point(outer, start)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(outer, stop)}`,
    `L ${point(inner, stop)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)}`,
    'Z',
  ].join(' ');
}
