/**
 * The Quick & Live Filters panel.
 *
 * **1 October 2026, the owner**, of the first version: it opened at an odd
 * size over the whole screen, every list was laid out in full, and nothing
 * said how many records were left. So:
 *
 *  * it slides in **exactly over the right-hand pane**, the shape of the pane
 *    it was opened from, and slides away again;
 *  * the **live record count** sits in its header and moves as you choose;
 *  * **every section folds** — a heading to tap, open only when it is in use;
 *  * a list longer than five shows its **top five, a search and Show all / Show fewer**;
 *  * money and sizes are a **min–max slider**; dates have **Yesterday, Today,
 *    This week, This month and a date picker**; tasks **Overdue, Today,
 *    Tomorrow, Upcoming and a date**.
 *
 * Which sections appear, in what order and under what name is Admin → Quick
 * Filters (`lib/quickFilters.ts` holds the rules). Every choice narrows the
 * list the moment it is made — there is no Apply to forget to press.
 */
import { createContext, useContext, type JSX, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { formatIndianPrice, type FieldMeta, type FilterGroup, type ListQuery, type ModuleMeta, type QuickFilterSection } from '@ipropy/shared';
import {
  CalendarDays, Check, ChevronDown, Clock3, Filter, Hash, ListFilter, PhoneOutgoing,
  Search, SlidersHorizontal, Tag, UserRound, X,
} from 'lucide-react';
import { useCallDispositionOptions } from '../lib/callDispositions';
import { api } from '../lib/api';
import {
  DATE_PRESETS, EMPTY_PICK, TAGS_KEY, countActiveQuickFilters, pickIsActive, quickPickConditions, sectionLabel, parseTypedAmount, sliderStep, topValues,
  type DatePreset, type QuickPick, type QuickPicks,
} from '../lib/quickFilters';
import { cn } from '../lib/utils';
import type { DispositionPick } from './CallDispositionFilter';
import { FilterBuilder, countConditions } from './FilterBuilder';
import { followUpFilters, type TaskQueue } from './FollowUpQueue';
import { Spinner } from './ui';

type ViewChoice = { id: string; name: string; isDefault?: boolean; count?: number };
type Option = { value: string; label: string; color?: string | null; count?: number };
const CountContext = createContext<ListQuery>({});

/*
  Every filter says how many records each choice holds — the owner, 3 October
  2026: *"I need count displayed all where in all filters"*. Counted over the
  whole module, the way Lost Reason always was, and only once a section is
  opened, so a folded heading costs nothing.
*/
function useFacetCounts(module: string, field: string | undefined): { counts: Map<string, number>; blank: number | undefined; loading: boolean } {
  const context = useContext(CountContext);
  const { data, isLoading } = useQuery({
    queryKey: ['facet', module, field, context],
    queryFn: () => api.facet(module, field!, undefined, 50, context),
    enabled: Boolean(field),
    staleTime: 60_000,
  });
  return {
    counts: new Map((data?.values ?? []).map((row) => [row.value, row.count])),
    blank: data?.blank,
    loading: Boolean(field) && isLoading,
  };
}

/** How many records each chip's filter matches — one small count per chip. */
function useChipCounts<T extends string>(module: string, filters: Array<[T, FilterGroup]>): Partial<Record<T, number>> {
  const context = useContext(CountContext);
  const results = useQueries({
    queries: filters.map(([key, filter]) => ({
      queryKey: ['chip-count', module, key, filter, context],
      queryFn: () => api.list(module, { ...context, filter: { logic: 'AND', conditions: [filter, ...(context.filter ? [context.filter] : [])] }, page: 1, pageSize: 1 }),
      staleTime: 60_000,
    })),
  });
  const counts: Partial<Record<T, number>> = {};
  filters.forEach(([key], index) => {
    const total = results[index]?.data?.total;
    if (total !== undefined) counts[key] = total;
  });
  return counts;
}

const TASK_CHOICES: Array<[TaskQueue, string]> = [
  ['pending', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['upcoming', 'Upcoming'],
];

export interface QuickFilterPanelProps {
  countContext?: ListQuery;
  open: boolean;
  onClose: () => void;
  /** `pane` fills the right-hand pane it was opened from; `floating` sits at the screen's right edge. */
  placement: 'pane' | 'floating';
  module: ModuleMeta;
  sections: QuickFilterSection[];
  /** How many records the list holds with everything chosen so far. */
  count: number | undefined;
  counting: boolean;
  views: ViewChoice[];
  activeViewId?: string;
  onChooseView: (id: string) => void;
  ownerField?: FieldMeta;
  agent: string | null;
  onAgent: (id: string | null) => void;
  stageField?: FieldMeta;
  stages: string[];
  onStages: (values: string[]) => void;
  taskField?: FieldMeta;
  task: TaskQueue | null;
  onTask: (value: TaskQueue | null) => void;
  disposition: DispositionPick;
  onDisposition: (value: DispositionPick) => void;
  picks: QuickPicks;
  onPick: (field: string, pick: QuickPick | null) => void;
  filter: FilterGroup;
  onFilter: (value: FilterGroup) => void;
  onClear: () => void;
}

export function QuickFilterOverlay(props: QuickFilterPanelProps): JSX.Element | null {
  const { open, onClose, placement, module, sections, count, counting, picks, filter, onClear } = props;
  const [find, setFind] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const fields = useMemo(() => new Map(module.fields.map((field) => [field.name, field])), [module.fields]);

  // It stays mounted for the length of its slide out, so it can leave as it came.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(timer);
  }, [open]);

  // Escape closes it, like every other panel in the CRM.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const activeCount = countActiveQuickFilters({
    filter, stages: props.stages, agent: props.agent, task: props.task, disposition: props.disposition, picks,
  });
  const needle = find.trim().toLocaleLowerCase();
  const visible = sections
    .filter((section) => !section.hidden)
    .map((section) => ({ section, title: sectionLabel(section, fields, props.stageField?.label) }))
    .filter(({ title }) => !needle || title.toLocaleLowerCase().includes(needle));

  return (
    <CountContext.Provider value={props.countContext ?? {}}><div
      className={cn('z-40', placement === 'pane' ? 'absolute inset-0' : 'fixed bottom-0 right-0 top-12 w-full max-w-[22.5rem]')}
      data-testid="quick-filter-overlay"
    >
      <aside
        role="dialog"
        aria-label={`Quick filters for ${module.label}`}
        className={cn(
          'flex h-full w-full flex-col border-l border-slate-200 bg-white shadow-xl transition-all duration-200 ease-out dark:border-slate-700 dark:bg-slate-900',
          shown ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
        )}
      >
        <header className="shrink-0 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-brand-600" />
            <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-slate-900 dark:text-white">Quick &amp; Live Filters</h2>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close quick filters">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[11px]">
            {/* The live answer: how many records every choice so far leaves. */}
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2 py-0.5 font-bold text-white" data-testid="quick-filter-count" aria-live="polite">
              {counting ? <Spinner className="h-3 w-3" /> : null}
              {count === undefined ? '…' : count.toLocaleString('en-IN')} records
            </span>
            <span className="text-muted">{activeCount ? `${activeCount} filter${activeCount === 1 ? '' : 's'} on` : 'No filters on'}</span>
            {activeCount > 0 && (
              <button type="button" onClick={onClear} className="ml-auto font-semibold text-brand-700 hover:underline dark:text-brand-300">Clear all</button>
            )}
          </div>
          <label className="relative mt-2 block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={find}
              onChange={(event) => setFind(event.target.value)}
              className="input h-8 w-full pl-8 text-xs"
              placeholder="Find a filter…"
              aria-label="Find a filter"
            />
          </label>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.map(({ section, title }) => (
            <SectionFor key={section.key} section={section} title={title} props={props} fields={fields} />
          ))}
          <Folding
            icon={<Filter className="h-3.5 w-3.5" />}
            title="Advanced field filters"
            active={countConditions(filter)}
            open={advanced}
            onToggle={() => setAdvanced((value) => !value)}
          >
            <div className="bg-slate-50/70 p-3 dark:bg-slate-950/50"><FilterBuilder module={module} value={filter} onChange={props.onFilter} /></div>
          </Folding>
        </div>
      </aside>
    </div></CountContext.Provider>
  );
}

