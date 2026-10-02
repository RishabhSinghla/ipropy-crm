import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CustomView, type FieldMeta, type FilterGroup, type ListQuery } from '@ipropy/shared';
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsLeft, ChevronsRight, Compass, Download, Filter,
  Pencil, PhoneForwarded, Plus, RefreshCw, Save, Search, Settings2, Tag, Trash2, Upload, X,
} from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { invalidateRecordQueries } from '../lib/invalidate';
import { saveListNav } from '../lib/listNav';
import { cn } from '../lib/utils';
import { FieldInput } from '../components/FieldRenderer';
import { assignmentField, byLabel, followUpFieldOf, pipelineFieldOf, withQueueSubtitle } from '../lib/fields';
import { withQueueCardColumns } from '../lib/queueCard';
import { DEFAULT_PAGE_SIZE, loadPageSize, PAGE_SIZE_OPTIONS, savePageSize } from '../lib/pageSize';
import { countConditions } from '../components/FilterBuilder';
import {
  ConfirmDialog, Dropdown, DropdownItem, EmptyState, Modal, Select, Skeleton, Spinner,
} from '../components/ui';
import { ModuleIcon } from '../components/Layout';
import RecordForm from '../components/RecordForm';
import { ListPicker } from '../components/ListPicker';
import { FollowUpQueue, followUpFilters, type TaskQueue } from '../components/FollowUpQueue';
import { StatusBreakdown } from '../components/StatusBreakdown';
import {
  LAST_CALL_DISPOSITION, NO_DISPOSITION_PICK, type DispositionPick,
} from '../components/CallDispositionFilter';
import { HotTagChip } from '../components/HotTagChip';
import { filterIcon, toolbarButton, toolbarCount } from '../lib/toolbarButton';
import SiteCapture from './SiteCapture';
import { useOfflineMeta } from '../lib/useOfflineList';
import { deliverFile } from '../lib/nativeActions';
import { blankView, type SavedView, ViewEditor } from '../components/ViewEditor';
import { IpropyWorkspace } from '../components/IpropyWorkspace';
import { QuickFilterOverlay } from '../components/QuickFilterOverlay';
import {
  arrangeQuickSections, countActiveQuickFilters, defaultQuickSections, quickPickConditions,
  type QuickPick, type QuickPicks,
} from '../lib/quickFilters';
import { callQueueUrl } from '../lib/callQueueUrl';
import { useProgressiveDialer } from '../lib/progressiveDialer';

