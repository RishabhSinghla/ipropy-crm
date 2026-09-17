import { type JSX, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Check, ChevronDown, ChevronRight } from 'lucide-react';
import type { FilterGroup, ModuleMeta } from '@ipropy/shared';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { badgeVars } from '../lib/color';
import { pipelineFieldOf } from '../lib/fields';
import { Avatar, Dropdown } from './ui';

/**
 * The pipeline at a glance, and a filter built from it.
 *
 * A per-column filter can already narrow to a status, but it asks somebody to
 * know which status they want before it will tell them anything. The whole
 * value of a pipeline is its shape — 64% of 22,970 sitting in Contacted is the
 * fact that decides the day, and no dropdown of names contains it.
 *
 * Every colour on the rows is the admin's own colour for that stage, taken
 * through `badgeVars` rather than painted raw: the prototype hard-codes amber
 * for In Discussion and emerald for Deal Won, and hard-coding those here would
 * mean a stage somebody recolours in Admin stays the wrong colour for ever.
 *
 * The counts come from the same grouping the kanban uses, so the bars and the
 * board cannot disagree.
 */
export function StatusBreakdown({
  moduleName, meta, viewId, baseFilter, selected, agent, onApply, onPickAgent,
}: {
  moduleName: string;
  meta: ModuleMeta;
  viewId: string | undefined;
  /** The filter already in force, so the counts describe what is on screen. */
  baseFilter: FilterGroup | undefined;
  selected: string[];
  agent: string | null;
  onApply: (values: string[]) => void;
  onPickAgent: (userId: string | null) => void;
}): JSX.Element | null {
  const field = pipelineFieldOf(meta);
  if (!field) return null;

  const on = selected.length > 0 || agent !== null;

  return (
    <Dropdown
      align="left"
      className="w-80"
      trigger={
        <button
          type="button"
          title={`Filter by ${field.label}`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold shadow-xs transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
            on
              ? 'border-brand-200 bg-brand-50 text-brand-700 ring-2 ring-brand-500/20 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-200'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
          )}
        >
          <BarChart3 className={cn('h-3.5 w-3.5', on ? 'text-brand-600 dark:text-brand-300' : 'text-slate-500')} />
          {field.label}
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[10px] font-bold',
              on
                ? 'bg-brand-200/80 text-brand-800 dark:bg-brand-900 dark:text-brand-100'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
            )}
          >
            {selected.length ? `${selected.length} picked` : `${field.options?.length ?? 0} stages`}
          </span>
          <ChevronDown className={cn('h-3 w-3', on ? 'text-brand-600 dark:text-brand-300' : 'text-slate-400')} />
        </button>
      }
    >
      {(close) => (
        <BreakdownPanel
          moduleName={moduleName}
          moduleLabel={meta.label}
          fieldName={field.name}
          fieldLabel={field.label}
          viewId={viewId}
          baseFilter={baseFilter}
          selected={selected}
          agent={agent}
          onPickAgent={onPickAgent}
          onApply={(values) => { onApply(values); close(); }}
          onApplyStaying={onApply}
        />
      )}
    </Dropdown>
  );
}