/** Which body a section gets, by its kind. */
function SectionFor({ section, title, props, fields }: {
  section: QuickFilterSection; title: string; props: QuickFilterPanelProps; fields: Map<string, FieldMeta>;
}): JSX.Element | null {
  const top = section.top ?? 5;
  const toggle = (values: string[], value: string): string[] => (
    values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
  );

  switch (section.kind) {
    case 'agent':
      return props.ownerField ? (
        <AgentSection section={section} title={title} top={top} module={props.module.name} ownerField={props.ownerField.name} agent={props.agent} onAgent={props.onAgent} />
      ) : null;
    case 'list':
      return (
        <FoldingState section={section} title={title} icon={<ListFilter className="h-3.5 w-3.5" />} active={0}>
          <ChoiceList
            options={props.views.map((view) => ({ value: view.id, label: view.name, count: view.count }))}
            ticked={props.activeViewId ? [props.activeViewId] : []}
            top={top}
            onTick={(id) => props.onChooseView(id)}
          />
        </FoldingState>
      );
    case 'tags':
      return <TagsSection section={section} title={title} top={top} module={props.module.name} props={props} />;
    case 'stage':
      return props.stageField ? (
        <FoldingState section={section} title={title} icon={<span className="h-2.5 w-2.5 rounded-full bg-brand-500" />} active={props.stages.length}>
          <StageChoices module={props.module.name} field={props.stageField} ticked={props.stages} top={top} onTick={(value) => props.onStages(toggle(props.stages, value))} />
        </FoldingState>
      ) : null;
    case 'calls':
      return <CallsSection section={section} title={title} top={top} module={props.module.name} disposition={props.disposition} onDisposition={props.onDisposition} />;
    case 'task':
      return props.taskField ? (
        <TaskSection section={section} title={title} props={props} field={props.taskField} />
      ) : null;
    case 'values': {
      const field = fields.get(section.key);
      return field ? <ValuesSection section={section} title={title} module={props.module.name} field={field} top={top} props={props} /> : null;
    }
    case 'range': {
      const field = fields.get(section.key);
      return field ? <RangeSection section={section} title={title} module={props.module.name} field={field} props={props} /> : null;
    }
    case 'date':
      return <DateSection section={section} title={title} fieldName={section.key} props={props} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------ */
/* The fold every section shares                                              */
/* ------------------------------------------------------------------------ */

function Folding({ icon, title, active, open, onToggle, children }: {
  icon: ReactNode; title: string; active: number; open: boolean; onToggle: () => void; children: ReactNode;
}): JSX.Element {
  return (
    <section className="border-b border-slate-100 dark:border-slate-800">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-bold text-slate-800 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800/60"
      >
        <span className="flex w-4 justify-center text-brand-600">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {active > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">{active}</span>}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="pb-2">{children}</div>}
    </section>
  );
}

/**
 * A fold that opens itself when something in it is chosen — a filter that is
 * on is never hidden behind a closed heading — and otherwise as the master says.
 */
function FoldingState({ section, title, icon, active, children }: {
  section: QuickFilterSection; title: string; icon: ReactNode; active: number; children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(Boolean(section.open) || active > 0);
  return (
    <Folding icon={icon} title={title} active={active} open={open} onToggle={() => setOpen((value) => !value)}>
      {children}
    </Folding>
  );
}

/* ------------------------------------------------------------------------ */
/* Lists: the top few, and a search for the rest                              */
/* ------------------------------------------------------------------------ */

function ChoiceList({ options, ticked, top, onTick, loading, always }: {
  options: Option[];
  ticked: string[];
  top: number;
  onTick: (value: string) => void;
  loading?: boolean;
  /**
   * A choice that is never cut from the list and never hidden by the search.
   *
   * "Not filled in" is the one row somebody comes to this panel *for* (3
   * October 2026), and it is counted last by definition — a field nobody has
   * filled in on many records would still rank below five common values. Left
   * in the ordinary list it would sit past the "search to find one" line, on
   * every field with more than a handful of options.
   */
  always?: Option;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const needle = search.trim().toLocaleLowerCase();
  const searchable = options.length > top;
  const shown = needle
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle) || ticked.includes(option.value))
    : expanded ? options : topValues(options, ticked, top);
  return (
    <div>
      {searchable && (
        <label className="relative mx-3 mb-1 block">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="input h-7 w-full pl-7 text-[11px]"
            placeholder={`Search all ${options.length}…`}
            aria-label="Search this filter"
          />
        </label>
      )}
      {loading && <p className="px-4 py-1 text-[11px] text-muted">Loading…</p>}
      {always && <Choice option={always} checked={ticked.includes(always.value)} onClick={() => onTick(always.value)} />}
      {shown.map((option) => (
        <Choice key={option.value} option={option} checked={ticked.includes(option.value)} onClick={() => onTick(option.value)} />
      ))}
      {!loading && !shown.length && <p className="px-4 py-1 text-[11px] text-muted">Nothing matches.</p>}
      {!needle && options.length > shown.length && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(true)} className="px-4 py-1 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          {options.length - shown.length} more — show all
        </button>
      )}
      {!needle && expanded && searchable && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(false)} className="px-4 py-1 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">Show fewer</button>
      )}
    </div>
  );
}

