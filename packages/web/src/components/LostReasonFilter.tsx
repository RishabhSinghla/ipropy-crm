import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import type { FilterGroup } from '@ipropy/shared';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { ribbonChip } from '../lib/ribbonChipShades';
import { Dropdown } from './ui';

/**
 * Lost reason, one at a time. The chip carries only its name; the record counts live in the
 * dropdown, beside each reason, so the ribbon keeps its room.
 */
export function LostReasonFilter({
  module, fieldName, options, view, search, filter, picked, onPick,
}: {
  module: string;
  fieldName: string;
  options: { value: string; label?: string }[];
  view?: string;
  search?: string;
  filter?: FilterGroup;
  picked: string | null;
  onPick: (value: string | null) => void;
}): JSX.Element {
  const facet = useQuery({
    queryKey: ['facet', module, fieldName, view, search, filter],
    queryFn: () => api.facet(module, fieldName, undefined, 50, { view, search, filter }),
    staleTime: 60_000,
  });
  const counts = new Map((facet.data?.values ?? []).map((row) => [row.value, row.count]));
  const label = (value: string): string => options.find((option) => option.value === value)?.label || value;
  // A reason somebody picked once and an admin later removed still shows, so it can be cleared.
  const shown = options.map((option) => option.value);
  const extras = [...counts.keys()].filter((value) => !shown.includes(value));
  const rows = [...shown, ...extras];

  return (
    <Dropdown align="right" className="w-72" trigger={(
      <button type="button" className={ribbonChip('lost', Boolean(picked), 'h-6 px-2 text-[10px]')} aria-label="Lost reason filter" aria-pressed={Boolean(picked)} data-testid="lost-reason-filter">
        <span className="max-w-32 truncate">{picked ? label(picked) : 'Lost reason'}</span>
      </button>
    )}>
      {(close) => (
        <div className="max-h-[min(70vh,28rem)] overflow-y-auto p-2 text-xs" aria-label="Lost reasons">
          <button type="button" aria-pressed={!picked} onClick={() => { onPick(null); close(); }} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800', !picked && 'font-semibold text-brand-700 dark:text-brand-300')}>
            <span>All records</span>{!picked && <Check className="h-3 w-3" />}
          </button>
          {rows.map((value) => (
            <button key={value} type="button" aria-pressed={picked === value} onClick={() => { onPick(picked === value ? null : value); close(); }} className={cn('flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800', picked === value && 'font-semibold text-brand-700 dark:text-brand-300')}>
              <span className="truncate">{label(value)}</span>
              <span className="flex items-center gap-2 text-muted">{(counts.get(value) ?? 0).toLocaleString('en-IN')}{picked === value && <Check className="h-3 w-3" />}</span>
            </button>
          ))}
        </div>
      )}
    </Dropdown>
  );
}