const EMPTY_FILTER: FilterGroup = { logic: 'AND', conditions: [] };
export default function ListView(): JSX.Element {
  const { module: moduleName } = useParams<{ module: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useApp();


  const [page, setPage] = useState(1);
  /** Which pane the split view is showing on a phone — see `onShowing`. */
  const [paneShowing, setPaneShowing] = useState<'list' | 'record'>('list');
  // Keep the page editor separate from the committed page. A controlled
  // number input bound straight to `page` immediately rejected its empty
  // intermediate state, so replacing "1" with "9" required selecting the
  // old digit first. People should be able to type a destination naturally.
  const [pageInput, setPageInput] = useState('1');
  // A link's own page size wins for the visit it opens; otherwise the size
  // this user last chose for this module.
  const [pageSize, setPageSizeState] = useState(
    () => Number(searchParams.get('pageSize')) || loadPageSize(moduleName),
  );
  const setPageSize = (size: number): void => {
    setPageSizeState(size);
    savePageSize(moduleName, size);
    setPage(1);
  };
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [taskQueue, setTaskQueue] = useState<TaskQueue | null>(null);
  const [stagePick, setStagePick] = useState<string[]>([]);
  const [agentPick, setAgentPick] = useState<string | null>(null);
  const [tagPick, setTagPick] = useState<string | null>(null);
  const [dispositionPick, setDispositionPick] = useState<DispositionPick>(NO_DISPOSITION_PICK);
  /*
    What is chosen in the Quick & Live Filters panel's field sections — a
    field's values, a slider's ends, a date. It lives here and not in the panel
    because it has to reach the *server* with the rest of the query: a filter
    applied to the rows already on screen would narrow the queue and leave the
    count beside it describing the whole list.
  */
  const [picks, setPicks] = useState<QuickPicks>({});
  const [viewId, setViewId] = useState<string | undefined>(searchParams.get('view') ?? undefined);
  const [filter, setFilter] = useState<FilterGroup>(EMPTY_FILTER);
  const [sortBy, setSortBy] = useState<string | undefined>();
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Gmail's "select all X in this search": when true, bulk actions run against
  // every record the current view/filter matches, not just this page's ids.
  const [selectedAll, setSelectedAll] = useState(false);
  const [columns, setColumns] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [showCapture, setShowCapture] = useState(false);
  /** Open when somebody is naming a new view built from what is on screen. */
  const [savingAsView, setSavingAsView] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingView, setEditingView] = useState<SavedView | null>(null);
  const [confirmDeleteView, setConfirmDeleteView] = useState<CustomView | null>(null);

  /**
   * Which view the sort/columns effect below has already applied, and whether
   * the URL we arrived on named a sort of its own.
   *
   * Both exist to settle the same argument. Two things want to decide the sort
   * order — the saved view's default, and whatever the user last clicked — and
   * the view was winning every time, because its query resolves *after* the
   * URL has been read. That is the bug: sort by Name, open a lead, come back,
   * and the list is silently back on the view's AI Score.
   */
  const adoptedView = useRef<string | null>(null);
  const urlNamedSort = useRef(false);

  /**
   * Which module's query string has been read into state.
   *
   * The two effects below both run in the first flush after mount, in source
   * order, and the second one's closure still holds the *pre-hydration* state.
   * So the list arrived, read its filter and sort out of the URL, and then
   * immediately wrote an empty URL back over them — self-healing only because
   * the state it had just set re-triggered the write. Anything that read the
   * URL in that window (the return link handed to every row) got the blank one.
   */
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  /**
   * Hydrate from the URL on arrival.
   *
   * The list's state lives in the query string, not just in React state, so
   * opening a lead and coming back returns to the same filter, sort, search and
   * page rather than resetting to "All Records". Sorting forty leads by
   * follow-up date, opening the third, and being dumped back at an unsorted
   * page one is the single most irritating thing a CRM can do.
   *
   * Runs on module change only. The sync effect below writes the URL, and if
   * this depended on `searchParams` the two would drive each other in a loop.
   */
  useEffect(() => {
    const raw = searchParams.get('filter');
    let seeded = EMPTY_FILTER;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as FilterGroup;
        if (parsed?.conditions) seeded = parsed;
      } catch {
        // malformed/tampered query param — fall back to no filter rather than crash
      }
    }
    const restoredSearch = searchParams.get('q') ?? '';
    const restoredSort = searchParams.get('sort');
    adoptedView.current = null;
    urlNamedSort.current = Boolean(restoredSort);
    setPage(Number(searchParams.get('page')) || 1);
    // Same precedence as on first mount: the link's size if it names one,
    // otherwise this user's remembered size for the module being opened.
    setPageSizeState(Number(searchParams.get('pageSize')) || loadPageSize(moduleName));
    setSearch(restoredSearch);
    setSearchInput(restoredSearch);
    setFilter(seeded);
    setSelected(new Set());
    setSortBy(restoredSort ?? undefined);
    setSortDir(searchParams.get('dir') === 'asc' ? 'asc' : 'desc');
    setColumns([]);
    setViewId(searchParams.get('view') ?? undefined);
    // A restored filter is already applied — don't pop the panel open on
    // arrival (dashboard drill-through lands on the records, not the builder).
    setShowFilters(false);
    setTaskQueue(taskFromAddress(searchParams.get('task')));
    setHydratedFor(moduleName ?? null);
  }, [moduleName]);

  /*
    The toolbar's Tasks icon links to `?task=today` from anywhere, including
    this list — so the address is read again whenever that one part changes,
    and a link back without it switches the queue off.
  */
  const taskParam = searchParams.get('task');
  useEffect(() => {
    if (hydratedFor !== moduleName) return;
    const wanted = taskFromAddress(taskParam);
    setTaskQueue((current) => (current === wanted ? current : wanted));
    setPage(1);
  }, [taskParam]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  useEffect(() => {
    // Only when the words changed. This used to fire on arrival too, with
    // nothing typed, and put every link to page 2 back on page 1 a third of a
    // second after it opened (the owner's report, 25 September).
    if (searchInput === search) return;
    const timer = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const { data: liveMeta, isLoading: metaLoading, error: metaError, refetch: refetchMeta } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName!),
    enabled: Boolean(moduleName),
    // A module that does not exist is an answer, not a hiccup. Retrying a 404
    // three times only makes the wrong screen take longer to appear.
    retry: false,
  });

  const meta = useOfflineMeta(moduleName, liveMeta, user?.id);

  /**
   * Only a real 404 means the module is gone.
   *
   * An unreachable server also fails this query, and treating the two alike
   * told a rep standing in a basement that Leads had been deleted — which is
   * both alarming and false. A network failure is not an ApiError at all: it
   * is fetch rejecting, so the status check separates them cleanly.
   */
  const metaFailed = metaError instanceof ApiError && metaError.status === 404;

  const { data: views } = useQuery({
    queryKey: ['views', moduleName],
    queryFn: () => api.views(moduleName!, true),
    enabled: Boolean(moduleName),
  });

  /*
    Match on the built-in id as well as the view's own.

    Editing a built-in view gives you your own version of it, with its own id
    (migration 135), and the switcher then sends that id. A link made before
    the edit — a bookmark, a dashboard drill-through, a URL somebody pasted
    into WhatsApp — still names the built-in one, and matching only on `id`
    would silently drop those people onto the default view instead.
  */
  const activeView = views?.find((v) => v.id === viewId || v.builtInId === viewId)
    ?? views?.find((v) => v.isDefault)
    ?? views?.[0];

  const chooseView = (id: string): void => {
    if (id === activeView?.id) return;
    // A saved view owns its filter. Carrying a temporary filter or search to
    // another view makes the selected view look broken and unlike its name.
    setViewId(id);
    setPage(1);
    setFilter(EMPTY_FILTER);
    setSearch('');
    setSearchInput('');
    setSelected(new Set());
  };

  const deleteViewMutation = useMutation({
    mutationFn: (id: string) => api.deleteView(moduleName!, id),
    onSuccess: () => {
      toast.success('Personal view deleted');
      setViewId(undefined);
      setConfirmDeleteView(null);
      void queryClient.invalidateQueries({ queryKey: ['views', moduleName] });
    },
    onError: (error: Error) => toast.error('Could not delete this view', error.message),
  });


  /**
   * Adopt the selected view's columns, sort and display mode.
   *
   * The sort half is conditional, and that condition is the whole fix. This
   * effect cannot run on arrival — the views query resolves after the first
   * paint — so it used to fire once the list was already on screen and
   * overwrite the sort the URL had just restored. It also re-fires when the
   * module metadata lands, which is a second chance to clobber the same value
   * with the same default.
   *
   * So: adopt a view's sort when the user *picks* that view, and never when we
   * are merely arriving at a link that already says how it wants to be sorted.
   */
  useEffect(() => {
    if (!activeView) return;
    /*
      What counts as "the view changed" is its definition, not its id.

      Keying on the id alone meant editing the view you were already on saved
      fine and changed nothing on screen until a reload — the id had not moved,
      so this never re-ran. Keying on the whole definition catches that, and
      still treats a background refetch returning the same values as no change,
      which is what keeps it from re-adopting the sort over one the user just
      set by clicking a column header.
    */
    const signature = [
      activeView.id,
      (activeView.columns ?? []).join(','),
      activeView.sortBy ?? '',
      activeView.sortDir ?? '',
      activeView.displayMode ?? '',
    ].join('|');
    const previous = adoptedView.current;
    adoptedView.current = signature;

    // Outside the guard below: on the first paint the module metadata has not
    // arrived, so a view showing every column resolves to none of them, and
    // this is the render that fixes it.
    setColumns(activeView.columns?.length ? activeView.columns : allColumns(meta));
    // Same view, same definition, later render — metadata arriving is not a
    // view change, and must not overwrite a sort the user chose since.
    if (previous === signature) return;
    // Arriving on a link that names its own sort: the link wins.
    if (previous === null && urlNamedSort.current) return;

    setSortBy(activeView.sortBy ?? undefined);
    setSortDir(activeView.sortDir ?? 'desc');
  }, [
    activeView?.id, meta?.id, activeView?.displayMode,
    (activeView?.columns ?? []).join(','), activeView?.sortBy, activeView?.sortDir,
  ]);

  /**
   * Mirror the current state back into the URL.
   *
   * `replace` rather than push: every keystroke in the search box would
   * otherwise become a history entry, and Back would walk through them one
   * character at a time instead of leaving the list.
   */
  useEffect(() => {
    // Never write the URL from state that has not read it yet.
    if (!moduleName || hydratedFor !== moduleName) return;
    const next = new URLSearchParams();
    if (activeView?.id) next.set('view', activeView.id);
    if (search) next.set('q', search);
    if (sortBy) next.set('sort', sortBy);
    if (sortBy && sortDir !== 'desc') next.set('dir', sortDir);
    if (page > 1) next.set('page', String(page));
    if (pageSize !== DEFAULT_PAGE_SIZE) next.set('pageSize', String(pageSize));
    if (countConditions(filter)) next.set('filter', JSON.stringify(filter));
    // The follow-up queue is in the address so the toolbar's Tasks icon, on
    // any page, can open a list on it — and a refresh keeps it.
    if (taskQueue) next.set('task', taskQueue);
    /*
      **Carried, not rebuilt.** This effect writes the address from the list's
      own state, so anything it does not name is silently dropped — and `open`
      is named by somebody else entirely: global search, a chat, Save & Next.
      Without these two lines a record link landed on the list and then lost
      the record a heartbeat later, which reads exactly like the link being
      ignored.

      **Read from the live address, not from this render's copy.** The call
      provider takes `dial` off once it has rung, and a captured `searchParams`
      from the render before that still holds it — so this effect put the flag
      straight back, and a refresh would ring somebody who had just been
      called. `window.location.search` is what is true now.
    */
    const carried = new URLSearchParams(window.location.search);
    const open = carried.get('open');
    if (open) next.set('open', open);
    const dial = carried.get('dial');
    if (dial) next.set('dial', dial);

    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [moduleName, hydratedFor, activeView?.id, search, sortBy, sortDir, page, pageSize, filter, taskQueue, searchParams]);

  /**
   * Owner defaults to whoever is adding the record. Status and stage come from
   * their picklist defaults, which the server also applies — set here so the
   * form shows them rather than revealing them after the save.
   */
  const quickCreateDefaults = useMemo(
    () => (user ? { owner_id: user.id } : {}),
    [user?.id],
  );

  /*
    The module's pipeline field, resolved by name *or* column.

    A rename changes a field's name and leaves its column alone, while
    `pipeline_field` keeps the old name — and on production that has already
    happened: leads says `status` and the field has been `lead_status` for
    some time. Matching on the name alone is why the kanban groups by nothing
    and the stage breakdown does not appear, both without an error, because
    the column is still there and nothing asks for it.
  */
  const stageField = meta ? pipelineFieldOf(meta) : undefined;
  const ownerField = meta ? assignmentField(meta.fields) : undefined;

  // Next Follow-up is the CRM's task field. These are deliberately not saved
  // views: every person gets the same obvious work queues without an admin
  // having to create or maintain three more views for each module.
  // Older Inventory workspaces store the same business field as
  // `next_follow_up` in JSON — `followUpFieldOf` knows both.
  const taskField = meta ? followUpFieldOf(meta.fields) : undefined;
  /*
    The field decides, never a list of module names.

    This read `moduleName === 'leads' || moduleName === 'properties'`, so the
    Follow-ups button vanished the day a third module arrived — Associates
    carries `next_followup_at` and still had no way to work its chase list
    (28 September 2026, the owner: *"there are Followup Filter Button are
    missing"*). A module either has somewhere to put a chase date or it does
    not, and that is a fact about its metadata.
  */
  const taskQueuesEnabled = Boolean(taskField);
  const taskFilters = useMemo(
    () => followUpFilters(taskField?.name ?? 'next_follow_up'),
    [taskField?.name],
  );
  const fieldsByName = useMemo(() => new Map((meta?.fields ?? []).map((field) => [field.name, field])), [meta?.fields]);
  /* The panel's sections: the admin's arrangement laid over what this module has. */
  const quickSections = useMemo(
    () => (meta
      ? arrangeQuickSections(user?.ui?.quickFilters?.[meta.name], defaultQuickSections(meta.fields, { ownerField, stageField, taskField }))
      : []),
    [meta, user?.ui?.quickFilters, ownerField, stageField, taskField],
  );

  const effectiveFilter = useMemo<FilterGroup>(() => {
    const extra = [
      ...(taskQueue ? taskFilters[taskQueue].conditions : []),
      // `in` rather than one condition per stage: the breakdown is a single
      // question — which of these stages — and an AND of equals matches nothing.
      ...(stagePick.length && stageField
        ? [{ field: stageField.name, operator: 'in' as const, value: stagePick }]
        : []),
      ...(agentPick && ownerField
        ? [{ field: ownerField.name, operator: 'equals' as const, value: agentPick }]
        : []),
      // `record_tags` is the builder's own name for the tags on a record; a tag
      // is not a field on the module, so it cannot be resolved as one.
      ...(tagPick ? [{ field: 'record_tags', operator: 'has_any' as const, value: [tagPick] }] : []),
      ...quickPickConditions(picks, fieldsByName),
      /*
        How the last call went. `last_call_disposition` is a system field in the
        query builder, not a column on either module — a disposition lives on
        `ipy_call`. "Never called" is the absence of one, so it is `is_empty`
        rather than a value in the list.
      */
      ...(dispositionPick.never
        ? [{ field: LAST_CALL_DISPOSITION, operator: 'is_empty' as const }]
        : dispositionPick.outcomes.length
          ? [{ field: LAST_CALL_DISPOSITION, operator: 'in' as const, value: dispositionPick.outcomes }]
          : []),
    ];
    if (!extra.length) return filter;
    return { logic: 'AND', conditions: [...filter.conditions, ...extra] };
  }, [filter, taskFilters, taskQueue, stagePick, stageField?.name, agentPick, ownerField?.name, tagPick, picks, fieldsByName, dispositionPick]);

  /*
    What the breakdown counts is the view and the ad-hoc filter, but never the
    stage choice itself — a bar that shrank to 100% of itself the moment it was
    clicked would make the shape of the pipeline unreadable from inside it.
  */
  const breakdownFilter = useMemo<FilterGroup | undefined>(() => {
    const conditions = [
      ...filter.conditions,
      ...(taskQueue ? taskFilters[taskQueue].conditions : []),
      // The agent *is* included: picking somebody should reshape the bars to
      // their pipeline, which is the question "how is Shikha doing" and the
      // reason the chips sit inside this panel rather than beside it.
      ...(agentPick && ownerField
        ? [{ field: ownerField.name, operator: 'equals' as const, value: agentPick }]
        : []),
    ];
    return conditions.length ? { logic: 'AND', conditions } : undefined;
  }, [filter, taskFilters, taskQueue, agentPick, ownerField?.name]);

  /*
    A queue is a decision about *when* something is due, so it has to be
    ordered by that date. Filtering alone left page 1 of "Overdue" in whatever
    order the list already had — with 22,983 leads that is not the ones most
    overdue, it is an arbitrary hundred of them. Oldest date first, so the
    longest-neglected person is the first row.

    Only when nobody has chosen a sort. An explicit column sort, or one saved
    into the view, still wins — the queue supplies a default, it does not
    take the control away.
  */
  const effectiveSort = useMemo(() => (
    taskQueue && !sortBy && taskField
      ? { sortBy: taskField.name, sortDir: 'asc' as const }
      : { sortBy, sortDir }
  ), [taskQueue, sortBy, sortDir, taskField?.name]);

  const query: ListQuery = useMemo(() => ({
    view: activeView?.id,
    page,
    pageSize,
    search: search || undefined,
    filter: countConditions(effectiveFilter) ? effectiveFilter : undefined,
    sortBy: effectiveSort.sortBy,
    sortDir: effectiveSort.sortDir,
    /*
      Exactly what the split view's queue reads, and nothing else — the open
      record's pane fetches the whole record by id. A list row carries only the
      values the list asked for, so naming these here is what keeps the card's
      lines from reading blank.
    */
    columns: withQueueCardColumns(
      withQueueSubtitle(meta ? [...meta.labelFields] : undefined, meta),
      meta?.fields,
      (meta?.layouts?.find((layout) => layout.type === 'detail' && layout.is_default)?.config as { queueFields?: string[] } | undefined)?.queueFields,
    ),
  }), [activeView?.id, page, pageSize, search, effectiveSort, effectiveFilter, meta]);

  // The call deck must resume this *exact* queue after Save & Next. The URL's
  // ordinary filter omits transient follow-up/status/agent/tag choices, and a
  // follow-up queue can supply its own sort even when no sort is named in the
  // URL. Capture the effective list query, not just the address bar.
  const callQueueSnapshot = useMemo(() => callQueueUrl(moduleName ?? '', query), [moduleName, query]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['records', moduleName, query],
    queryFn: () => api.list(moduleName!, query),
    enabled: Boolean(moduleName && meta),
    /*
      Keep the last page on screen while the next one loads — but only within
      one module. Across a switch the "last page" is the other module's rows,
      and the split view would open a contact as if it were a unit (a 404 on
      every switch between Contacts and Inventories).
    */
    placeholderData: (prev, previousQuery) => (previousQuery?.queryKey[1] === moduleName ? prev : undefined),
  });

  /*
    Left and right arrows turn the page.

    **29 September 2026, the owner:** *"Arrow Key doesn't Work for Next record
    or Back Record"*, then, correcting himself: *"Sorry its arrow key from
    laptop for next page and back page."* So this is the pager at the top
    right — the ‹ 1 / 10 › — which until now could only be clicked. It works on
    every module, because every module's list is this component.

    **Left and right, never up and down.** Up and down scroll a page, and a rep
    reading down a long form would be thrown onto another page mid-sentence.
    Left and right mean nothing on a vertical page, so taking them costs
    nothing.

    Three things it must never do, and each has a real caller behind it: fire
    while somebody is typing (every box on this screen), fire while a dialog or
    a dropdown has the screen, and eat ⌘← which is the browser's own Back. The
    split view's divider is a `separator` that takes arrows itself while it has
    focus, so it stands down for that too.
  */
  const lastPage = data?.totalPages ?? 1;
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

      const where = event.target as HTMLElement | null;
      const tag = where?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (where?.isContentEditable) return;
      if (where?.closest('[role="dialog"], [role="listbox"], [role="menu"], [role="separator"]')) return;

      const back = event.key === 'ArrowLeft';
      if (back ? page <= 1 : page >= lastPage) return;
      event.preventDefault();
      setPage((current) => (back ? Math.max(1, current - 1) : Math.min(lastPage, current + 1)));
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [page, lastPage]);

  const commitPageInput = (): void => {
    const next = Number(pageInput);
    if (Number.isInteger(next) && next >= 1 && next <= (data?.totalPages ?? 1)) {
      setPage(next);
    } else {
      setPageInput(String(page));
    }
  };



  /*
    The list is what the server says it is, and nothing else.

    There used to be a read-only fallback here: on a failed request the list
    rendered the last copy held in IndexedDB behind an amber "Can't reach the
    CRM — this is what was here at 09:14" banner. The owner asked for it gone,
    and he is right about the trade. It fired on the first failed attempt — one
    blip on a lift ride, one slow response — so the desk saw it constantly while
    the CRM was in fact up, and a warning that is usually wrong is a warning
    people stop reading. The danger of keeping the banner but not the caching
    was worse still: yesterday's pipeline shown as today's.

    So both halves go together. A request that fails now shows the ordinary
    empty state and retries, which is the honest answer — nothing is being
    passed off as current. `offlineCache` itself stays: site capture still
    depends on it out on a site with no signal.
  */
  const rows = data?.rows ?? [];

  /**
   * A progressive session is deliberately built from explicit ticks, in the
   * same order the rep sees them. "Select all 22,000" is useful for exports,
   * but it is not a safe phone queue: a human must choose the calls they are
   * about to make and confirm each one before Android receives it.
   */
  const startProgressiveDialer = (): void => {
    if (!user?.id || !moduleName || !meta) return;
    if (selectedAll) {
      toast.error('Choose a smaller calling queue', 'Untick Select all, then tick the records you want to call in this session.');
      return;
    }
    const phoneField = meta.fields.find((field) => field.uitype === 'phone');
    if (!phoneField) {
      toast.error('This module has no phone field');
      return;
    }
    const chosen = rows.flatMap((row) => {
      if (!selected.has(row.id)) return [];
      const number = row.display?.[phoneField.name] ?? row.values[phoneField.name];
      return number ? [{ id: row.id, label: row.label, number: String(number) }] : [];
    });
    if (!chosen.length) {
      toast.error('No callable records selected', 'Select records that have a mobile number.');
      return;
    }
    const missing = selected.size - chosen.length;
    useProgressiveDialer.getState().start({
      userId: user.id,
      module: moduleName,
      items: chosen,
      sourceUrl: callQueueSnapshot,
    });
    const next = new URLSearchParams(searchParams);
    next.set('open', chosen[0]!.id);
    next.delete('dial');
    setSearchParams(next);
    setSelected(new Set());
    setSelectedAll(false);
    toast.success(
      `Progressive queue ready · ${chosen.length}`,
      missing ? `${missing} record${missing === 1 ? '' : 's'} without a phone number were skipped.` : 'Confirm Call current before every call.',
    );
  };

  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) => api.massDelete(moduleName!, ids),
    onSuccess: (result) => {
      toast.success(`${result.deleted} record${result.deleted === 1 ? '' : 's'} deleted`);
      setSelected(new Set());
      invalidateRecordQueries(queryClient, moduleName);
    },
    onError: (err: Error) => toast.error('Delete failed', err.message),
  });

  /**
   * Make the arrangement on screen the view's own.
   *
   * Choosing columns, sorting and filtering were all local state: perfect until
   * you reloaded, at which point the list went back to whatever the view was
   * seeded with and the work had to be redone. Saving writes them onto the
   * view, so the tab opens that way for good — and for everyone, if the view is
   * shared. The one thing a rep can arrange about their day's list should not
   * need a developer.
   */
  const saveViewMutation = useMutation({
    mutationFn: () => api.updateView(moduleName!, activeView!.id, {
      columns: columns.length ? columns : defaultColumns(meta),
      sortBy: sortBy ?? null,
      sortDir,
      displayMode: 'ipropy',
      filter: countConditions(filter) ? filter : { logic: 'AND', conditions: [] },
    }),
    onSuccess: () => {
      toast.success(`Saved to “${activeView?.name}”`, 'This tab will open this way from now on.');
      void queryClient.invalidateQueries({ queryKey: ['views', moduleName] });
    },
    onError: (err: Error) => toast.error('Could not save this view', err.message),
  });

  /*
    The screen as it stands, kept under a new name.

    Everything is taken from live state rather than from `activeView`, because
    the whole point is the arrangement somebody has just made — the columns they
    dragged, the filter they built, the column they sorted by. It starts private
    (`isPublic: false`, nobody shared) exactly like a view made from scratch;
    sharing it is a separate, deliberate act in the editor.
  */
  /*
    The three actions the list picker offers beyond choosing one.

    Duplicate copies the whole shape rather than the name — a copy that opened
    on different columns would be a different list wearing the same name. It
    starts private, like anything made from scratch, because a copy of a shared
    list is not automatically the team's.
  */
  const duplicateView = useMutation({
    mutationFn: async (id: string) => {
      const source = (views ?? []).find((v) => v.id === id);
      if (!source) throw new Error('That list is no longer here.');
      return api.createView(moduleName!, {
        name: `${source.name} copy`,
        columns: source.columns ?? [],
        sortBy: source.sortBy ?? null,
        sortDir: source.sortDir ?? 'desc',
        displayMode: 'ipropy',
        groupBy: source.groupBy ?? null,
        filter: source.filter ?? { logic: 'AND', conditions: [] },
        isPublic: false,
        sharedWith: [],
      });
    },
    onSuccess: (created) => {
      toast.success('List copied', 'It is yours until you share it.');
      void queryClient.invalidateQueries({ queryKey: ['views', moduleName] }).then(() => {
        if (created?.id) setViewId(created.id);
      });
    },
    onError: (err: Error) => toast.error('Could not copy this list', err.message),
  });

  /** Sharing a list in this CRM means making it public to the team. */
  const shareView = useMutation({
    mutationFn: async (id: string) => {
      const source = (views ?? []).find((v) => v.id === id);
      if (!source) throw new Error('That list is no longer here.');
      return api.updateView(moduleName!, id, { isPublic: !source.isPublic });
    },
    onSuccess: (_result, id) => {
      const source = (views ?? []).find((v) => v.id === id);
      toast.success(source?.isPublic ? 'List is private again' : 'List shared with the team');
      void queryClient.invalidateQueries({ queryKey: ['views', moduleName] });
    },
    onError: (err: Error) => toast.error('Could not change who can see this list', err.message),
  });

  const setDefaultView = useMutation({
    mutationFn: async (id: string) => {
      const source = (views ?? []).find((v) => v.id === id);
      return api.updateView(moduleName!, id, { isDefault: !source?.isDefault });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['views', moduleName] }); },
    onError: (err: Error) => toast.error('Could not set the default list', err.message),
  });

  const saveAsNewView = useMutation({
    mutationFn: (name: string) => api.createView(moduleName!, {
      name,
      columns: columns.length ? columns : [],
      sortBy: sortBy ?? null,
      sortDir,
      displayMode: 'ipropy',
      filter: countConditions(filter) ? filter : { logic: 'AND', conditions: [] },
      isPublic: false,
      sharedWith: [],
    }),
    onSuccess: (created) => {
      toast.success('View saved', 'It is yours until you share it.');
      setSavingAsView(false);
      void queryClient.invalidateQueries({ queryKey: ['views', moduleName] }).then(() => {
        // Land on the thing that was just made, rather than leaving somebody on
        // the old view wondering whether it worked.
        if (created?.id) setViewId(created.id);
      });
    },
    onError: (err: Error) => toast.error('Could not save this view', err.message),
  });

  // Record the id order the user is looking at (table or kanban, whichever
  // rendered) so opening a record can offer prev/next through the same set
  // without threading state through every row's navigate() call.
  useEffect(() => {
    if (moduleName && data?.rows) saveListNav(moduleName, data.rows.map((r) => r.id));
  }, [moduleName, data]);

  // Attention is driven by the actual sales state, not a separate per-user
  // "seen" inbox. A contact is never silently cleared just because someone
  // visited the list.
  const unseen = useMemo(() => new Set<string>(), []);

  if (!moduleName) return <div />;

  // `:module` is the catch-all for every single-segment URL, so it is what
  // answers a dead bookmark or a typo — and it used to answer them with loading
  // skeletons that never resolved. /studio is the case that matters: the page
  // existed until it was deleted, so somebody's tab and somebody's bookmark
  // still point at it, and a permanent spinner reads as "the CRM is broken"
  // rather than "that screen is gone".
  if (metaFailed) {
    return (
      <div className="p-4 sm:p-6">
        <EmptyState
          icon={<Compass className="h-10 w-10" />}
          title={`There is no “${moduleName}” here`}
          body="The link may be out of date, or the module may have been renamed or removed."
          action={<Link to="/dashboard" className="btn-primary btn-sm">Go to the dashboard</Link>}
        />
      </div>
    );
  }

  /**
   * Any other failure gets a way out, rather than skeletons forever.
   *
   * Fixing the 404 left every *other* metadata failure — a 500, a rate limit, a
   * request that timed out — rendering the loading state permanently, which is
   * the same defect wearing a different status code. It surfaced as a flaky
   * test of my own: under a full suite run every spec signs in as the same
   * admin and shares one rate-limit bucket, so the metadata call occasionally
   * came back 429 and the screen sat on skeletons until the assertion timed out.
   * A rep would have sat there rather longer.
   */
  if (!meta && metaError) {
    return (
      <div className="p-4 sm:p-6">
        <EmptyState
          icon={<RefreshCw className="h-10 w-10" />}
          title="Could not load this list"
          body={(metaError as Error).message}
          action={<button className="btn-primary btn-sm" onClick={() => void refetchMeta()}>Try again</button>}
        />
      </div>
    );
  }

  if (metaLoading || !meta) {
    return (
      <div className="space-y-3 p-4 sm:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  /*
    Everything below this point runs only once `meta` has arrived, which is
    why none of it may be a hook.

    The guards above return early while the module is loading, so a `useMemo`
    here runs on some renders and not others — React counts hooks per render
    and throws "Rendered more hooks than during the previous render", which
    takes the whole list to an error boundary the moment the data lands. Both
    of these are a filter and a lookup over a list of fields; plain
    expressions cost nothing and cannot get the order wrong.
  */

  const fieldMap = new Map(meta.fields.map((f) => [f.name, f]));

  const canCreate = meta.permissions.create;
  /*
    **30 September 2026, the owner's prototype:** the list's controls live in
    the record pane now, under its own header — *"the list of All Leads,
    Status, Call Log etc button move to Below Filter & Sorting Icons of Left
    pane … in Small buttons Box/Chip"* — with the search box always open under
    them and the paging at the foot. They are the same components as before;
    only where they sit has changed, so every filter still reaches the server
    with the rest of the query.

    The chips **wrap rather than scroll**. A dropdown here is positioned
    against its button, not drawn in a portal, and a sideways-scrolling row
    would clip the panel it opens.
  */
  // Every quick and live filter that is on — the badge on the filter button
  // over the queue, which is the one way into the panel since 3 October 2026.
  const quickFilterCount = countActiveQuickFilters({
    filter, stages: stagePick, agent: agentPick, task: taskQueue, disposition: dispositionPick, picks,
  });
  const queueTools = (
    <div className="shrink-0 border-b border-[var(--border)]" data-testid="queue-tools">
      <div className="flex flex-wrap items-center gap-1 bg-[var(--surface-muted)] px-2.5 py-1.5 dark:bg-slate-800/40">
          <Dropdown
          align="left"
          className="min-w-[18rem]"
          trigger={(
            <button
              /* "On" means this button is narrowing the list. The module's
                 own All-Leads view is a system view and narrows nothing, so
                 it must not sit lit from the moment the page opens. */
              className={toolbarButton(Boolean(tagPick || (activeView && !activeView.isSystem)), 'max-w-[14rem]')}
              aria-label="Choose or manage list views"
              title={tagPick ?? activeView?.name ?? `All ${meta.label}`}
            >
              {/*
                One button, two of his four colours — it picks a **list or a
                tag**, so it says which: red when a tag is narrowing the list,
                blue when a saved list is.
              */}
              {tagPick
                ? <Tag className={filterIcon('tag', true)} />
                : <Filter className={filterIcon('list', Boolean(activeView && !activeView.isSystem))} />}
              {/* No chevron — *"remove arrow key from all Buttons, so that
                  we can See neet and clean Toolbar"* (28 September 2026).
                  The icon on the left already says what this opens. */}
              {/* Icon and count only — *"just icons … along with count"*
                  (1 October 2026). The list's name is the tooltip. */}
              <span className="sr-only">{tagPick ?? activeView?.name ?? `All ${meta.label}`}</span>
              <span className={toolbarCount(Boolean(tagPick || (activeView && !activeView.isSystem)))}>
                {(data?.total ?? 0).toLocaleString('en-IN')}
              </span>
            </button>
          )}
        >
          {(close) => (
            <ListPicker
              views={(views ?? []).map((v) => ({
                id: v.id, name: v.name, isSystem: v.isSystem, isPublic: v.isPublic,
                isDefault: v.isDefault, ownerId: v.ownerId,
                isOverride: (v as { isOverride?: boolean }).isOverride,
                count: (v as { count?: number }).count,
              }))}
              activeViewId={activeView?.id ?? null}
              activeTag={tagPick}
              moduleName={meta.name}
              userId={user?.id}
              isAdmin={Boolean(user?.isAdmin)}
              moduleLabel={meta.label}
              onChooseView={(id) => { setTagPick(null); chooseView(id); close(); }}
              onChooseTag={(name) => { setTagPick(name); setPage(1); close(); }}
              onNew={() => { setEditingView(blankView(moduleName)); close(); }}
              onEdit={(id) => {
                const full = (views ?? []).find((v) => v.id === id);
                if (full) setEditingView(full as SavedView);
                close();
              }}
              onDuplicate={(id) => { duplicateView.mutate(id); close(); }}
              onShare={(id) => { shareView.mutate(id); close(); }}
              onSetDefault={(id) => { setDefaultView.mutate(id); close(); }}
              onDelete={(id) => {
                const full = (views ?? []).find((v) => v.id === id);
                if (full) setConfirmDeleteView(full);
                close();
              }}
            />
          )}
        </Dropdown>

        <StatusBreakdown
          moduleName={moduleName}
          meta={meta}
          viewId={activeView?.id}
          baseFilter={breakdownFilter}
          selected={stagePick}
          agent={agentPick}
          onApply={(values) => { setStagePick(values); setPage(1); }}
          onPickAgent={(userId) => { setAgentPick(userId); setPage(1); }}
        />

        {taskQueuesEnabled && (
          <FollowUpQueue
            moduleName={moduleName}
            fieldName={taskField!.name}
            viewId={activeView?.id}
            fieldMap={fieldMap}
            active={taskQueue}
            onPick={(queue) => { setTaskQueue(queue); setPage(1); }}
            ownerField={ownerField?.name ?? null}
            agent={agentPick}
            onPickAgent={(userId) => { setAgentPick(userId); setPage(1); }}
          />
        )}

        {/* After Follow-ups. It was the last-call-outcome chip until
            1 October 2026, when the owner swapped it for Hot; that filter is
            still in the filter panel. */}
        <HotTagChip
          moduleName={moduleName!}
          active={tagPick}
          onPick={(tag) => { setTagPick(tag); setPage(1); }}
        />

      </div>
      <div className="flex items-center gap-1.5 bg-white p-2 dark:bg-slate-900">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            data-testid="list-search"
            className="w-full rounded-md border-none bg-slate-100 py-1.5 pl-8 pr-7 text-xs text-slate-800 placeholder-slate-500 focus:ring-1 focus:ring-brand-500 dark:bg-slate-800 dark:text-slate-100"
            placeholder={`Search ${meta.label.toLowerCase()}…`}
            aria-label={`Search ${meta.label}`}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:bg-slate-200 dark:hover:bg-slate-700" aria-label="Clear list search" onClick={() => setSearchInput('')}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
            <button
              onClick={() => setShowFilters((value) => !value)}
              className={cn('btn-secondary btn-sm px-2', quickFilterCount > 0 && 'border-brand-400 text-brand-700 dark:text-brand-300')}
              aria-label="Quick and live filters"
              aria-expanded={showFilters}
              title="Quick and live filters"
              data-testid="quick-filter-button"
            >
              <Filter className="h-3.5 w-3.5" />
              {quickFilterCount > 0 && (
                <span className="rounded-full bg-brand-600 px-1.5 text-2xs text-white">{quickFilterCount}</span>
              )}
            </button>

            <Dropdown
              trigger={<button className="btn-secondary btn-sm" aria-label="List options"><Settings2 className="h-3.5 w-3.5" /></button>}
            >
              {(close) => (
                <>
                  {activeView && (
                    <DropdownItem
                      icon={<Save className="h-3.5 w-3.5" />}
                      onClick={() => { saveViewMutation.mutate(); close(); }}
                    >
                      Save this sort and filter to “{activeView.name}”
                    </DropdownItem>
                  )}
                  {/*
                    Keep what is on screen as a view of its own.

                    The line above overwrites the view you are standing in,
                    which is the wrong move when the columns, filter and sort
                    you have just arranged are a *second* way of working rather
                    than a correction to the first — "my Facebook leads this
                    week" is not an edit to All Leads. Without this the only
                    route was New view, which opens an empty editor and asks
                    you to rebuild by hand what the screen is already showing.
                  */}
                  <DropdownItem
                    icon={<Plus className="h-3.5 w-3.5" />}
                    onClick={() => { setSavingAsView(true); close(); }}
                  >
                    Save as a new view…
                  </DropdownItem>
                  <DropdownItem icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => { void refetch(); close(); }}>
                    Refresh
                  </DropdownItem>
                  {meta.permissions.export && (
                    <DropdownItem
                      icon={<Download className="h-3.5 w-3.5" />}
                      onClick={() => { setShowExport(true); close(); }}
                    >
                      Export CSV
                    </DropdownItem>
                  )}
                  {meta.permissions.import && (
                    <Link to={`/admin/import?module=${moduleName}`} onClick={close}>
                      <DropdownItem icon={<Upload className="h-3.5 w-3.5" />}>Import records</DropdownItem>
                    </Link>
                  )}
                </>
              )}
            </Dropdown>

      </div>
    </div>
  );

  /** Where these rows sit in the whole list, and a page either way. */
  const queueFooter = (data?.total ?? 0) > 0 ? (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-[11px] text-slate-600 dark:bg-slate-800/40 dark:text-slate-300">
      <span className="truncate tnum">{isFetching && !data ? 'Loading…' : recordRange(page, pageSize, rows.length, data?.total ?? 0)}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button className="rounded border border-slate-200 bg-white px-1.5 py-0.5 hover:text-slate-900 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-3.5 w-3.5" /></button>
        <label className="flex items-center gap-1 whitespace-nowrap font-medium"><input className="h-5 w-10 rounded border border-slate-200 bg-white px-1 text-center text-[11px] dark:border-slate-700 dark:bg-slate-900" aria-label="Go to page" type="number" min={1} max={data!.totalPages} value={pageInput} onFocus={(e) => e.currentTarget.select()} onBlur={commitPageInput} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} onChange={(e) => setPageInput(e.target.value)} /><span>/ {data!.totalPages}</span></label>
        <button className="rounded border border-slate-200 bg-white px-1.5 py-0.5 hover:text-slate-900 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900" aria-label="Next page" disabled={page >= data!.totalPages} onClick={() => setPage((p) => Math.min(data!.totalPages, p + 1))}><ChevronRight className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  ) : null;

  /** How many of the quick filters are narrowing the list right now. */
  const clearQuickFilters = (): void => {
    setAgentPick(null);
    setStagePick([]);
    setTaskQueue(null);
    setDispositionPick(NO_DISPOSITION_PICK);
    setPicks({});
    setFilter(EMPTY_FILTER);
    setPage(1);
  };
  const pickQuick = (field: string, pick: QuickPick | null): void => {
    setPicks((current) => {
      const next = { ...current };
      if (pick) next[field] = pick; else delete next[field];
      return next;
    });
    setPage(1);
  };

  const quickFilterPanel = (placement: 'pane' | 'floating'): JSX.Element => (
    <QuickFilterOverlay
      open={showFilters}
      onClose={() => setShowFilters(false)}
      placement={placement}
      module={meta}
      sections={quickSections}
      count={data?.total}
      counting={isFetching}
      views={(views ?? []).map((view) => ({ id: view.id, name: view.name, isDefault: view.isDefault, count: view.count }))}
      activeViewId={activeView?.id}
      onChooseView={(id) => { setTagPick(null); chooseView(id); }}
      ownerField={ownerField}
      agent={agentPick}
      onAgent={(id) => { setAgentPick(id); setPage(1); }}
      stageField={stageField}
      stages={stagePick}
      onStages={(values) => { setStagePick(values); setPage(1); }}
      taskField={taskField}
      task={taskQueue}
      onTask={(value) => { setTaskQueue(value); setPage(1); }}
      disposition={dispositionPick}
      onDisposition={(value) => { setDispositionPick(value); setPage(1); }}
      picks={picks}
      onPick={pickQuick}
      filter={filter}
      onFilter={(value) => { setFilter(value); setPage(1); }}
      onClear={clearQuickFilters}
    />
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      {/*
        The toolbar reads as a bar now, not as the top of the page.

        It was a near-white strip on a near-white page with a hairline border —
        the view name, the record count and every control on the screen sat in
        it, and none of it caught the eye. Reported as "not very eye catching",
        which is the right complaint: this row is where somebody looks to
        answer "which list am I on and how many are in it".

        A solid ground, a real bottom border and a little more height are the
        whole change — no colour, because the row is a container and the
        coloured thing in it should go on being the New button.
      */}
      {/*
        The list's controls sit inside the record pane now (see
        `queueTools`). With no records to show there is no pane, so they sit
        here instead — otherwise a filter that emptied the list would take the
        only way to undo it off the screen with it.
      */}
      <h1 className="sr-only">{meta.label}</h1>
      {rows.length === 0 && !(isLoading && !data) && (
        <div className="shrink-0 bg-white dark:bg-slate-900">
          {queueTools}
          {/* The count stays on screen too — "0 records" is the answer somebody
              filtering is looking for, and the paging footer is not drawn. */}
          <p className="border-b border-[var(--border)] px-3 py-1.5 text-[11px] text-slate-600 tnum dark:text-slate-300">
            {recordRange(page, pageSize, rows.length, data?.total ?? 0)}
          </p>
        </div>
      )}

      {/* Bulk action bar */}
      {(selected.size > 0 || selectedAll) && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-brand-200 bg-brand-50 px-4 py-2 dark:border-brand-900 dark:bg-brand-950/50 sm:px-6">
          <span className="text-sm font-medium text-brand-800 dark:text-brand-200">
            {selectedAll
              ? `All ${(data?.total ?? 0).toLocaleString('en-IN')} records in this view selected`
              : `${selected.size} selected`}
          </span>
          {/*
            The Gmail move: the header box selects the page, this link widens it
            to the whole result set. Offered only when there is more than the
            page holds, and cleared the moment the selection narrows again.
          */}
          {!selectedAll && (data?.total ?? 0) > rows.length && (
            <button
              className="text-xs text-brand-700 underline underline-offset-2 hover:text-brand-900 dark:text-brand-300 dark:hover:text-brand-100"
              onClick={() => { setSelectedAll(true); setSelected(new Set(rows.map((r) => r.id))); }}
            >
              Select all {(data?.total ?? 0).toLocaleString('en-IN')} records in this view
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              className="btn-primary btn-sm"
              disabled={selectedAll}
              title={selectedAll ? 'Choose individual records for a safe calling queue' : 'Create a progressive calling queue from these records'}
              onClick={startProgressiveDialer}
            >
              <PhoneForwarded className="h-3.5 w-3.5" /> Progressive Dialer
            </button>
            <button
              className="btn-secondary btn-sm"
              onClick={() => { setSelected(new Set()); setSelectedAll(false); }}
            >
              <X className="h-3.5 w-3.5" /> Clear
            </button>
            {meta.permissions.edit && (
              <>
                <BulkEditButton
                  module={moduleName}
                  fieldMap={fieldMap}
                  ids={[...selected]}
                  allQuery={selectedAll ? query : null}
                  allCount={data?.total ?? 0}
                  onDone={() => { setSelected(new Set()); setSelectedAll(false); void refetch(); }}
                />
              </>
            )}
            {meta.permissions.delete && !selectedAll && (
              <button className="btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
          </div>
        </div>
      )}

      {/* Body */}
      {/* A flex item defaults to its content width. Without `min-w-0`, a wide
          table widened the whole page instead of this scroll region; the page
          then moved sideways and the frozen identity column naturally moved
          with it. Keep both axes inside this one scroll container. */}
      {/*
        The record pane, the record and the call pane, inside the workspace.
        The toolbar to their left is the app's own (`Layout.tsx`): it is
        about getting around the CRM, not about this list.
      */}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {isLoading && !data ? (
          <div className="space-y-2 p-4 sm:p-6">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ModuleIcon name={meta.icon} className="h-10 w-10" />}
            /*
              The quick filter counts as a filter here. Without it a list
              narrowed to a kind nobody has read *"Create your first contact
              to get started"* over a database holding 22,988 of them — which
              is alarming rather than helpful, and says nothing about the one
              thing that caused it.
            */
            title={search || countConditions(effectiveFilter) ? 'No matching records' : `No ${meta.label.toLowerCase()} yet`}
            body={search || countConditions(effectiveFilter)
              ? 'Try adjusting your search or filters.'
              : `Create your first ${meta.singularLabel.toLowerCase()} to get started.`}
            /*
              The quick filter lives in the queue's own header, and an empty
              result replaces the whole workspace — header and all. So the one
              control that could undo it goes off the screen with it, and
              "Try adjusting your filters" points at something that is no
              longer there. Every other picker on this page is in the toolbar
              above, which stays; this one needs its own way back.
            */
            action={quickFilterCount
              ? <button className="btn-secondary btn-sm" onClick={clearQuickFilters}>
                  Clear filters
                </button>
              : canCreate && !search && !countConditions(filter)
                ? <button className="btn-primary btn-sm" onClick={() => setShowQuickCreate(true)}>
                    <Plus className="h-3.5 w-3.5" /> New {meta.singularLabel}
                  </button>
                : undefined}
          />
        ) : (
          <IpropyWorkspace
            /*
              A fresh workspace per module. Without it the record open on
              Contacts stays "open" for a moment after switching to
              Inventories, and its id is asked for as a unit — a 404 on every
              switch between the two.
            */
            key={meta.name}
            module={meta}
            rows={rows}
            // `?open=` — a record named in the address, from global search, a
            // chat, or Save & Next. It may not be on this page at all.
            openId={searchParams.get('open')}
            selected={selected}
            attentionIds={unseen}
            onToggleSelect={(id, checked) => {
              setSelectedAll(false);
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(id); else next.delete(id);
                return next;
              });
            }}
            /*
              Deleting from the desk goes through the same confirmation and the
              same endpoint the selection bar uses — one record is a selection
              of one. Offered only where the profile may delete, so the button
              is absent rather than present and refused.
            */
            onToggleAll={(checked) => {
              setSelectedAll(false);
              setSelected(checked ? new Set(rows.map((row) => row.id)) : new Set());
            }}
            /*
              The queue's own sorting menu drives the same query the table's
              column headers do — one ordering for the list, whichever way you
              asked for it, so the export and the screen still agree.
            */
            sortBy={effectiveSort.sortBy}
            sortDir={effectiveSort.sortDir}
            neighbourContext={{
              ...(activeView?.id ? { view: activeView.id } : {}),
              ...(search ? { search } : {}),
              ...(countConditions(effectiveFilter) ? { filter: JSON.stringify(effectiveFilter) } : {}),
            }}
            callQueueUrl={callQueueSnapshot}
            onSort={(by, dir) => { setSortBy(by); setSortDir(dir); setPage(1); }}
            queueTools={queueTools}
            queueFooter={queueFooter}
            onShowing={setPaneShowing}
            filterBar={{
              open: showFilters,
              // Drawn inside the right-hand pane, in its exact shape. It is
              // opened by the filter button over the queue; the pane's own bar
              // for it went on 3 October 2026 as a duplicate of that button.
              panel: quickFilterPanel('pane'),
            }}
            onDelete={meta.permissions.delete
              ? (row) => { setSelected(new Set([row.id])); setSelectedAll(false); setConfirmDelete(true); }
              : undefined}
          />
        )}
      </div>

      {/*
        Pagination, on a phone.

        It belongs to the **list**, so it stands down while a record has the
        screen — otherwise a record opened on a phone sits above a pager for a
        list that is not on screen, which is what the owner would have met the
        first time he opened the CRM on his phone (2 October 2026).
      */}
      {(data?.total ?? 0) > 0 && paneShowing === 'list' && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-white px-4 py-2 lg:hidden dark:bg-slate-900 sm:px-6">
          <p className="text-xs text-muted tnum">
            {((data!.page - 1) * data!.pageSize + 1).toLocaleString('en-IN')}–
            {Math.min(data!.page * data!.pageSize, data!.total).toLocaleString('en-IN')} of {data!.total.toLocaleString('en-IN')}
          </p>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Rows per page
            <Select
              value={String(pageSize)}
              onChange={(value) => setPageSize(Number(value))}
              options={PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: String(size) }))}
            />
          </label>
          {/*
            A page button has to look like a button.

            These were bare ghost chevrons, so "there is another page" and
            "there is not" differed only by opacity — reported as the Next
            button not working when it was in fact enabled and un-obvious, and
            as being stuck on the last page when the last page was genuinely the
            end. Enabled now carries a border and the brand colour, disabled is
            plainly greyed, and First/Last exist so the far end of 10 pages is
            one click rather than nine.
          */}
          <div className="flex items-center gap-1">
            <PageButton
              label="First page"
              disabled={page <= 1}
              onClick={() => setPage(1)}
            >
              <ChevronsLeft className="h-4 w-4" />
            </PageButton>
            <PageButton
              label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </PageButton>
            <label className="flex items-center gap-1 px-1 text-xs tnum text-muted">
              Page
              <input
                className="input h-7 w-14 px-1 text-center text-xs"
                aria-label="Go to page"
                type="number"
                min={1}
                max={data!.totalPages}
                value={pageInput}
                onBlur={commitPageInput}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                onChange={(e) => setPageInput(e.target.value)}
              />
              <span>/ {data!.totalPages}</span>
            </label>
            <PageButton
              label="Next page"
              disabled={page >= (data?.totalPages ?? 1)}
              onClick={() => setPage((p) => Math.min(data?.totalPages ?? p, p + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </PageButton>
            <PageButton
              label="Last page"
              disabled={page >= (data?.totalPages ?? 1)}
              onClick={() => setPage(data?.totalPages ?? 1)}
            >
              <ChevronsRight className="h-4 w-4" />
            </PageButton>
          </div>
        </div>
      )}

      {/* Modals */}
      {/*
        Just a name. Everything else about the view is already on screen, and
        asking somebody to re-pick it in a full editor is how "save what I am
        looking at" turns into a form.
      */}
      <NameNewViewDialog
        open={savingAsView}
        busy={saveAsNewView.isPending}
        moduleLabel={meta.label}
        columnCount={columns.length}
        filterCount={countConditions(filter)}
        onClose={() => setSavingAsView(false)}
        onSave={(name) => saveAsNewView.mutate(name)}
      />

      {editingView && (
        <ViewEditor
          view={editingView}
          module={meta}
          moduleName={moduleName}
          onClose={() => setEditingView(null)}
          onSaved={() => {
            setEditingView(null);
            void queryClient.invalidateQueries({ queryKey: ['views', moduleName] });
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(confirmDeleteView)}
        onClose={() => setConfirmDeleteView(null)}
        onConfirm={() => confirmDeleteView ? deleteViewMutation.mutateAsync(confirmDeleteView.id) : Promise.resolve()}
        title={`Delete “${confirmDeleteView?.name ?? ''}”?`}
        body="This removes your saved view. Records are not affected."
        confirmLabel="Delete view"
        danger
      />
      {/* With no record open there is no right-hand pane to fill, so the
          panel sits at the screen's own right edge instead. */}
      {rows.length === 0 && quickFilterPanel('floating')}

      <ExportWizard
        open={showExport}
        onClose={() => setShowExport(false)}
        module={moduleName}
        fields={meta.fields}
        filter={filter}
        selectedIds={selectedAll ? undefined : selected.size ? [...selected] : undefined}
        allSelected={selectedAll}
      />

      {showCapture && (
        <Modal
          open
          onClose={() => setShowCapture(false)}
          title="Capture on site"
          size="lg"
        >
          <SiteCapture inModal onSaved={() => void refetch()} />
        </Modal>
      )}

      {showQuickCreate && (
        <Modal open onClose={() => setShowQuickCreate(false)} title={`New ${meta.singularLabel}`} size="lg">
          <RecordForm
            module={meta}
            mode="quick_create"
            initialValues={quickCreateDefaults}
            onSaved={(record) => {
              setShowQuickCreate(false);
              toast.success(`${meta.singularLabel} created`, record.label);
              // Stay on the list rather than opening the new record. The
              // refetch puts it in the table the user is already looking at,
              // and adding a lead is usually one of several in a sitting.
              void refetch();
            }}
            onCancel={() => setShowQuickCreate(false)}
          />
        </Modal>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => deleteMutation.mutateAsync([...selected])}
        title={`Delete ${selected.size} record${selected.size === 1 ? '' : 's'}?`}
        body="They move to the recycle bin and can be restored by an administrator."
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Columns to show when no view says otherwise.
 *
 * Identity first, always. Taking the first seven fields in sequence order gave
 * a leads table whose first column was Date of Birth and which showed nobody's
 * name — technically a list of leads, useless as one. This only surfaced when
 * the views query failed and the fallback ran for real, which is the argument
 * for the fallback being decent rather than merely present.
 */
/** One pager control: obviously live when there is somewhere to go, obviously not when there isn't. */
function PageButton({ label, disabled, onClick, children }: {
  label: string; disabled: boolean; onClick: () => void; children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
        disabled
          ? 'cursor-not-allowed border-slate-200 text-slate-300 dark:border-slate-800 dark:text-slate-700'
          : 'border-slate-300 text-brand-600 hover:border-brand-400 hover:bg-brand-50 dark:border-slate-600 dark:text-brand-300 dark:hover:bg-slate-800',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Every column this module has, identity first.
 *
 * What a view showing no columns of its own means. The two built-in views ship
 * with an empty list on purpose (migration 135): an empty list goes on meaning
 * "all of them" after somebody adds a field, where a written-out list would
 * have frozen today's fields into data and quietly left the new one off.
 *
 * The seven-column cut that used to live here is still right for a module with
 * no view at all — see `defaultColumns` — but it is not what "show me
 * everything" means.
 */
function allColumns(meta: {
  labelFields?: string[];
  fields: { name: string; isActive: boolean; displayType: string }[];
} | undefined): string[] {
  if (!meta) return [];
  const usable = meta.fields.filter((f) => f.isActive && f.displayType !== 'hidden');
  const identity = (meta.labelFields ?? []).filter((name) => usable.some((f) => f.name === name));
  const rest = usable.map((f) => f.name).filter((name) => !identity.includes(name));
  return [...identity, ...rest];
}

/** The first handful, for a module that has no saved view to ask. */
function defaultColumns(meta: {
  labelFields?: string[];
  fields: { name: string; isActive: boolean; displayType: string }[];
} | undefined): string[] {
  return allColumns(meta).slice(0, 7);
}





function ExportWizard({ open, onClose, module, fields, filter, selectedIds, allSelected }: {
  open: boolean; onClose: () => void; module: string; fields: FieldMeta[]; filter: FilterGroup; selectedIds?: string[]; allSelected: boolean;
}): JSX.Element {
  /*
    A to Z, like every other field list in the CRM.

    This one has a search box above it, which helps when you know the name and
    not at all when you are picking eight of forty for a spreadsheet — and
    `sequence` is the order somebody arranged a *form* in, which says nothing
    about where to look for "Locality" in a list.
  */
  const available = byLabel(
    fields.filter((f) => f.isActive && f.displayType !== 'hidden' && f.config.exportable !== false),
  );
  type ExportChoice = { fieldId: string; header: string };
  const [columns, setColumns] = useState<ExportChoice[]>([]);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [busy, setBusy] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [activeTemplate, setActiveTemplate] = useState('');
  const [fieldSearch, setFieldSearch] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [scope, setScope] = useState<'selected' | 'filtered' | 'all'>(selectedIds?.length ? 'selected' : 'filtered');
  const { data: templates, refetch: refetchTemplates } = useQuery({ queryKey: ['export-templates', module], queryFn: () => api.exportTemplates(module) });
  useEffect(() => {
    if (!open) return;
    const defaultTemplate = templates?.find((t) => t.isDefault);
    if (defaultTemplate) { setActiveTemplate(defaultTemplate.id); setColumns(defaultTemplate.columns.map((c) => ({ fieldId: c.fieldId, header: c.header ?? available.find((f) => f.internalId === c.fieldId)?.label ?? '' }))); }
    else setColumns(available.map((f) => ({ fieldId: f.internalId, header: f.label })));
    setScope(selectedIds?.length ? 'selected' : 'filtered');
  }, [open, templates]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = (index: number, direction: -1 | 1): void => setColumns((old) => {
    const next = [...old]; const other = index + direction;
    if (other < 0 || other >= next.length) return old;
    [next[index], next[other]] = [next[other], next[index]]; return next;
  });
  const setField = (field: FieldMeta, checked: boolean): void => setColumns((old) => checked
    ? [...old, { fieldId: field.internalId, header: field.label }]
    : old.filter((c) => c.fieldId !== field.internalId));
  const exportColumns = columns.map(({ fieldId, header }) => ({ fieldId, ...(header.trim() ? { header: header.trim() } : {}) }));
  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await api.exportRecords(module, { format, columns: exportColumns, filter: scope === 'all' ? EMPTY_FILTER : filter, selectedIds: scope === 'selected' ? selectedIds : undefined });
      // `deliverFile`, not an <a download>: a webview has no downloads tray,
      // so in the app that anchor is inert and the export silently vanishes.
      await deliverFile(await response.blob(), `${module}-export.${format}`);
      onClose();
    } catch (err) { toast.error('Export failed', (err as Error).message); } finally { setBusy(false); }
  };
  const saveTemplate = async (): Promise<void> => {
    if (!templateName.trim()) { toast.error('Enter a template name'); return; }
    try { await api.createExportTemplate(module, { name: templateName.trim(), columns: exportColumns, filter: scope === 'all' ? EMPTY_FILTER : filter }); setTemplateName(''); await refetchTemplates(); toast.success('Export template saved'); }
    catch (err) { toast.error('Could not save template', (err as Error).message); }
  };
  const active = templates?.find((t) => t.id === activeTemplate);
  return <Modal open={open} onClose={onClose} title="Export records" size="lg" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!columns.length || busy} onClick={() => void run()}>{busy && <Spinner />} Export {format.toUpperCase()}</button></>}>
    <p className="mb-3 text-sm text-muted">Choose the records, fields and column names for this export.</p>
    <div className="mb-3 flex flex-wrap gap-2">
      {selectedIds?.length ? <button className={cn('btn-secondary btn-sm', scope === 'selected' && 'border-brand-500')} onClick={() => setScope('selected')}>{selectedIds.length} selected</button> : null}
      <button className={cn('btn-secondary btn-sm', scope === 'filtered' && 'border-brand-500')} onClick={() => setScope('filtered')}>{allSelected ? 'Current filtered results' : 'Current results'}</button>
      <button className={cn('btn-secondary btn-sm', scope === 'all' && 'border-brand-500')} onClick={() => setScope('all')}>All records</button>
    </div>
    {templates?.length ? <div className="mb-2 flex gap-2"><Select value={activeTemplate} onChange={(id) => { setActiveTemplate(id); const t = templates.find((x) => x.id === id); if (t) setColumns(t.columns.map((c) => ({ fieldId: c.fieldId, header: c.header ?? available.find((f) => f.internalId === c.fieldId)?.label ?? '' }))); }} placeholder="Use a saved template" options={templates.map((t) => ({ value: t.id, label: `${t.name}${t.isDefault ? ' (default)' : ''}` }))} />
      {active ? <><button className="btn-secondary btn-sm" onClick={() => void api.updateExportTemplate(module, active.id, { columns: exportColumns, filter: scope === 'all' ? EMPTY_FILTER : filter }).then(() => refetchTemplates()).then(() => toast.success('Template updated')).catch((e: Error) => toast.error('Could not update template', e.message))}>Update</button><button className="btn-secondary btn-sm" onClick={() => { const name = window.prompt('New template name', active.name); if (name?.trim()) void api.updateExportTemplate(module, active.id, { name: name.trim() }).then(() => refetchTemplates()).then(() => toast.success('Template renamed')).catch((e: Error) => toast.error('Could not rename template', e.message)); }}>Rename</button><button className="btn-secondary btn-sm" onClick={() => void api.updateExportTemplate(module, active.id, { isDefault: !active.isDefault }).then(() => refetchTemplates()).then(() => toast.success(active.isDefault ? 'Default removed' : 'Set as default')).catch((e: Error) => toast.error('Could not set default', e.message))}>{active.isDefault ? 'Remove default' : 'Set default'}</button><button className="btn-secondary btn-sm" onClick={() => { if (window.confirm(`Delete “${active.name}”?`)) void api.deleteExportTemplate(module, active.id).then(() => { setActiveTemplate(''); void refetchTemplates(); toast.success('Template deleted'); }).catch((e: Error) => toast.error('Could not delete template', e.message)); }}>Delete</button></> : null}</div> : null}
    <div className="mb-3 flex gap-2"><button className={cn('btn-secondary btn-sm', format === 'xlsx' && 'border-brand-500')} onClick={() => setFormat('xlsx')}>Excel (.xlsx)</button><button className={cn('btn-secondary btn-sm', format === 'csv' && 'border-brand-500')} onClick={() => setFormat('csv')}>CSV (.csv)</button></div>
    <div className="mb-2 flex gap-2"><input className="input h-8 flex-1 text-sm" placeholder="Search fields…" value={fieldSearch} onChange={(e) => setFieldSearch(e.target.value)} /><button className="btn-secondary btn-sm" onClick={() => setColumns(available.map((f) => ({ fieldId: f.internalId, header: f.label })))}>Select all</button><button className="btn-secondary btn-sm" onClick={() => setColumns([])}>Clear all</button></div>
    <div className="grid gap-3 md:grid-cols-2"><div className="max-h-64 space-y-1 overflow-y-auto rounded border p-2">{available.filter((f) => f.label.toLowerCase().includes(fieldSearch.toLowerCase())).map((f) => <label key={f.internalId} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"><input type="checkbox" checked={columns.some((c) => c.fieldId === f.internalId)} onChange={(e) => setField(f, e.target.checked)} />{f.label}</label>)}</div>
      <div className="max-h-64 space-y-1 overflow-y-auto rounded border p-2">{columns.map((c, index) => <div key={c.fieldId} draggable onDragStart={() => setDragIndex(index)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragIndex == null || dragIndex === index) return; setColumns((old) => { const next = [...old]; const [moved] = next.splice(dragIndex, 1); next.splice(index, 0, moved); return next; }); setDragIndex(null); }} className="flex cursor-grab items-center gap-1 active:cursor-grabbing"><div className="w-5 text-center text-xs text-muted">{index + 1}</div><input className="input h-8 min-w-0 flex-1 text-sm" value={c.header} aria-label="Export column name" onChange={(e) => setColumns((old) => old.map((x) => x.fieldId === c.fieldId ? { ...x, header: e.target.value } : x))} /><button className="rounded p-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800" disabled={index === 0} onClick={() => move(index, -1)} aria-label="Move column up"><ChevronUp className="h-4 w-4" /></button><button className="rounded p-1 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800" disabled={index === columns.length - 1} onClick={() => move(index, 1)} aria-label="Move column down"><ChevronDown className="h-4 w-4" /></button></div>)}</div></div>
    <div className="mt-3 flex gap-2"><input className="input h-8 flex-1 text-sm" placeholder="Save this selection as…" value={templateName} onChange={(e) => setTemplateName(e.target.value)} /><button className="btn-secondary btn-sm" onClick={() => void saveTemplate()}>Save template</button></div>
  </Modal>;
}

/**
 * Bulk edit any column: pick a field, type the new value once, apply it to the
 * selection (or to the whole view when "select all" is on).
 *
 * The field list is the module's own editable fields — the same FieldInput the
 * record form uses renders the value box, so picklists offer their options,
 * currency accepts "1.5 cr", and a per-field validation mistake is caught the
 * same way it would be one record at a time.
 */
function BulkEditButton({
  module, fieldMap, ids, allQuery, allCount, onDone,
}: {
  module: string;
  fieldMap: Map<string, FieldMeta>;
  ids: string[];
  allQuery: ListQuery | null;
  allCount: number;
  onDone: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [fieldName, setFieldName] = useState('');
  const [value, setValue] = useState<unknown>(null);
  const [other, setOther] = useState<Record<string, unknown>>({});
  // Off, like the import's. A bulk tidy-up is not five hundred new leads
  // arriving, and running the automations on one used to queue a greeting for
  // every record — see recordService.massUpdate.
  const [runWorkflows, setRunWorkflows] = useState(false);
  const [busy, setBusy] = useState(false);
  const countLabel = allQuery ? allCount.toLocaleString('en-IN') : String(ids.length);

  const editable = useMemo(
    () => Array.from(fieldMap.values()).filter((f) =>
      f.isActive
      && f.displayType !== 'hidden' && f.displayType !== 'detail_only'
      && f.displayType !== 'readonly' && f.displayType !== 'create_only'
      && !f.isReadonly
      && f.massEditable),
    // **Assigned To is bulk-editable again**, on the owner's instruction later
    // the same day: *"in the bulk edit of Inventory, please provide Assignto
    // option from bulk adit feature"* (2 October 2026). The standalone
    // Reassign button went that morning as a duplicate; handing twenty units
    // to one agent is the job it was doing, and this is where it belongs —
    // beside every other field a selection can be changed through, on every
    // module rather than only Inventories.
    //
    // Nothing special is needed on the server: `owner_id` is already
    // `mass_editable` on all three modules and `massUpdate` writes it through
    // `recordService` like any other field, so permissions, validation and the
    // audit trail apply unchanged.
    [fieldMap],
  );
  const field = fieldName ? fieldMap.get(fieldName) : undefined;

  const emptyValue = (f: FieldMeta | undefined): unknown => (
    f?.uitype === 'multipicklist' || f?.uitype === 'tags' || f?.uitype === 'multireference' ? [] : null
  );

  return (
    <>
      <button className="btn-secondary btn-sm" onClick={() => setOpen(true)}>
        <Pencil className="h-3.5 w-3.5" /> Edit
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Edit ${countLabel} record${countLabel === '1' ? '' : 's'}`}
        size="md"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!field || busy}
              onClick={async () => {
                if (!field) return;
                setBusy(true);
                try {
                  // A field with its own unit (Budget, Area / Size) writes two
                  // values, not one. `other` collects the second — without it
                  // the unit dropdown quietly overwrote the number itself.
                  const payload = { ...other, [field.name]: value };
                  const result = allQuery
                    ? await api.massUpdateAll(module, allQuery as unknown as Record<string, unknown>, payload, runWorkflows)
                    : await api.massUpdate(module, ids, payload, runWorkflows);
                  const ok = result.updated ?? 0;
                  const failed = (result.failed as unknown[] | undefined)?.length ?? 0;
                  const reasons = (result.reasons as string[] | undefined) ?? [];

                  // Say *why*, not only how many. "83 could not be updated"
                  // with no reason is the same as no answer at all — there is
                  // nothing the person can do next.
                  const notes = [
                    failed ? `${failed} left unchanged${reasons.length ? `: ${reasons.join('; ')}` : '.'}` : '',
                    result.capped ? `Only the first ${ok + failed} were edited — narrow the view and run it again.` : '',
                  ].filter(Boolean).join(' ');

                  if (ok === 0 && failed > 0) toast.error('Nothing was updated', notes);
                  else {
                    toast.success(
                      `${ok.toLocaleString('en-IN')} record${ok === 1 ? '' : 's'} updated`,
                      notes || undefined,
                    );
                  }
                  setOpen(false);
                  onDone();
                } catch (err) {
                  toast.error('Bulk edit failed', (err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <Spinner />} Apply to {countLabel}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label">Field to change</label>
            <Select
              value={fieldName}
              onChange={(v) => { setFieldName(v); setValue(emptyValue(fieldMap.get(v))); setOther({}); }}
              placeholder="— Choose a field —"
              // A–Z: this is a list of every editable field on the module, and
              // metadata order means nothing to somebody looking for "Lead
              // Status" in it.
              options={[...editable]
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
                .map((f) => ({ value: f.name, label: f.label }))}
            />
          </div>
          {field && (
            <div>
              <label className="label">{field.label}</label>
              <FieldInput
                field={field}
                value={value}
                onChange={(v) => setValue(v)}
                onChangeOther={(name, v) => setOther((prev) => ({ ...prev, [name]: v }))}
                formValues={{ [field.name]: value, ...other }}
                moduleName={module}
              />
              <p className="mt-1 text-2xs text-muted">
                Every selected record gets this value. Records where the field is
                hidden or read-only for the acting user are left unchanged.
              </p>
              <label className="mt-2 flex items-start gap-2 text-2xs text-muted">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3 w-3 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  checked={runWorkflows}
                  onChange={(e) => setRunWorkflows(e.target.checked)}
                />
                <span>
                  Run automations on every record. Off by default — setting Lead Status
                  across a whole list would otherwise queue a greeting, a score and a
                  follow-up task for each one.
                </span>
              </label>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

/**
 * Name the view you are already looking at.
 *
 * Deliberately not the full `ViewEditor`. That screen exists to *build* a view
 * — pick columns, write a filter, choose a sort — and every one of those is
 * already decided by the time somebody reaches for this. Reopening them in a
 * form would ask the question twice and invite a different answer the second
 * time.
 */
function NameNewViewDialog({
  open, busy, moduleLabel, columnCount, filterCount, onClose, onSave,
}: {
  open: boolean;
  busy: boolean;
  moduleLabel: string;
  columnCount: number;
  filterCount: number;
  onClose: () => void;
  onSave: (name: string) => void;
}): JSX.Element | null {
  const [name, setName] = useState('');
  useEffect(() => { if (open) setName(''); }, [open]);
  if (!open) return null;

  const save = (): void => { if (name.trim()) onSave(name.trim()); };

  return (
    <Modal
      open
      onClose={onClose}
      title="Save as a new view"
      size="sm"
      footer={(
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save view'}
          </button>
        </>
      )}
    >
      <label className="label" htmlFor="new_view_name">What should it be called?</label>
      <input
        id="new_view_name"
        autoFocus
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
        placeholder={`My ${moduleLabel.toLowerCase()}`}
      />
      <p className="mt-2 text-xs text-muted">
        Keeps the {columnCount ? `${columnCount} columns` : 'columns'} you are showing
        {filterCount ? `, the ${filterCount} filter${filterCount === 1 ? '' : 's'} you applied` : ', no filter'} and
        the way this list is sorted. It is yours until you share it.
      </p>
    </Modal>
  );
}

/** "51–100 of 22,981 records": which rows are on this page, out of how many. */
export function recordRange(page: number, pageSize: number, onThisPage: number, total: number): string {
  const count = (n: number): string => n.toLocaleString('en-IN');
  if (onThisPage === 0) return `0 of ${count(total)} records`;
  const first = (page - 1) * pageSize + 1;
  const last = first + onThisPage - 1;
  return `${count(first)}–${count(last)} of ${count(total)} records`;
}

const TASK_QUEUES: TaskQueue[] = ['pending', 'today', 'tomorrow', 'upcoming', 'week', 'month'];

/** A follow-up queue named in the address, or none — never a word it does not know. */
function taskFromAddress(value: string | null): TaskQueue | null {
  return TASK_QUEUES.includes(value as TaskQueue) ? (value as TaskQueue) : null;
}