function Choice({ option, checked, onClick }: { option: Option; checked: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={cn(
        'flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs transition-colors',
        checked ? 'bg-brand-50 font-semibold text-brand-900 dark:bg-brand-950 dark:text-brand-100' : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60',
      )}
    >
      <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-slate-600')}>
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: option.color || undefined }} />
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.count !== undefined && <span className="text-[10px] tabular-nums text-muted">{option.count.toLocaleString('en-IN')}</span>}
    </button>
  );
}

/** The stage's own options, in the dropdown's order, each with its count. */
function StageChoices({ module, field, ticked, top, onTick }: {
  module: string; field: FieldMeta; ticked: string[]; top: number; onTick: (value: string) => void;
}): JSX.Element {
  const { counts, blank, loading } = useFacetCounts(module, field.name);
  const options: Option[] = (field.options ?? []).map((option) => ({
    value: option.value, label: option.label || option.value, color: option.color, count: loading ? undefined : counts.get(option.value) ?? 0,
  }));
  // A record with no stage at all is a real thing to go looking for, so the
  // stage list offers the same "Not filled in" row every other dropdown does.
  const notFilled = { value: EMPTY_PICK, label: 'Unfilled', count: loading ? undefined : blank ?? 0 };
  return <ChoiceList options={options} ticked={ticked} top={top} onTick={onTick} always={notFilled} />;
}

