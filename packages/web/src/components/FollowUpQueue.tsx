import { type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import type { FieldMeta, FilterGroup, ListQuery } from '@ipropy/shared';
import { api } from '../lib/api';
import { toolbarButton, toolbarCount } from '../lib/toolbarButton';
import { cn } from '../lib/utils';
import { Dropdown } from './ui';
import { AgentPicker } from './AgentPicker';

export type TaskQueue = 'pending' | 'today' | 'tomorrow' | 'upcoming' | 'week' | 'month';

/** Date-only values are stored without a time, so keep task filters date-only too. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The queues narrowed to one agent's records, when an agent is picked.
 *
 * The same condition the list itself adds for the agent, so the numbers on the
 * cards are the rows the list then shows.
 */
export function followUpFiltersFor(
  fieldName: string, agent: { field: string; userId: string } | null,
): Record<TaskQueue, FilterGroup> {
  const filters = followUpFilters(fieldName);
  if (!agent) return filters;
  const mine = { field: agent.field, operator: 'equals' as const, value: agent.userId };
  for (const queue of Object.keys(filters) as TaskQueue[]) {
    filters[queue] = { ...filters[queue], conditions: [...filters[queue].conditions, mine] };
  }
  return filters;
}

/**
 * The one definition of each follow-up queue.
 *
 * Shared with the list rather than copied into it: the panel's counts and the
 * rows the list then shows have to be the same question, or the number on the
 * card and the number under the table disagree and neither can be trusted.
 */
export function followUpFilters(fieldName: string): Record<TaskQueue, FilterGroup> {
  const today = todayIso();
  return {
    pending: { logic: 'AND', conditions: [
      { field: fieldName, operator: 'is_not_empty' },
      { field: fieldName, operator: 'less_than', value: today },
    ] },
    today: { logic: 'AND', conditions: [{ field: fieldName, operator: 'today' }] },
    tomorrow: { logic: 'AND', conditions: [{ field: fieldName, operator: 'tomorrow' }] },
    // Anything still ahead: tomorrow and every day after it.
    upcoming: { logic: 'AND', conditions: [{ field: fieldName, operator: 'greater_than', value: today }] },
    week: { logic: 'AND', conditions: [{ field: fieldName, operator: 'this_week' }] },
    month: { logic: 'AND', conditions: [{ field: fieldName, operator: 'this_month' }] },
  };
}

const CARDS = [
  {
    queue: 'pending' as const, title: 'Overdue', note: 'Requires action',
    box: 'border-red-200 bg-red-50/70 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:hover:bg-red-950/70',
    ring: 'ring-2 ring-red-500', dot: 'bg-red-500',
    head: 'text-red-700 dark:text-red-300', big: 'text-red-700 dark:text-red-200', note_: 'text-red-600 dark:text-red-300',
  },
  {
    queue: 'today' as const, title: 'Due Today', note: 'High priority',
    box: 'border-amber-200 bg-amber-50/70 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/40 dark:hover:bg-amber-950/70',
    ring: 'ring-2 ring-amber-500', dot: 'bg-amber-500',
    head: 'text-amber-800 dark:text-amber-300', big: 'text-amber-900 dark:text-amber-200', note_: 'text-amber-700 dark:text-amber-300',
  },
  {
    queue: 'tomorrow' as const, title: 'Tomorrow', note: 'Scheduled',
    box: 'border-blue-200 bg-blue-50/70 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:hover:bg-blue-950/70',
    ring: 'ring-2 ring-blue-500', dot: 'bg-blue-500',
    head: 'text-blue-700 dark:text-blue-300', big: 'text-blue-800 dark:text-blue-200', note_: 'text-blue-600 dark:text-blue-300',
  },
];

const QUEUE_LABEL: Record<TaskQueue, string> = {
  pending: 'Overdue', today: 'Due today', tomorrow: 'Tomorrow', upcoming: 'Upcoming', week: 'This week', month: 'This month',
};

export function FollowUpQueue({
  moduleName, fieldName, viewId, fieldMap, active, onPick, ownerField, agent, onPickAgent,
}: {
  moduleName: string;
  fieldName: string;
  viewId: string | undefined;
  fieldMap: Map<string, FieldMeta>;
  active: TaskQueue | null;
  onPick: (queue: TaskQueue | null) => void;
  /** The module's assignment field; without one there is no agent to pick. */
  ownerField: string | null;
  /** The list's own agent choice — the same one the Status panel sets. */
  agent: string | null;
  onPickAgent: (userId: string | null) => void;
}): JSX.Element {
  const scope = ownerField && agent ? { field: ownerField, userId: agent } : null;
  const filters = followUpFiltersFor(fieldName, scope);
  const countQuery = (queue: TaskQueue): ListQuery => ({ view: viewId, page: 1, pageSize: 1, filter: filters[queue] });

  // Only the three the trigger adds up are fetched while the panel is shut.
  // The rest — this week, this month, and the rows themselves — are inside
  // the panel, which React does not mount until somebody opens it.
  const counts = {
    pending: useQuery({
      queryKey: ['task-count', moduleName, viewId, 'pending', filters.pending],
      queryFn: () => api.list(moduleName, countQuery('pending')),
    }).data?.total ?? 0,
    today: useQuery({
      queryKey: ['task-count', moduleName, viewId, 'today', filters.today],
      queryFn: () => api.list(moduleName, countQuery('today')),
    }).data?.total ?? 0,
    tomorrow: useQuery({
      queryKey: ['task-count', moduleName, viewId, 'tomorrow', filters.tomorrow],
      queryFn: () => api.list(moduleName, countQuery('tomorrow')),
    }).data?.total ?? 0,
  };
  const total = counts.pending + counts.today + counts.tomorrow;

  return (
    <div className="inline-flex items-center gap-1.5">
      <Dropdown
        align="left"
        className="w-[27rem]"
        trigger={
          <button
            type="button"
            title="The follow-ups waiting on you"
            /* One shape for every filter button on this row — see
               `lib/toolbarButton.ts`. Two idioms for "this one is on" is the
               toolbar reading as two toolbars. */
            className={toolbarButton(Boolean(active))}
          >
            {/* *"'Follow-ups' to Task"* — the owner's word for it, 28
                September 2026. The field is still whatever the module calls
                it; this is the button.

                **The word is back on it** — *"Also Show the name of all icons
                'All Leads/Inventory, Followup, Tag Name (hot)' in the record
                left pane"* (3 October 2026), reversing the icons-only row of
                1 October. */}
            <span>Task</span>
            {/* Something overdue stays red on the purple: it is the one count
                in this row that is a warning rather than a size. */}
            <span className={toolbarCount(Boolean(active), counts.pending > 0)}>
              {total.toLocaleString('en-IN')}
            </span>
          </button>
        }
      >
        {(close) => (
          <QueuePanel
            moduleName={moduleName}
            fieldName={fieldName}
            viewId={viewId}
            fieldMap={fieldMap}
            filters={filters}
            counts={counts}
            total={total}
            active={active}
            onPick={(queue) => { onPick(queue); close(); }}
            agentPicker={ownerField ? <AgentPicker moduleName={moduleName} agent={agent} onPickAgent={onPickAgent} /> : null}
          />
        )}
      </Dropdown>

      {/* A filter nobody can see is a filter nobody can undo. */}
      {active && (
        <button
          type="button"
          onClick={() => onPick(null)}
          className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white hover:bg-brand-700"
          title={`${QUEUE_LABEL[active]} — show every record again`}
          aria-label={`Clear ${QUEUE_LABEL[active]}`}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Mounted only while the panel is open, so its queries cost nothing when it is shut. */
function QueuePanel({
  moduleName, fieldName, viewId, filters, counts, total, active, onPick, agentPicker,
}: {
  moduleName: string;
  fieldName: string;
  viewId: string | undefined;
  fieldMap: Map<string, FieldMeta>;
  filters: Record<TaskQueue, FilterGroup>;
  counts: { pending: number; today: number; tomorrow: number };
  total: number;
  active: TaskQueue | null;
  onPick: (queue: TaskQueue | null) => void;
  agentPicker: JSX.Element | null;
}): JSX.Element {
  const navigate = useNavigate();

  const week = useQuery({
    queryKey: ['task-count', moduleName, viewId, 'week', filters.week],
    queryFn: () => api.list(moduleName, { view: viewId, page: 1, pageSize: 1, filter: filters.week }),
  }).data?.total ?? 0;
  const month = useQuery({
    queryKey: ['task-count', moduleName, viewId, 'month', filters.month],
    queryFn: () => api.list(moduleName, { view: viewId, page: 1, pageSize: 1, filter: filters.month }),
  }).data?.total ?? 0;

  /*
    Up next is whichever queue actually has work, not always today. A rep whose
    today is empty and whose overdue is 966 needs the oldest of those, and the
    panel showing "Up Next Today (0)" while a red 966 sits above it is the
    screen telling them there is nothing to do.
  */
  const next: TaskQueue = counts.pending > 0 ? 'pending' : counts.today > 0 ? 'today' : 'tomorrow';

  const { data: upNext } = useQuery({
    queryKey: ['task-next', moduleName, viewId, next, filters[next]],
    // Oldest first: the point of the queue is who has waited longest.
    queryFn: () => api.list(moduleName, {
      view: viewId, page: 1, pageSize: 1, filter: filters[next], sortBy: fieldName, sortDir: 'asc',
    }),
  });
  const rows = upNext?.rows ?? [];

  const start = (): void => {
    onPick(next);
    if (rows[0]) {
      const params = new URLSearchParams({ open: rows[0].id, filter: JSON.stringify(filters[next]), sortBy: fieldName, sortDir: 'asc' });
      if (viewId) params.set('view', viewId);
      navigate(`/${moduleName}?${params}`);
    }
  };

  return (
    <div className="text-xs">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/50">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold tracking-tight text-slate-800 dark:text-slate-100">Follow-up Queue</h3>
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold text-brand-700 dark:bg-brand-950/60 dark:text-brand-200">
              {total.toLocaleString('en-IN')} total
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">Scheduled client calls and site visits</p>
        </div>
        <button
          type="button"
          onClick={start}
          disabled={!rows.length}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-40"
          title="Open the first follow-up record; press Call when ready. No automatic call is placed."
        >
          <Sparkles className="h-3 w-3" />
          Start calling
        </button>
      </div>

      {agentPicker && <div className="px-2 pt-2">{agentPicker}</div>}

      <div className="grid grid-cols-3 gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
        {CARDS.map((card) => {
          const count = counts[card.queue];
          const on = active === card.queue;
          return (
            <button
              key={card.queue}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(on ? null : card.queue)}
              className={cn('rounded-xl border p-2.5 text-left transition-colors', card.box, on && card.ring)}
            >
              <span className="flex items-center justify-between">
                <span className={cn('text-[10px] font-bold uppercase tracking-wider', card.head)}>{card.title}</span>
                <span className={cn('h-2 w-2 rounded-full', card.dot)} />
              </span>
              <span className="mt-1.5 flex items-baseline justify-between gap-1">
                <span className={cn('text-xl font-extrabold tracking-tight tabular-nums', card.big)}>
                  {count.toLocaleString('en-IN')}
                </span>
                <span className={cn('text-[10px] font-medium', card.note_)}>{card.note}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 border-t border-slate-100 px-3 py-2 dark:border-slate-800">
        <button type="button" onClick={() => onPick('week')} className="text-[11px] font-semibold text-slate-600 hover:text-brand-600 dark:text-slate-300">
          This week ({week.toLocaleString('en-IN')})
        </button>
        <span className="text-slate-300 dark:text-slate-600">•</span>
        <button type="button" onClick={() => onPick('month')} className="text-[11px] font-semibold text-slate-600 hover:text-brand-600 dark:text-slate-300">
          This month ({month.toLocaleString('en-IN')})
        </button>
        {active && (
          <button type="button" onClick={() => onPick(null)} className="ml-auto text-[11px] font-semibold text-muted hover:text-slate-700 dark:hover:text-slate-200">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
