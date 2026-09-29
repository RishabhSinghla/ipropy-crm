import { type JSX, type ReactNode, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FieldMeta, FilterGroup, ModuleMeta } from '@ipropy/shared';
import {
  Check, ChevronDown, ChevronUp, Clock3, Filter, ListFilter, PhoneOutgoing,
  Search, UserRound, X,
} from 'lucide-react';
import { useCallDispositionOptions } from '../lib/callDispositions';
import { api } from '../lib/api';
import { countActiveQuickFilters } from '../lib/quickFilters';
import { cn } from '../lib/utils';
import type { DispositionPick } from './CallDispositionFilter';
import { FilterBuilder, countConditions } from './FilterBuilder';
import type { TaskQueue } from './FollowUpQueue';

type ViewChoice = { id: string; name: string; isDefault?: boolean };

export function QuickFilterOverlay({
  open, onClose, module, views, activeViewId, onChooseView,
  ownerField, agent, onAgent,
  stageField, stages, onStages,
  taskEnabled, task, onTask,
  disposition, onDisposition,
  typeField, types, onTypes,
  filter, onFilter, onClear,
}: {
  open: boolean;
  onClose: () => void;
  module: ModuleMeta;
  views: ViewChoice[];
  activeViewId?: string;
  onChooseView: (id: string) => void;
  ownerField?: FieldMeta;
  agent: string | null;
  onAgent: (id: string | null) => void;
  stageField?: FieldMeta;
  stages: string[];
  onStages: (values: string[]) => void;
  taskEnabled: boolean;
  task: TaskQueue | null;
  onTask: (value: TaskQueue | null) => void;
  disposition: DispositionPick;
  onDisposition: (value: DispositionPick) => void;
  typeField?: FieldMeta;
  types: string[];
  onTypes: (values: string[]) => void;
  filter: FilterGroup;
  onFilter: (value: FilterGroup) => void;
  onClear: () => void;
}): JSX.Element | null {
  const [search, setSearch] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const outcomes = useCallDispositionOptions();
  const { data: rawUsers = [] } = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.users(false, false, true),
    enabled: open && Boolean(ownerField),
    staleTime: 5 * 60_000,
  });
  const users = rawUsers.map((user) => ({
    id: String(user.id ?? ''),
    fullName: String(user.fullName ?? ''),
  })).filter((user) => user.id && user.fullName);

  const activeCount = countActiveQuickFilters({ filter, stages, agent, task, disposition, types });
  const needle = search.trim().toLocaleLowerCase();
  const match = (label: string): boolean => !needle || label.toLocaleLowerCase().includes(needle);
  const stageOptions = useMemo(
    () => (stageField?.options ?? []).filter((option) => match(option.label || option.value)),
    [stageField?.options, needle],
  );
  const typeOptions = useMemo(
    () => (typeField?.options ?? []).filter((option) => match(option.label || option.value)),
    [typeField?.options, needle],
  );

  if (!open) return null;

  const toggle = (values: string[], value: string): string[] => (
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
  );
  const toggleOutcome = (value: string): void => onDisposition({
    never: false,
    outcomes: toggle(disposition.outcomes, value),
  });

  return (
    <div className="fixed inset-0 z-[70]" data-testid="quick-filter-overlay">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-slate-950/10 backdrop-blur-[1px]"
        aria-label="Close quick filters"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Quick filters for ${module.label}`}
        className="absolute bottom-0 right-0 top-0 flex w-full max-w-[25rem] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900 sm:top-12"
      >
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              <Filter className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">Quick &amp; Live Filters</h2>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
                  {activeCount} active
                </span>
              </span>
              <p className="mt-0.5 text-[11px] text-muted">Updates the record queue and matching workspace instantly</p>
            </span>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close quick filters">
              <X className="h-4 w-4" />
            </button>
          </div>
          <label className="relative mt-3 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="input h-9 w-full pl-9 text-xs"
              placeholder="Search filters, people, lists or statuses…"
              autoFocus
            />
          </label>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {ownerField && (
            <FilterSection icon={<UserRound className="h-3.5 w-3.5" />} title="Agent wise">
              <Choice label="All agents" checked={!agent} onClick={() => onAgent(null)} />
              {users.filter((user) => match(user.fullName)).map((user) => (
                <Choice key={user.id} label={user.fullName} checked={agent === user.id} onClick={() => onAgent(agent === user.id ? null : user.id)} />
              ))}
            </FilterSection>
          )}

          <FilterSection icon={<ListFilter className="h-3.5 w-3.5" />} title="List wise">
            {views.filter((view) => match(view.name)).map((view) => (
              <Choice
                key={view.id}
                label={view.name}
                hint={view.isDefault ? 'Default' : undefined}
                checked={activeViewId === view.id}
                onClick={() => onChooseView(view.id)}
              />
            ))}
          </FilterSection>

          {stageField && stageOptions.length > 0 && (
            <FilterSection icon={<span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />} title={`${stageField.label} wise`}>
              {stageOptions.map((option) => (
                <Choice
                  key={option.value}
                  label={option.label || option.value}
                  colour={option.color ?? undefined}
                  checked={stages.includes(option.value)}
                  onClick={() => onStages(toggle(stages, option.value))}
                />
              ))}
            </FilterSection>
          )}

          {outcomes.some((outcome) => match(outcome.label)) && (
            <FilterSection icon={<PhoneOutgoing className="h-3.5 w-3.5" />} title="Call state wise">
              <Choice label="Never called" checked={disposition.never} onClick={() => onDisposition({ outcomes: [], never: !disposition.never })} />
              {outcomes.filter((outcome) => match(outcome.label)).map((outcome) => (
                <Choice key={outcome.value} label={outcome.label} checked={disposition.outcomes.includes(outcome.value)} onClick={() => toggleOutcome(outcome.value)} />
              ))}
            </FilterSection>
          )}

          {taskEnabled && (
            <FilterSection icon={<Clock3 className="h-3.5 w-3.5" />} title="Task wise">
              <div className="flex flex-wrap gap-2 px-3 pb-3">
                {([
                  ['today', 'Today'], ['pending', 'Overdue'], ['tomorrow', 'Tomorrow'],
                  ['week', 'This week'], ['month', 'This month'],
                ] as Array<[TaskQueue, string]>).filter(([, label]) => match(label)).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onTask(task === value ? null : value)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors',
                      task === value
                        ? 'border-emerald-600 bg-emerald-600 text-white'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-emerald-300 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </FilterSection>
          )}

          {typeField && typeOptions.length > 0 && (
            <FilterSection icon={<span className="h-2.5 w-2.5 rounded-sm border-2 border-indigo-500" />} title={`${typeField.label} wise`}>
              {typeOptions.map((option) => (
                <Choice key={option.value} label={option.label || option.value} checked={types.includes(option.value)} onClick={() => onTypes(toggle(types, option.value))} />
              ))}
            </FilterSection>
          )}

          <section className="border-b border-slate-100 dark:border-slate-800">
            <button type="button" onClick={() => setAdvanced((value) => !value)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs font-bold text-slate-800 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800/60">
              <Filter className="h-3.5 w-3.5 text-slate-400" />
              Advanced field filters
              {countConditions(filter) > 0 && <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">{countConditions(filter)}</span>}
              {advanced ? <ChevronUp className="ml-auto h-3.5 w-3.5" /> : <ChevronDown className="ml-auto h-3.5 w-3.5" />}
            </button>
            {advanced && <div className="bg-slate-50/70 p-3 dark:bg-slate-950/50"><FilterBuilder module={module} value={filter} onChange={onFilter} /></div>}
          </section>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <button type="button" onClick={onClear} className="btn-secondary flex-1">Clear all</button>
          <button type="button" onClick={onClose} className="flex-[1.35] rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-emerald-700">
            Apply {activeCount ? `${activeCount} filter${activeCount === 1 ? '' : 's'}` : 'all records'}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function FilterSection({ icon, title, children }: { icon: JSX.Element; title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="border-b border-slate-100 py-1 dark:border-slate-800">
      <h3 className="flex items-center gap-2 px-4 pb-1 pt-3 text-xs font-bold text-slate-900 dark:text-white">
        <span className="text-emerald-600">{icon}</span>{title}
      </h3>
      <div className="pb-2">{children}</div>
    </section>
  );
}

function Choice({ label, hint, checked, colour, onClick }: {
  label: string; hint?: string; checked: boolean; colour?: string; onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={cn(
        'flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs transition-colors',
        checked ? 'bg-emerald-50 font-semibold text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100' : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60',
      )}
    >
      <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 dark:border-slate-600')}>
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
      {colour && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colour }} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-[10px] font-normal text-muted">{hint}</span>}
    </button>
  );
}