function AgentSection({ section, title, top, module, ownerField, agent, onAgent }: {
  section: QuickFilterSection; title: string; top: number; module: string; ownerField: string; agent: string | null; onAgent: (id: string | null) => void;
}): JSX.Element {
  return (
    <FoldingState section={section} title={title} icon={<UserRound className="h-3.5 w-3.5" />} active={agent ? 1 : 0}>
      <AgentChoices top={top} module={module} ownerField={ownerField} agent={agent} onAgent={onAgent} />
    </FoldingState>
  );
}

/** Everybody a record can be assigned to, most records first. */
function AgentChoices({ top, module, ownerField, agent, onAgent }: {
  top: number; module: string; ownerField: string; agent: string | null; onAgent: (id: string | null) => void;
}): JSX.Element {
  const { data: rawUsers = [], isLoading } = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.users(false, false, true),
    staleTime: 5 * 60_000,
  });
  const { counts, loading } = useFacetCounts(module, ownerField);
  const users = rawUsers
    .map((user) => ({ value: String(user.id ?? ''), label: String(user.fullName ?? ''), count: loading ? undefined : counts.get(String(user.id ?? '')) ?? 0 }))
    .filter((user) => user.value && user.label)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  return <ChoiceList options={users} ticked={agent ? [agent] : []} top={top} loading={isLoading} onTick={(id) => onAgent(agent === id ? null : id)} />;
}

const NEVER_CALLED = '__never__';