/** Mounted only while open, so its two queries cost nothing when it is shut. */
function BreakdownPanel({
  moduleName, moduleLabel, fieldName, fieldLabel, viewId, baseFilter,
  selected, agent, onApply, onApplyStaying, onPickAgent,
}: {
  moduleName: string;
  moduleLabel: string;
  fieldName: string;
  fieldLabel: string;
  viewId: string | undefined;
  baseFilter: FilterGroup | undefined;
  selected: string[];
  agent: string | null;
  onApply: (values: string[]) => void;
  onApplyStaying: (values: string[]) => void;
  onPickAgent: (userId: string | null) => void;
}): JSX.Element {
  /*
    One stage at a time unless somebody asks for more. The prototype's checkbox
    is the whole difference: without it every click would have to be confirmed
    with Apply, and picking one stage — which is what this is for nine times out
    of ten — would cost two clicks instead of one.
  */
  const [multi, setMulti] = useState(selected.length > 1);
  const [picked, setPicked] = useState<string[]>(selected);

  const { data, isLoading } = useQuery({
    queryKey: ['breakdown', moduleName, viewId, fieldName, baseFilter],
    queryFn: () => api.list(moduleName, {
      view: viewId, page: 1, pageSize: 1, filter: baseFilter, groupBy: fieldName,
    }),
  });
  const { data: rawUsers } = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.users(false, false, true),
  });
  // `api.users` is untyped on purpose (the admin screens read many shapes off
  // it); narrow to the two fields this panel needs rather than casting inline.
  const users = (rawUsers ?? []).map((u) => ({
    id: String((u as { id?: unknown }).id ?? ''),
    name: String((u as { fullName?: unknown }).fullName ?? ''),
  })).filter((u) => u.id && u.name);

  const groups = data?.groups ?? [];
  const total = groups.reduce((sum, g) => sum + g.count, 0);

  const choose = (value: string): void => {
    if (!multi) { onApply([value]); return; }
    setPicked((current) => current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
  };

  return (
    <div className="text-xs">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/90 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/50">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-bold tracking-tight text-slate-800 dark:text-slate-100">{fieldLabel} breakdown</h4>
            <span className="rounded-full bg-brand-100/70 px-1.5 py-px text-[10px] font-bold text-brand-700 dark:bg-brand-950/60 dark:text-brand-200">
              {total.toLocaleString('en-IN')}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-muted">Filter {moduleLabel.toLowerCase()} by pipeline stage</p>
        </div>
        {(picked.length > 0 || agent) && (
          <button
            type="button"
            onClick={() => { setPicked([]); onPickAgent(null); onApply([]); }}
            className="shrink-0 text-[11px] font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400"
          >
            Clear
          </button>
        )}
      </div>

      <div className="space-y-1 p-2 pt-1.5">
        {users.length > 1 && (
          <div className="border-b border-slate-100 px-1 pb-2 pt-0.5 dark:border-slate-800">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted">
              <span>Filter by agent</span>
              <button
                type="button"
                onClick={() => onPickAgent(null)}
                className={cn(
                  'font-medium normal-case',
                  agent === null ? 'text-muted' : 'text-brand-600 hover:underline dark:text-brand-400',
                )}
              >
                All
              </button>
            </div>
            {/* Two rows of agents, then it scrolls. Nine people is three rows
                of chips, which pushed the stages themselves off the screen. */}
            <div className="grid max-h-[3.4rem] grid-cols-3 gap-1 overflow-y-auto">
              {users.slice(0, 9).map((user) => {
                const mine = agent === user.id;
                return (
                  <button
                    key={user.id}
                    type="button"
                    aria-pressed={mine}
                    title={user.name}
                    onClick={() => onPickAgent(mine ? null : user.id)}
                    className={cn(
                      'flex items-center justify-center gap-1 truncate rounded-md border px-1.5 py-1 text-[10px] transition-colors',
                      mine
                        ? 'border-brand-200 bg-brand-50 font-semibold text-brand-700 dark:border-brand-800 dark:bg-brand-950/50 dark:text-brand-200'
                        : 'border-slate-200 bg-slate-50 font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-800',
                    )}
                  >
                    <Avatar name={user.name} size={14} className="text-[8px]" />
                    <span className="truncate">{user.name.split(/\s+/)[0]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* All stages, which is what no choice means — shown as a row so the
            way back is in the same place as the way in. */}
        <button
          type="button"
          aria-pressed={picked.length === 0}
          onClick={() => { setPicked([]); onApply([]); }}
          className={cn(
            'flex w-full items-center justify-between rounded-lg px-2 py-1.5 font-semibold transition-colors',
            picked.length === 0
              ? 'border border-brand-200/50 bg-brand-50/80 text-brand-800 dark:border-brand-800/60 dark:bg-brand-950/50 dark:text-brand-100'
              : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800',
          )}
        >
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-brand-600" />
            All stages
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[10px] font-normal text-muted">100%</span>
            <span className="rounded-full bg-brand-200/80 px-1.5 py-px text-[10px] font-bold text-brand-800 dark:bg-brand-900 dark:text-brand-100">
              {total.toLocaleString('en-IN')}
            </span>
            {picked.length === 0 && <Check className="h-3 w-3 text-brand-600 dark:text-brand-300" />}
          </span>
        </button>

        {isLoading && <p className="p-3 text-center text-[11px] text-muted">Counting…</p>}
        {!isLoading && groups.length === 0 && (
          <p className="p-3 text-center text-[11px] text-muted">Nothing to break down yet.</p>
        )}

        {/*
          The stages scroll; the panel does not grow with them.

          A module with ten stages made this taller than most laptop screens,
          which puts Apply and the agent chips below the fold — the two things
          somebody opens it to reach. Roughly six rows are visible, so the
          seventh peeking is what says there are more.
        */}
        <div className="max-h-[11rem] space-y-0.5 overflow-y-auto">
        {groups.map((group) => {
          const share = total ? (group.count / total) * 100 : 0;
          const on = picked.includes(group.key);
          const vars = badgeVars(group.color);
          return (
            <button
              key={group.key}
              type="button"
              aria-pressed={on}
              onClick={() => choose(group.key)}
              className={cn(
                'group flex w-full items-center justify-between rounded-lg px-2 py-1.5 font-medium transition-colors',
                on
                  ? 'border border-brand-200/50 bg-brand-50/80 text-brand-800 dark:border-brand-800/60 dark:bg-brand-950/50 dark:text-brand-100'
                  : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="badge-solid h-2 w-2 shrink-0 rounded-full" style={vars} />
                <span className="truncate">{group.label}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-[10px] font-normal text-muted tabular-nums">{share.toFixed(1)}%</span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums',
                    vars ? 'badge-tinted border' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
                  )}
                  style={vars}
                >
                  {group.count.toLocaleString('en-IN')}
                </span>
                {on
                  ? <Check className="h-3 w-3 text-brand-600 dark:text-brand-300" />
                  : <ChevronRight className="h-3 w-3 text-slate-300 group-hover:text-slate-500 dark:text-slate-600" />}
              </span>
            </button>
          );
        })}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/90 px-2.5 py-2 dark:border-slate-800 dark:bg-slate-800/50">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={multi}
            onChange={(e) => {
              setMulti(e.target.checked);
              // Leaving multi-select with several stages picked would leave the
              // list filtered by a set the panel can no longer show as chosen.
              if (!e.target.checked && picked.length > 1) { setPicked([]); onApplyStaying([]); }
            }}
            className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-0"
          />
          <span className="select-none text-[11px] font-medium text-slate-600 dark:text-slate-300">Select multiple stages</span>
        </label>
        <button
          type="button"
          disabled={!multi}
          onClick={() => onApply(picked)}
          className="rounded-md bg-brand-600 px-2.5 py-1 text-[11px] font-medium text-white shadow-xs transition-colors hover:bg-brand-700 disabled:opacity-40"
          title={multi ? 'Apply the stages you picked' : 'Tick "Select multiple stages" to pick more than one'}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
