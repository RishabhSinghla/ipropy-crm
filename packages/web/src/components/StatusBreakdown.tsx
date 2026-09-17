import { type JSX, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ListFilter } from 'lucide-react';
import type { FieldMeta, FilterGroup, ModuleMeta } from '@ipropy/shared';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { badgeVars } from '../lib/color';
import { Dropdown } from './ui';

/**
 * The pipeline at a glance, and a filter built from it.
 *
 * A per-column filter can already narrow to a status, but it asks somebody to
 * know which status they want before it will tell them anything. The whole
 * value of a pipeline is the shape — 64% of 22,970 sitting in Contacted is the
 * fact that decides the day, and no dropdown of names contains it.
 *
 * The counts come from the same grouping the kanban uses, so the bars and the
 * board cannot disagree.
 */
export function StatusBreakdown({
  moduleName, meta, viewId, baseFilter, selected, onApply,
}: {
  moduleName: string;
  meta: ModuleMeta;
  viewId: string | undefined;
  /** The filter already in force, so the bars describe what is on screen. */
  baseFilter: FilterGroup | undefined;
  selected: string[];
  onApply: (values: string[]) => void;
}): JSX.Element | null {
  const fieldName = meta.pipelineField;
  const field = fieldName ? meta.fields.find((f) => f.name === fieldName) : undefined;
  if (!fieldName || !field) return null;

  return (
    <Dropdown
      align="left"
      className="w-[24rem]"
      trigger={
        <button
          type="button"
          title={`Break ${meta.label} down by ${field.label}`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1',
            selected.length
              ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-200'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
          )}
        >
          <ListFilter className="h-3.5 w-3.5" />
          {field.label}
          <span className="text-muted">
            {selected.length ? `(${selected.length} picked)` : `(${field.options?.length ?? 0} stages)`}
          </span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      }
    >
      {(close) => (
        <BreakdownPanel
          moduleName={moduleName}
          field={field}
          viewId={viewId}
          baseFilter={baseFilter}
          selected={selected}
          onApply={(values) => { onApply(values); close(); }}
        />
      )}
    </Dropdown>
  );
}

/** Mounted only while open, so the grouping query costs nothing when it is shut. */
function BreakdownPanel({
  moduleName, field, viewId, baseFilter, selected, onApply,
}: {
  moduleName: string;
  field: FieldMeta;
  viewId: string | undefined;
  baseFilter: FilterGroup | undefined;
  selected: string[];
  onApply: (values: string[]) => void;
}): JSX.Element {
  // Held locally so somebody can tick three stages and apply once, rather than
  // reloading 22,970 records between each tick.
  const [picked, setPicked] = useState<string[]>(selected);

  const { data, isLoading } = useQuery({
    queryKey: ['breakdown', moduleName, viewId, field.name, baseFilter],
    queryFn: () => api.list(moduleName, {
      view: viewId, page: 1, pageSize: 1, filter: baseFilter, groupBy: field.name,
    }),
  });

  const groups = data?.groups ?? [];
  const total = groups.reduce((sum, g) => sum + g.count, 0);

  const toggle = (value: string): void =>
    setPicked((current) => current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/50">
        <div>
          <h3 className="text-sm font-bold tracking-tight text-slate-800 dark:text-slate-100">
            Filter by {field.label}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted">
            {isLoading ? 'Counting…' : `${total.toLocaleString('en-IN')} records in view`}
          </p>
        </div>
        {picked.length > 0 && (
          <button
            type="button"
            onClick={() => { setPicked([]); onApply([]); }}
            className="rounded-md px-2 py-1 text-[11px] font-semibold text-muted hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            Reset
          </button>
        )}
      </div>

      <div className="max-h-[19rem] overflow-y-auto p-2">
        {isLoading && <p className="p-4 text-center text-[11px] text-muted">Counting…</p>}
        {!isLoading && groups.length === 0 && (
          <p className="p-4 text-center text-[11px] text-muted">Nothing to break down yet.</p>
        )}
        {groups.map((group) => {
          const share = total ? (group.count / total) * 100 : 0;
          const on = picked.includes(group.key);
          return (
            <button
              key={group.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(group.key)}
              className={cn(
                'mb-1 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                on
                  ? 'border-brand-300 bg-brand-50 dark:border-brand-800 dark:bg-brand-950/50'
                  : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                /* The admin's own colour for this stage, through the helper that
                   keeps it legible rather than painting the raw hue. */
                style={group.color ? badgeVars(group.color) : undefined}
              >
                <span className="badge-solid block h-full w-full rounded-full" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold text-slate-800 dark:text-slate-100">{group.label}</span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {share.toFixed(1)}% · {group.count.toLocaleString('en-IN')}
                  </span>
                </span>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <span
                    className={cn('block h-full rounded-full', on ? 'bg-brand-600' : 'bg-slate-400 dark:bg-slate-500')}
                    style={{ width: `${Math.max(share, share > 0 ? 1.5 : 0)}%` }}
                  />
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
        <span className="text-[11px] text-muted">
          {picked.length ? `${picked.length} stage${picked.length > 1 ? 's' : ''} picked` : 'Pick one or more stages'}
        </span>
        <button
          type="button"
          onClick={() => onApply(picked)}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