function CallsSection({ section, title, top, module, disposition, onDisposition }: {
  section: QuickFilterSection; title: string; top: number; module: string; disposition: DispositionPick; onDisposition: (value: DispositionPick) => void;
}): JSX.Element {
  const ticked = disposition.never ? [NEVER_CALLED] : disposition.outcomes;
  return (
    <FoldingState section={section} title={title} icon={<PhoneOutgoing className="h-3.5 w-3.5" />} active={ticked.length}>
      <CallsChoices top={top} module={module} disposition={disposition} onDisposition={onDisposition} />
    </FoldingState>
  );
}

/** How each record's last call went — the same `last_call_disposition` the filter asks. */
function CallsChoices({ top, module, disposition, onDisposition }: {
  top: number; module: string; disposition: DispositionPick; onDisposition: (value: DispositionPick) => void;
}): JSX.Element {
  const outcomes = useCallDispositionOptions();
  const { counts, blank, loading } = useFacetCounts(module, 'last_call_disposition');
  const options: Option[] = [
    { value: NEVER_CALLED, label: 'Never called', count: loading ? undefined : blank ?? 0 },
    ...outcomes.map((outcome) => ({ value: outcome.value, label: outcome.label, count: loading ? undefined : counts.get(outcome.value) ?? 0 })),
  ];
  const ticked = disposition.never ? [NEVER_CALLED] : disposition.outcomes;
  const tick = (value: string): void => {
    if (value === NEVER_CALLED) {
      onDisposition({ outcomes: [], never: !disposition.never });
      return;
    }
    const chosen = disposition.outcomes.includes(value)
      ? disposition.outcomes.filter((item) => item !== value)
      : [...disposition.outcomes, value];
    onDisposition({ never: false, outcomes: chosen });
  };
  return <ChoiceList options={options} ticked={ticked} top={top} onTick={tick} />;
}

/**
 * A field's values, most used first.
 *
 * A dropdown knows its own options, so those are the list and the counts only
 * order it; the search then looks through every one of them. The counts are
 * fetched when the section is first opened, never for a folded heading.
 */
function ValuesSection({ section, title, module, field, top, props }: {
  section: QuickFilterSection; title: string; module: string; field: FieldMeta; top: number; props: QuickFilterPanelProps;
}): JSX.Element {
  const pick = props.picks[field.name];
  const ticked = pick?.kind === 'values' ? pick.values : [];
  const [open, setOpen] = useState(Boolean(section.open) || ticked.length > 0);
  const { counts, blank, loading: isLoading } = useFacetCounts(module, open ? field.name : undefined);
  const options: Option[] = (field.options ?? [])
    .filter((option) => option.isActive !== false)
    .map((option) => ({ value: option.value, label: option.label || option.value, color: option.color, count: counts.get(option.value) ?? 0 }))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  /*
    **The records nobody filled in**, last in the list and counted like the
    rest — the owner, 3 October 2026. The server has always answered `blank`
    beside the values; nothing had ever offered it as a choice, so the one
    question a manager actually asks of a half-filled form — *who has not done
    this* — could not be asked at all.

    Offered only when there is something to find: a row reading "Not filled 0"
    on every field is the kind of noise that teaches people to skip the panel.
    It stays offered while it is ticked, or un-ticking it would mean reopening
    the whole panel.
  */
  const notFilled = { value: EMPTY_PICK, label: 'Unfilled', count: isLoading ? undefined : blank ?? 0 };
  const tick = (value: string): void => {
    const next = ticked.includes(value) ? ticked.filter((item) => item !== value) : [...ticked, value];
    props.onPick(field.name, next.length ? { kind: 'values', values: next } : null);
  };
  return (
    <Folding icon={<ListFilter className="h-3.5 w-3.5" />} title={title} active={ticked.length} open={open} onToggle={() => setOpen((value) => !value)}>
      <ChoiceList options={options} ticked={ticked} top={top} loading={isLoading && open} onTick={tick} always={notFilled} />
    </Folding>
  );
}

/* ------------------------------------------------------------------------ */
/* Tags                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * The module's own tags, ticked as many as you like.
 *
 * **3 October 2026, the owner:** *"need Tag Filter in quick Filter."* The cards
 * on the top bar show the three most-used and choose one; this is the whole
 * list, and more than one at a time.
 *
 * Two things it does not do, both deliberate. It does not name a tag — the list
 * is whatever `GET /api/tags?module=` answers, which is already narrowed to the
 * tags this module is offered. And the count is that endpoint's own
 * `usage_count`, the same number the cards and the list picker print, rather
 * than a second count of its own that could disagree with them.
 */
