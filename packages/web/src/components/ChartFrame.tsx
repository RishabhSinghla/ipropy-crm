/**
 * One chart wrapper, one number format, for every screen that draws a series.
 *
 * They lived inside `Dashboard.tsx` and the Reports screen needs the same
 * three. Copying them would have been quicker and is exactly the mistake this
 * codebase keeps finding months later: the accessibility handling below is
 * subtle enough that a second copy would drift from it silently, and the
 * screen that drifted would be the one nobody scans.
 */
import { type JSX, type ReactNode, useEffect, useRef } from 'react';
import { formatIndianPrice } from '@ipropy/shared';
import { cn } from '../lib/utils';

export interface Series { key: string; label: string; value: number; color?: string | null; secondary?: number }

/**
 * Wraps a chart so assistive tech gets the numbers instead of the drawing.
 *
 * recharts renders every segment as `<path role="img">` with no accessible
 * name, so a screen reader announces a row of unlabelled images and none of
 * the data — a serious axe failure, and useless to the person hearing it.
 * Labelling each path would fix the rule while still conveying nothing, so the
 * SVG is hidden and the same series is exposed as text, which is what someone
 * actually needs from a chart.
 *
 * This went unnoticed until the a11y scans started waiting for animations to
 * finish: recharts animates on mount, so axe had been measuring an empty
 * canvas.
 */
export function ChartFrame({
  title, series, format, scroll, children,
}: { title: string; series: Series[]; format?: string; scroll?: boolean; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // recharts puts tabindex="0" on its own layer groups and ignores a tabIndex
  // prop, which would leave focusable elements inside an aria-hidden subtree —
  // axe's aria-hidden-focus, and a real defect: focus would land somewhere a
  // screen reader says nothing about.
  //
  // Done here rather than with `inert`, which is the obvious answer and the
  // wrong one: inert also suppresses pointer events, so it silently killed
  // click-to-drill on every chart while making the accessibility tests pass.
  // The observer is needed because recharts rebuilds this subtree on resize
  // and on every data change.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const neutralise = (): void => {
      root.querySelectorAll<HTMLElement>('[tabindex]:not([tabindex="-1"])')
        .forEach((el) => el.setAttribute('tabindex', '-1'));
    };
    neutralise();
    const observer = new MutationObserver(neutralise);
    observer.observe(root, { subtree: true, childList: true, attributeFilter: ['tabindex'] });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {/* Hidden from assistive tech, with the series given as text below —
          labelling each segment would satisfy the rule while still conveying
          nothing useful. Clicking a segment to drill through is unaffected;
          it is a shortcut to a filtered list that is reachable from the nav
          anyway. */}
      {/* The widget is resizable, so the chart takes the height left over
          rather than a fixed one — a fixed box drew its axis and its last
          weeks outside the card on any layout shorter than itself. */}
      <div ref={ref} aria-hidden="true" className={cn('min-h-0 flex-1', scroll && 'overflow-y-auto')}>{children}</div>
      <p className="sr-only">
        {`${title}. ${series.map((s) => `${s.label}: ${formatValue(s.value, format)}`).join('. ')}`}
      </p>
    </>
  );
}

/** Visible values keep a chart useful when colour, a small tile, or a printout
 * makes the plotted marks hard to read.  Counts get a share of the displayed
 * total; money and averages keep their configured format. */
export function SeriesSummary({ series, format }: { series: Series[]; format?: string }): JSX.Element {
  const total = series.reduce((sum, item) => sum + Number(item.value || 0), 0);
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-2xs text-muted dark:border-slate-800">
      {series.map((item) => (
        <span key={item.key} className="inline-flex max-w-full items-center gap-1">
          {item.color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />}
          <span className="max-w-[9rem] truncate" title={item.label}>{item.label}</span>
          <span className="shrink-0 font-medium text-slate-700 tnum dark:text-slate-200">
            {formatValue(item.value, format)}
            {format !== 'currency' && total > 0 ? ` (${((item.value / total) * 100).toFixed(1)}%)` : ''}
          </span>
        </span>
      ))}
    </div>
  );
}

export function formatValue(value: number, format?: string): string {
  if (format === 'currency') return formatIndianPrice(value);
  if (format === 'percent') return `${value.toFixed(1)}%`;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value);
}
