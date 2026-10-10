import type { JSX } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { Dropdown } from './ui';

/**
 * A chip that opens a short list of choices when clicked — New (Today,
 * Yesterday, This week, This month) and Visits (Today, Tomorrow, Overdue,
 * Upcoming). One component so the two behave the same: click to open, pick
 * one to narrow the list, pick it again or "Show all" to undo.
 */
export function ChoiceChip<T extends string>({
  label, title, choices, active, count, busy, onPick, buttonClass, countClass, testId,
}: {
  label: string;
  title: string;
  choices: { key: T; label: string }[];
  active: T | null;
  /** The number beside the label: the chosen option's, or the first option's when none is chosen. */
  count: number;
  busy?: boolean;
  onPick: (key: T | null) => void;
  buttonClass: (on: boolean) => string;
  countClass: (on: boolean) => string;
  testId?: string;
}): JSX.Element {
  const on = active !== null;
  const chosenLabel = choices.find((choice) => choice.key === active)?.label;
  return (
    <Dropdown
      align="left"
      className="w-44"
      trigger={(
        <button type="button" className={buttonClass(on)} aria-pressed={on} aria-busy={busy} title={title} data-testid={testId}>
          <span>{chosenLabel ? `${label}: ${chosenLabel}` : label}</span>
          <span className={countClass(on)}>{count.toLocaleString('en-IN')}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="py-1" role="menu" aria-label={title}>
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              role="menuitemradio"
              aria-checked={choice.key === active}
              onClick={() => { onPick(choice.key === active ? null : choice.key); close(); }}
              className={cn(
                'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800',
                /* Its own text colour, always: in the main toolbar this list
                   would otherwise inherit the bar's white and vanish on the
                   white panel — *"text not showing in Drop-down"*. */
                choice.key === active ? 'font-semibold text-brand-700 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200',
              )}
            >
              {choice.label}
              {choice.key === active && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
          {on && (
            <button
              type="button"
              onClick={() => { onPick(null); close(); }}
              className="mt-1 w-full border-t border-[var(--border)] px-3 py-1.5 text-left text-xs text-muted hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Show all
            </button>
          )}
        </div>
      )}
    </Dropdown>
  );
}