function TagsSection({ section, title, top, module, props }: {
  section: QuickFilterSection; title: string; top: number; module: string; props: QuickFilterPanelProps;
}): JSX.Element {
  const pick = props.picks[TAGS_KEY];
  const ticked = pick?.kind === 'values' ? pick.values : [];
  const [open, setOpen] = useState(Boolean(section.open) || ticked.length > 0);
  const { data: tags, isLoading } = useQuery({
    queryKey: ['tags', module],
    queryFn: () => api.tags(module),
    enabled: open,
    staleTime: 60_000,
  });
  const options: Option[] = (tags ?? [])
    .map((tag) => ({ value: tag.name, label: tag.name, color: tag.color, count: tag.usage_count }))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const tick = (value: string): void => {
    const next = ticked.includes(value) ? ticked.filter((item) => item !== value) : [...ticked, value];
    props.onPick(TAGS_KEY, next.length ? { kind: 'values', values: next } : null);
  };
  return (
    <Folding icon={<Tag className="h-3.5 w-3.5" />} title={title} active={ticked.length} open={open} onToggle={() => setOpen((value) => !value)}>
      {/* Named so a spec can address "the tag choices" rather than "the second
          button in the panel", which is what it had to guess at first. */}
      <span data-testid="quick-filter-tags">
        <ChoiceList options={options} ticked={ticked} top={top} loading={isLoading && open} onTick={tick} />
      </span>
    </Folding>
  );
}

/* ------------------------------------------------------------------------ */
/* Money and sizes: a min–max slider                                         */
/* ------------------------------------------------------------------------ */

function RangeSection({ section, title, module, field, props }: {
  section: QuickFilterSection; title: string; module: string; field: FieldMeta; props: QuickFilterPanelProps;
}): JSX.Element {
  const pick = props.picks[field.name];
  const chosen = pick?.kind === 'range' ? pick : undefined;
  const [open, setOpen] = useState(Boolean(section.open) || pickIsActive(pick));
  const { data, isLoading } = useQuery({
    queryKey: ['facet-range', module, field.name],
    queryFn: () => api.facetRange(module, field.name),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const spread = data && data.min != null && data.max != null && data.min < data.max;
  return (
    <Folding icon={<Hash className="h-3.5 w-3.5" />} title={title} active={pickIsActive(pick) ? 1 : 0} open={open} onToggle={() => setOpen((value) => !value)}>
      {isLoading && <p className="px-4 py-1 text-[11px] text-muted">Loading…</p>}
      {data && !spread && <p className="px-4 py-1 text-[11px] text-muted">No spread of values to slide between yet.</p>}
      {data && spread && (
        <RangeSlider
          low={data.min!}
          high={data.max!}
          money={field.uitype === 'currency'}
          min={chosen?.min}
          max={chosen?.max}
          onChange={(min, max) => props.onPick(field.name, min == null && max == null ? null : { kind: 'range', min, max })}
        />
      )}
    </Folding>
  );
}

const THUMB = 'pointer-events-none absolute inset-x-0 top-1/2 h-1 w-full -translate-y-1/2 appearance-none bg-transparent '
  + '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-brand-600 [&::-webkit-slider-thumb]:shadow '
  + '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-brand-600';

/**
 * Two thumbs on one track, and two boxes to type into beneath them.
 *
 * The list is asked again only when a thumb is let go, not on every pixel of a
 * drag — each step would be a query. The boxes are the owner's ask of
 * 3 October 2026 (*"input capability along with slider … both slider thing is
 * functional plus this inputting number"*): a box commits on Enter or when it
 * loses focus, reads "1.45 cr" and "45 lakh" (`parseTypedAmount`), and may go
 * past either end of the slider — a buyer's budget is not limited to the
 * prices already in the list. Slider and boxes are one pick; moving either
 * moves the other.
 */
export function RangeSlider({ low, high, money, min, max, onChange }: {
  low: number; high: number; money: boolean; min?: number; max?: number;
  onChange: (min: number | undefined, max: number | undefined) => void;
}): JSX.Element {
  const step = sliderStep(low, high);
  const clamp = (value: number): number => Math.min(high, Math.max(low, value));
  const [from, setFrom] = useState(clamp(min ?? low));
  const [to, setTo] = useState(clamp(max ?? high));
  const [minText, setMinText] = useState(min != null ? String(min) : '');
  const [maxText, setMaxText] = useState(max != null ? String(max) : '');
  useEffect(() => {
    setFrom(clamp(min ?? low)); setTo(clamp(max ?? high));
    setMinText(min != null ? String(min) : ''); setMaxText(max != null ? String(max) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, low, high]);
  const show = (value: number): string => (money ? formatIndianPrice(value) : value.toLocaleString('en-IN'));
  const commit = (): void => onChange(from > low ? from : undefined, to < high ? to : undefined);
  const commitTyped = (): void => {
    let typedMin = parseTypedAmount(minText);
    let typedMax = parseTypedAmount(maxText);
    if (typedMin != null && typedMax != null && typedMin > typedMax) [typedMin, typedMax] = [typedMax, typedMin];
    if (typedMin === min && typedMax === max) return;
    onChange(typedMin, typedMax);
  };
  const percent = (value: number): number => ((value - low) / (high - low)) * 100;
  const typedHint = (text: string): string | null => {
    const value = parseTypedAmount(text);
    if (!text.trim()) return null;
    return value == null ? 'Not a number' : show(value);
  };
  const box = (label: string, text: string, setText: (value: string) => void, placeholder: string): JSX.Element => (
    <label className="min-w-0 flex-1">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        aria-label={`${label} ${money ? 'amount' : 'size'}`}
        onChange={(event) => setText(event.target.value)}
        onBlur={commitTyped}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTyped(); } }}
        className="input mt-0.5 h-7 w-full px-2 py-0 text-[11px] tabular-nums"
      />
      <span className="mt-0.5 block h-3.5 truncate text-[10px] text-muted">{typedHint(text)}</span>
    </label>
  );
  return (
    <div className="px-4 pb-1 pt-2" data-testid="range-slider">
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-slate-200 dark:bg-slate-700" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-brand-600" style={{ left: `${percent(from)}%`, right: `${100 - percent(to)}%` }} />
        <input
          type="range" min={low} max={high} step={step} value={from}
          aria-label="Lowest"
          className={THUMB}
          onChange={(event) => { const value = Math.min(Number(event.target.value), to); setFrom(value); setMinText(value > low ? String(value) : ''); }}
          onPointerUp={commit}
          onKeyUp={commit}
        />
        <input
          type="range" min={low} max={high} step={step} value={to}
          aria-label="Highest"
          className={THUMB}
          onChange={(event) => { const value = Math.max(Number(event.target.value), from); setTo(value); setMaxText(value < high ? String(value) : ''); }}
          onPointerUp={commit}
          onKeyUp={commit}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] font-semibold tabular-nums text-slate-700 dark:text-slate-200">
        <span>{show(from)}</span>
        <span className="text-muted">to</span>
        <span>{show(to)}</span>
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        {box('Min', minText, setMinText, money ? 'e.g. 50 lakh' : show(low))}
        <span className="mt-5 text-[11px] text-muted">–</span>
        {box('Max', maxText, setMaxText, money ? 'e.g. 1.5 cr' : show(high))}
      </div>
      {(min != null || max != null) && (
        <button type="button" onClick={() => { setFrom(low); setTo(high); setMinText(''); setMaxText(''); onChange(undefined, undefined); }} className="mt-1 text-[10px] font-semibold text-brand-700 hover:underline dark:text-brand-300">
          Any {money ? 'amount' : 'size'}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Dates: presets and a day on the calendar                                  */
/* ------------------------------------------------------------------------ */

function PresetChips<T extends string>({ choices, active, onPick, counts = {} }: {
  choices: Array<[T, string]>; active: T | undefined; onPick: (value: T | undefined) => void;
  /** How many records each chip would show; absent while counting. */
  counts?: Partial<Record<T, number>>;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5 px-4 pt-1">
      {choices.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={active === value}
          onClick={() => onPick(active === value ? undefined : value)}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors',
            active === value
              ? 'border-brand-600 bg-brand-600 text-white'
              : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-brand-300 hover:bg-brand-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
          )}
        >
          {label}
          {counts[value] !== undefined && (
            <span className={cn('ml-1 tabular-nums', active === value ? 'text-white/85' : 'font-normal text-muted')}>{counts[value]!.toLocaleString('en-IN')}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function DayPicker({ value, onChange }: { value: string | undefined; onChange: (day: string | undefined) => void }): JSX.Element {
  return (
    <label className="mx-4 mt-2 flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
      <CalendarDays className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      <span className="shrink-0">On</span>
      <input
        type="date"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="input h-7 min-w-0 flex-1 py-0 text-[11px]"
        aria-label="Pick a date"
      />
    </label>
  );
}

/** The date presets, each with how many records it would show. */
function DatePresetChips({ module, fieldName, active, onPick }: {
  module: ModuleMeta; fieldName: string; active: DatePreset | undefined; onPick: (preset: DatePreset | undefined) => void;
}): JSX.Element {
  const fields = useMemo(() => new Map(module.fields.map((field) => [field.name, field])), [module.fields]);
  const filters = DATE_PRESETS.map(([preset]): [DatePreset, FilterGroup] => [preset, {
    logic: 'AND',
    conditions: quickPickConditions({ [fieldName]: { kind: 'date', preset } }, fields),
  }]);
  const counts = useChipCounts(module.name, filters);
  return <PresetChips<DatePreset> choices={DATE_PRESETS} active={active} onPick={onPick} counts={counts} />;
}

/** The chase queues, each with how many records wait in it. */
function TaskPresetChips({ module, fieldName, active, onPick }: {
  module: string; fieldName: string; active: TaskQueue | undefined; onPick: (queue: TaskQueue | undefined) => void;
}): JSX.Element {
  const queues = followUpFilters(fieldName);
  const counts = useChipCounts(module, TASK_CHOICES.map(([queue]): [TaskQueue, FilterGroup] => [queue, queues[queue]]));
  return <PresetChips<TaskQueue> choices={TASK_CHOICES} active={active} onPick={onPick} counts={counts} />;
}

function DateSection({ section, title, fieldName, props }: {
  section: QuickFilterSection; title: string; fieldName: string; props: QuickFilterPanelProps;
}): JSX.Element {
  const pick = props.picks[fieldName];
  const chosen = pick?.kind === 'date' ? pick : undefined;
  return (
    <FoldingState section={section} title={title} icon={<CalendarDays className="h-3.5 w-3.5" />} active={pickIsActive(pick) ? 1 : 0}>
      <DatePresetChips
        module={props.module}
        fieldName={fieldName}
        active={chosen?.preset}
        onPick={(preset) => props.onPick(fieldName, preset ? { kind: 'date', preset } : null)}
      />
      <DayPicker value={chosen?.on} onChange={(on) => props.onPick(fieldName, on ? { kind: 'date', on } : null)} />
    </FoldingState>
  );
}

/**
 * When the chase is due. The four queues are the Task button's own, so the
 * button and this section can never disagree; a picked day narrows to the
 * chase date itself, and choosing one clears the other.
 */
function TaskSection({ section, title, props, field }: {
  section: QuickFilterSection; title: string; props: QuickFilterPanelProps; field: FieldMeta;
}): JSX.Element {
  const pick = props.picks[field.name];
  const on = pick?.kind === 'date' ? pick.on : undefined;
  return (
    <FoldingState section={section} title={title} icon={<Clock3 className="h-3.5 w-3.5" />} active={props.task || on ? 1 : 0}>
      <TaskPresetChips
        module={props.module.name}
        fieldName={field.name}
        active={props.task ?? undefined}
        onPick={(queue) => { props.onPick(field.name, null); props.onTask(queue ?? null); }}
      />
      <DayPicker value={on} onChange={(day) => { props.onTask(null); props.onPick(field.name, day ? { kind: 'date', on: day } : null); }} />
    </FoldingState>
  );
}
