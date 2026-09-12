import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CustomView, type FieldMeta, type FilterGroup, formatIndianPrice, formatPhoneWithCode, toInternational, type ListQuery, type ModuleMeta, type RecordEnvelope } from '@ipropy/shared';
import {
  ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsLeft, ChevronsRight, Columns3, Compass, Download, Filter,
  LayoutGrid, List, MessageCircle, Pencil, Phone, Plus, RefreshCw, Ruler, Save, Search, Settings2, Star, Trash2, Upload, Users, X,
} from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { invalidateRecordQueries } from '../lib/invalidate';
import { saveListNav } from '../lib/listNav';
import { cn, restrictionForField } from '../lib/utils';
import { FieldInput, FieldValue } from '../components/FieldRenderer';
import { EditableField, isInlineEditable } from '../components/EditableField';
import { assignmentField } from '../lib/fields';
import { DEFAULT_PAGE_SIZE, loadPageSize, PAGE_SIZE_OPTIONS, savePageSize } from '../lib/pageSize';
import { FilterBuilder, countConditions } from '../components/FilterBuilder';
import {
  Badge, ConfirmDialog, Dropdown, DropdownItem, EmptyState, Modal, Select, Skeleton, Spinner,
} from '../components/ui';
import { ModuleIcon } from '../components/Layout';
import RecordForm from '../components/RecordForm';
import RecordPeek from '../components/RecordPeek';
import { useSwipeActions, type SwipeSide } from '../lib/swipeActions';
import { MAX_WIDTH, MIN_WIDTH, SELECT_COL_WIDTH, useColumnWidths } from '../lib/columnWidths';
import { useOfflineMeta } from '../lib/useOfflineList';
import { deliverFile, dial, openExternal } from '../lib/nativeActions';
import { blankView, type SavedView, ViewEditor } from '../components/ViewEditor';

const EMPTY_FILTER: FilterGroup = { logic: 'AND', conditions: [] };

export default function ListView(): JSX.Element {
  const { module: moduleName } = useParams<{ module: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  /*
    Opening a record loses your place in the list otherwise: the filters, the
    scroll position and which tab you were on all have to be rebuilt by hand when
    you come back. On by default; Admin → Settings → Your business turns it off.

    `noopener` because a tab opened with window.open can otherwise reach back
    through window.opener into the page that opened it.
  */
  const openInNewTab = useApp((st) => st.user?.ui?.openInNewTab ?? true);
  const openRecord = (path: string): void => {
    if (openInNewTab) window.open(path, '_blank', 'noopener,noreferrer');
    else navigate(path);
  };
  const queryClient = useQueryClient();
  const { user } = useApp();


  const [page, setPage] = useState(1);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewId, setViewId] = useState<string | undefined>(searchParams.get('view') ?? undefined);
  const [filter, setFilter] = useState<FilterGroup>(EMPTY_FILTER);
  const [sortBy, setSortBy] = useState<string | undefined>();
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [displayMode, setDisplayMode] = useState<'table' | 'kanban'>('table');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Gmail's "select all X in this search": when true, bulk actions run against
  // every record the current view/filter matches, not just this page's ids.
  const [selectedAll, setSelectedAll] = useState(false);
  // Which record a long press is previewing. Null when nothing is peeked.
  const [peekId, setPeekId] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingView, setEditingView] = useState<SavedView | null>(null);
  const [confirmDeleteView, setConfirmDeleteView] = useState<CustomView | null>(null);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const colWidths = useColumnWidths(moduleName);

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
    setHydratedFor(moduleName ?? null);
  }, [moduleName]);

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

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
    setDisplayMode(activeView.displayMode === 'kanban' ? 'kanban' : 'table');

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

    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [moduleName, hydratedFor, activeView?.id, search, sortBy, sortDir, page, pageSize, filter]);

  /** The URL to come back to — handed to every record link and the New button. */
  const returnTo = `/${moduleName}${searchParams.toString() ? `?${searchParams}` : ''}`;

  /**
   * Owner defaults to whoever is adding the record. Status and stage come from
   * their picklist defaults, which the server also applies — set here so the
   * form shows them rather than revealing them after the save.
   */
  const quickCreateDefaults = useMemo(
    () => (user ? { owner_id: user.id } : {}),
    [user?.id],
  );

  const groupByField = displayMode === 'kanban'
    ? (activeView?.groupBy ?? meta?.pipelineField ?? undefined)
    : undefined;

  const query: ListQuery = useMemo(() => ({
    view: activeView?.id,
    page,
    pageSize: displayMode === 'kanban' ? 200 : pageSize,
    search: search || undefined,
    filter: countConditions(filter) ? filter : undefined,
    sortBy, sortDir,
    columns: columns.length ? columns : undefined,
    groupBy: groupByField,
  }), [activeView?.id, page, pageSize, search, filter, sortBy, sortDir, columns, groupByField, displayMode]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['records', moduleName, query],
    queryFn: () => api.list(moduleName!, query),
    enabled: Boolean(moduleName && meta),
    placeholderData: (prev) => prev,
  });

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
      displayMode,
      filter: countConditions(filter) ? filter : { logic: 'AND', conditions: [] },
    }),
    onSuccess: () => {
      toast.success(`Saved to “${activeView?.name}”`, 'This tab will open this way from now on.');
      void queryClient.invalidateQueries({ queryKey: ['views', moduleName] });
    },
    onError: (err: Error) => toast.error('Could not save this view', err.message),
  });

  const stageMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: Record<string, unknown> }) =>
      api.update(moduleName!, id, values),
    onSuccess: (_res, vars) => {
      invalidateRecordQueries(queryClient, moduleName, vars.id);
    },
    onError: (err: Error) => toast.error('Could not move the record', err.message),
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

  const visibleColumns = columns.length ? columns : defaultColumns(meta);
  const fieldMap = new Map(meta.fields.map((f) => [f.name, f]));
  const canCreate = meta.permissions.create;
  // A fixed-layout table still shrinks its columns to fit a narrow container,
  // which would quietly undo a drag. Declaring the sum as a minimum makes the
  // body scroll instead.
  const tableMinWidth = SELECT_COL_WIDTH
    + visibleColumns.reduce((sum, col) => sum + colWidths.widthOf(col, fieldMap.get(col)), 0);
  const moveColumn = (from: string, to: string): void => {
    if (from === to) return;
    setColumns((previous) => {
      const next = [...(previous.length ? previous : visibleColumns)];
      const fromIndex = next.indexOf(from);
      const toIndex = next.indexOf(to);
      if (fromIndex < 0 || toIndex < 0) return previous;
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, from);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-y border-slate-200 bg-slate-50/90 px-3 py-2 shadow-sm dark:border-slate-800 dark:bg-slate-950/70 sm:px-4">
        {/*
          No title bar.

          The module name is already in the sidebar, in the tab title and in the
          URL, and a 9mm-tall heading repeating it cost a row of records on every
          screen in the office. The toolbar starts at the left edge instead and
          the record count rides along with the search box, which is where
          somebody actually looks for it.

          The heading itself stays for screen readers and for the page's
          document outline — removing the only h1 from a route is a real
          regression, just not a visible one.
        */}
        <h1 className="sr-only">{meta.label}</h1>
        {/*
          One row, not two. The view tabs used to sit on a line of their own
          under the toolbar, which cost another row of records on every screen.
          They take the left of this row and scroll within it; everything that
          acts on the list is grouped on the right, with the search box beside
          the Filter button it belongs with.
        */}
        {/*
          Wraps on a phone.

          On one line the saved-view tabs, the search box, Filter, the two view
          toggles, the column control and New come to more than a 360dp screen
          holds — so New was clipped at the right edge with nothing to scroll
          and no way to reach it. The shell is `overflow-hidden`, so the
          overflow did not even produce a scrollbar to hint at what was missing.

          Wrapping rather than scrolling, deliberately: a horizontally scrolling
          strip would put the primary action off-screen by default, which is the
          same problem wearing a different hat.
        */}
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <Dropdown
            align="left"
            className="min-w-[18rem]"
            trigger={(
              <button className="btn-secondary btn-sm max-w-[14rem]" aria-label="Choose or manage list views">
                <Filter className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{activeView?.name ?? `All ${meta.label}`}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </button>
            )}
          >
            {(close) => (
              <>
                <p className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-muted">List views</p>
                {/*
                  Every view carries its pencil, the two built-in ones included.

                  They used to be the only two anybody could not edit, which is
                  backwards — they are the two everybody lives in. Editing one
                  now saves your own version of it rather than reshaping the
                  row the whole team reads (migration 135), so there is nothing
                  left to protect by hiding the pencil.
                */}
                <div className="max-h-64 overflow-y-auto py-1">
                  {(views ?? []).map((view) => {
                    const mine = view.ownerId === user?.id || user?.isAdmin;
                    const canEdit = view.isSystem || mine;
                    return (
                      <div key={view.id} className="flex items-center px-1">
                        <DropdownItem onClick={() => { chooseView(view.id); close(); }}>
                          <span className="min-w-0 flex-1 truncate">{view.name}</span>
                          {view.isOverride && (
                            <span className="shrink-0 text-2xs text-muted" title="Your own version of this view">edited</span>
                          )}
                          {view.id === activeView?.id && <span className="shrink-0 text-brand-600">Current</span>}
                        </DropdownItem>
                        {canEdit && (
                          <button className="btn-ghost shrink-0 p-1.5" title={view.isSystem ? 'Edit — saved as your own version' : 'Edit view'} aria-label={`Edit ${view.name}`} onClick={(e) => { e.stopPropagation(); setEditingView(view as SavedView); close(); }}>
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-slate-100 py-1 dark:border-slate-800">
                  <DropdownItem icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { setEditingView(blankView(moduleName)); close(); }}>
                    New view
                  </DropdownItem>
                  {/* Only a view somebody made can be deleted. The two built-in
                      ones are reset instead, from inside the editor. */}
                  {activeView && !activeView.isSystem && (activeView.ownerId === user?.id || user?.isAdmin) && (
                    <DropdownItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => { setConfirmDeleteView(activeView); close(); }}>
                      Delete this view
                    </DropdownItem>
                  )}
                </div>
              </>
            )}
          </Dropdown>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden shrink-0 text-xs text-muted tnum xl:inline">
              {isFetching && !data
                ? 'Loading…'
                : `${(data?.total ?? 0).toLocaleString('en-IN')} records`}
            </span>

            {/*
              The open box takes its own width in the row rather than floating
              over what is to its left.

              It was `absolute` inside an 8×8 box, so opening it drew a 16rem
              panel across the neighbours — and the neighbour on that side is
              the record count, which is the number somebody opens a search to
              compare against. Laying it out in the flow costs the row a little
              width, which is what the wrap is for, and nothing is hidden.
            */}
            <div className={cn('relative h-8 transition-[width]', searchOpen ? 'w-44 lg:w-60' : 'w-8')}>
            {searchOpen ? (
              <div className="absolute inset-y-0 right-0 z-30 w-full">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  data-testid="list-search"
                  autoFocus
                  className="input w-full py-1.5 pl-8 pr-7 text-sm"
                  placeholder={`Search ${meta.label.toLowerCase()}…`}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                <button className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close list search" onClick={() => { setSearchOpen(false); setSearchInput(''); }}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button className="btn-secondary btn-sm px-2" aria-label={`Search ${meta.label}`} onClick={() => setSearchOpen(true)} title={`Search ${meta.label}`}>
                <Search className="h-3.5 w-3.5" />
              </button>
            )}
            </div>

            <button
              onClick={() => setShowFilters(true)}
              className={cn('btn-secondary btn-sm', countConditions(filter) > 0 && 'border-brand-400 text-brand-700 dark:text-brand-300')}
            >
              <Filter className="h-3.5 w-3.5" />
              Filter
              {countConditions(filter) > 0 && (
                <span className="rounded-full bg-brand-600 px-1.5 text-2xs text-white">{countConditions(filter)}</span>
              )}
            </button>

            <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
              <button
                onClick={() => setDisplayMode('table')}
                className={cn('px-2 py-1.5', displayMode === 'table' ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800')}
                title="Table"
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setDisplayMode('kanban')}
                disabled={!meta.pipelineField && !activeView?.groupBy}
                className={cn(
                  'px-2 py-1.5 disabled:opacity-30',
                  displayMode === 'kanban' ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
                title={meta.pipelineField ? 'Kanban' : 'This module has no pipeline field'}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </div>

            <Dropdown
              trigger={<button className="btn-secondary btn-sm" aria-label="List options"><Settings2 className="h-3.5 w-3.5" /></button>}
            >
              {(close) => (
                <>
                  <DropdownItem icon={<Columns3 className="h-3.5 w-3.5" />} onClick={() => { setShowColumns(true); close(); }}>
                    Choose columns
                  </DropdownItem>
                  {colWidths.customised && (
                    <DropdownItem
                      icon={<Ruler className="h-3.5 w-3.5" />}
                      onClick={() => { colWidths.resetAll(); close(); }}
                    >
                      Reset column widths
                    </DropdownItem>
                  )}
                  {activeView && (
                    <DropdownItem
                      icon={<Save className="h-3.5 w-3.5" />}
                      onClick={() => { saveViewMutation.mutate(); close(); }}
                    >
                      Save this layout to “{activeView.name}”
                    </DropdownItem>
                  )}
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

            {displayMode === 'table' && (data?.total ?? 0) > 0 && (
              <div className="hidden items-center gap-1 rounded-lg border border-slate-200 px-1.5 py-1 text-xs text-muted lg:flex dark:border-slate-700">
                <button className="btn-ghost p-0.5" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-3.5 w-3.5" /></button>
                <label className="flex items-center gap-1 whitespace-nowrap"><input className="h-5 w-10 rounded border border-slate-200 bg-white px-1 text-center text-xs dark:border-slate-700 dark:bg-slate-900" aria-label="Go to page" type="number" min={1} max={data!.totalPages} value={page} onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} onChange={(e) => { const next = Number(e.target.value); if (Number.isInteger(next) && next >= 1 && next <= data!.totalPages) setPage(next); }} /><span>/ {data!.totalPages}</span></label>
                <button className="btn-ghost p-0.5" aria-label="Next page" disabled={page >= data!.totalPages} onClick={() => setPage((p) => Math.min(data!.totalPages, p + 1))}><ChevronRight className="h-3.5 w-3.5" /></button>
              </div>
            )}

          </div>
        </div>

      </div>

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
                <MassOwnerButton
                  module={moduleName}
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
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && !data ? (
          <div className="space-y-2 p-4 sm:p-6">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ModuleIcon name={meta.icon} className="h-10 w-10" />}
            title={search || countConditions(filter) ? 'No matching records' : `No ${meta.label.toLowerCase()} yet`}
            body={search || countConditions(filter)
              ? 'Try adjusting your search or filters.'
              : `Create your first ${meta.singularLabel.toLowerCase()} to get started.`}
            action={canCreate && !search && !countConditions(filter)
              ? <button className="btn-primary btn-sm" onClick={() => setShowQuickCreate(true)}>
                  <Plus className="h-3.5 w-3.5" /> New {meta.singularLabel}
                </button>
              : undefined}
          />
        ) : displayMode === 'kanban' ? (
          <KanbanBoard
            module={meta}
            rows={rows}
            groups={data?.groups ?? []}
            groupBy={groupByField!}
            attentionIds={unseen}
            onMove={(id, value) => stageMutation.mutate({ id, values: { [groupByField!]: value } })}
          />
        ) : (
          <>
          {/* Phones get stacked cards instead of the table: a 7-column grid on a
              375px screen is a horizontal-scroll maze, and the first column
              (the record's name) scrolls out of view the moment you look at any
              other field. Same rows, same inline editing — just re-laid out.

              The cut-over is `lg`, not `md`. Seven columns plus a 240px sidebar
              need about 1100px; at 768–1023 the table appeared and then scrolled
              in both axes at once, inside a region already scrolling vertically.
              That band is not a rarity — it is a laptop at a scaled resolution
              and a window snapped to half a screen. */}
          {/* The test id is the stable handle. The mobile specs used to select
              this by its `md:hidden` class, so moving the breakpoint broke
              three of them — a Tailwind utility is a layout decision, not an
              identifier. */}
          <div data-testid="record-card-list" className="divide-y divide-slate-100 lg:hidden dark:divide-slate-800">
            {rows.map((row) => (
              <MobileRecordCard
                key={row.id}
                row={row}
                module={meta}
                columns={visibleColumns}
                fieldMap={fieldMap}
                selected={selected.has(row.id)}
                isNew={unseen.has(row.id)}
                isStarred={Boolean(row.starred)}
                onToggleSelect={(checked) => {
                  const next = new Set(selected);
                  if (checked) next.add(row.id); else next.delete(row.id);
                  // Unchecking one row narrows "all in this view" back to the page.
                  setSelectedAll(false);
                  setSelected(next);
                }}
                onOpen={() => openRecord(`/${moduleName}/${row.id}?return=${encodeURIComponent(returnTo)}`)}
                onSaved={() => invalidateRecordQueries(queryClient, moduleName, row.id)}
              />
            ))}
          </div>

          {/* `table-fixed` is what makes the drag-to-resize below real: with an
              auto layout the browser re-measures every cell on each pointermove
              and the columns fight the width you just set. The trade is that
              each column needs a declared width, which the <colgroup> supplies
              — a stored one if this user has dragged it, otherwise a default
              derived from the field type. The table can now be wider than the
              viewport, so the body scrolls horizontally, as it did on Vtiger. */}
          <table className="hidden w-full table-fixed border-collapse lg:table" style={{ minWidth: tableMinWidth }}>
            <colgroup>
              <col style={{ width: SELECT_COL_WIDTH }} />
              {visibleColumns.map((col) => (
                <col key={col} style={{ width: colWidths.widthOf(col, fieldMap.get(col)) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="list-head w-12 px-0 text-center">
                  <input
                    type="checkbox"
                    aria-label={`Select all ${meta.label.toLowerCase()} on this page`}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={(e) => {
                      setSelectedAll(false);
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set());
                    }}
                  />
                </th>
                {visibleColumns.map((col) => {
                  const field = fieldMap.get(col);
                  const canSort = field?.config.sortable !== false;
                  return (
                    <th key={col} draggable onDragStart={(e) => { setDragColumn(col); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', col); }} onDragEnd={() => setDragColumn(null)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (dragColumn) moveColumn(dragColumn, col); setDragColumn(null); }} className={cn('list-head relative cursor-grab active:cursor-grabbing', dragColumn === col && 'opacity-50')}>
                      <button
                        className="inline-flex max-w-full items-center gap-1 truncate hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:text-slate-200"
                        disabled={!canSort}
                        title={canSort ? `Sort by ${field?.label ?? col}` : 'Sorting is disabled for this field'}
                        onClick={() => {
                          if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
                          else { setSortBy(col); setSortDir('desc'); }
                        }}
                      >
                        <span className="truncate">{field?.label ?? col}</span>
                        {canSort && sortBy === col
                          ? <ChevronDown className={cn('h-3 w-3 shrink-0', sortDir === 'asc' && 'rotate-180')} />
                          : canSort ? <ArrowUpDown className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-40" /> : null}
                      </button>
                      {/* Drag to resize, double-click to put it back. `role` and
                          the arrow keys are here because a column width is a
                          real setting and a pointer is not the only way in. */}
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${field?.label ?? col}`}
                        // A *focusable* separator is a widget, and axe rates a
                        // widget missing its value as critical — the arrow keys
                        // below are what make it one. The numbers are real
                        // pixels, so a screen reader announces the width it is
                        // actually changing rather than a percentage of nothing.
                        aria-valuenow={colWidths.widthOf(col, field)}
                        aria-valuemin={MIN_WIDTH}
                        aria-valuemax={MAX_WIDTH}
                        tabIndex={0}
                        className={cn('col-resizer', colWidths.resizing === col && 'col-resizer-active')}
                        onPointerDown={(e) => colWidths.beginResize(col, colWidths.widthOf(col, field), e)}
                        onDoubleClick={(e) => { e.stopPropagation(); colWidths.resetColumn(col); }}
                        onKeyDown={(e) => {
                          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                          e.preventDefault();
                          colWidths.nudge(col, colWidths.widthOf(col, field), e.key === 'ArrowLeft' ? -16 : 16);
                        }}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((row) => {
                const isNew = unseen.has(row.id);
                return (
                <tr
                  key={row.id}
                  className={cn(
                    // Striping, hover and selection all live in .list-row
                    // (styles.css) so they layer in a predictable order.
                    'list-row group cursor-pointer transition-colors',
                    selected.has(row.id) && 'list-row-selected',
                    // A new record is marked by weight, not by a coloured
                    // sheet: tinting the row fought the zebra stripe, and on a
                    // list where most rows are new it stopped meaning anything.
                    // Starred keeps its tint — that one is rare by nature.
                    row.starred && 'bg-amber-50/80 dark:bg-amber-950/25',
                  )}
                  onClick={() => openRecord(`/${moduleName}/${row.id}?return=${encodeURIComponent(returnTo)}`)}
                >
                  {/*
                    The select column is not a text cell.

                    `.list-cell` is 14px of padding each side plus
                    `text-overflow: ellipsis`; the checkbox is 14px and the
                    column is 40. Three pixels over, so every row in the CRM
                    drew a "…" next to its checkbox — reported as mystery dots
                    at the start of each row, and that is exactly what they
                    were. It matches its own <th> now: no side padding, centred,
                    nothing to truncate.
                  */}
                  <td className="list-cell-select" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.label}`}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                      checked={selected.has(row.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(row.id); else next.delete(row.id);
                        setSelectedAll(false);
                        setSelected(next);
                      }}
                    />
                  </td>
                  {visibleColumns.map((col, ci) => {
                    const field = fieldMap.get(col);
                    if (!field) {
                      return <td key={col} className="list-cell text-muted">—</td>;
                    }
                    return (
                      <td
                        key={col}
                        className={cn(
                          'list-cell',
                          ci === 0 && 'font-medium text-slate-900 dark:text-slate-100',
                          // Unread weight, like an inbox — and now the *only*
                          // marker for it. Applied to the whole row rather than
                          // the name alone so the row reads as one unit.
                          isNew && 'font-bold text-slate-900 dark:text-white',
                        )}
                      >
                        {ci === 0 && row.starred && (
                          <Star
                            className="mr-1.5 inline-block h-3.5 w-3.5 fill-amber-400 text-amber-500 align-middle"
                            aria-label="Favourite"
                          />
                        )}
                        {ci === 0 && isNew && (
                          <span
                            className="mr-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600 align-middle dark:bg-brand-400"
                            title="New — you haven’t opened this yet"
                          />
                        )}
                        {meta.permissions.edit && isInlineEditable(field, 'list') ? (
                          <EditableField
                            surface="list"
                            module={moduleName}
                            recordId={row.id}
                            field={field}
                            value={row.values[col]}
                            display={row.display?.[col]}
                            compact
                            siblings={row.values}
                            restrictTo={restrictionForField(meta.picklistDependencies, row.values, field.name)}
                            linkTo={field.uitype === 'reference' ? row.display?.[`${col}__module`] : undefined}
                            onSaved={() => invalidateRecordQueries(queryClient, moduleName, row.id)}
                          />
                        ) : (
                          <FieldValue
                            field={field}
                            value={row.values[col]}
                            display={row.display?.[col]}
                            compact
                            linkTo={field.uitype === 'reference' ? row.display?.[`${col}__module`] : undefined}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
                );
              })}
            </tbody>
          </table>
          </>
        )}
      </div>

      {/* Pagination */}
      {displayMode === 'table' && (data?.total ?? 0) > 0 && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-2 lg:hidden dark:border-slate-800 dark:bg-slate-900 sm:px-6">
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
                value={page}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (Number.isInteger(next) && next >= 1 && next <= data!.totalPages) setPage(next);
                }}
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
      <Modal
        open={showFilters}
        onClose={() => setShowFilters(false)}
        title={`Filter ${meta.label}`}
        size="lg"
        footer={
          <>
            <button className="btn-ghost" onClick={() => { setFilter(EMPTY_FILTER); setPage(1); }}>Clear all</button>
            <button className="btn-primary" onClick={() => { setShowFilters(false); setPage(1); }}>Apply</button>
          </>
        }
      >
        <FilterBuilder module={meta} value={filter} onChange={setFilter} />
      </Modal>

      <Modal
        open={showColumns}
        onClose={() => setShowColumns(false)}
        title="Choose columns"
        size="md"
        footer={
          <>
            {activeView && (
              <button
                className="btn-secondary"
                disabled={saveViewMutation.isPending}
                onClick={() => saveViewMutation.mutate()}
              >
                {saveViewMutation.isPending ? <Spinner /> : <Save className="h-3.5 w-3.5" />}
                Save to “{activeView.name}”
              </button>
            )}
            <button className="btn-primary" onClick={() => setShowColumns(false)}>Done</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {meta.fields
            .filter((f) => f.isActive && f.displayType !== 'hidden')
            .map((f) => {
              const active = visibleColumns.includes(f.name);
              return (
                <label
                  key={f.name}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition-colors',
                    active
                      ? 'border-brand-300 bg-brand-50 dark:border-brand-800 dark:bg-brand-950/50'
                      : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300"
                    checked={active}
                    onChange={() => {
                      setColumns(active
                        ? visibleColumns.filter((c) => c !== f.name)
                        : [...visibleColumns, f.name]);
                    }}
                  />
                  <span className="truncate">{f.label}</span>
                </label>
              );
            })}
        </div>
      </Modal>

      <ExportWizard
        open={showExport}
        onClose={() => setShowExport(false)}
        module={moduleName}
        fields={meta.fields}
        filter={filter}
        selectedIds={selectedAll ? undefined : selected.size ? [...selected] : undefined}
        allSelected={selectedAll}
      />

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

      {/* Press and hold a card to see it without leaving the list — see
          lib/pressPreview.ts. Rendered here rather than inside the card so one
          dialog exists at a time regardless of how many rows are on screen. */}
      <RecordPeek
        row={rows.find((r) => r.id === peekId) ?? null}
        module={meta}
        columns={visibleColumns}
        fieldMap={fieldMap}
        isNew={peekId ? unseen.has(peekId) : false}
        isStarred={Boolean(rows.find((r) => r.id === peekId)?.starred)}
        onOpen={() => {
          const id = peekId;
          setPeekId(null);
          if (id) openRecord(`/${moduleName}/${id}?return=${encodeURIComponent(returnTo)}`);
        }}
        onClose={() => setPeekId(null)}
      />

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

/**
 * One record as a phone-sized card. The first visible column is the record's
 * identity, so it becomes the heading and is the tap target for opening the
 * record; the rest render as label/value rows and stay inline-editable exactly
 * as they are in the table. Empty values are dropped rather than shown as "—",
 * because a column that is blank for most rows is just noise once it is a
 * stacked row instead of a narrow column.
 */
function MobileRecordCard({
  row, module, columns, fieldMap, selected, isNew, isStarred, onToggleSelect, onOpen, onSaved,
}: {
  row: RecordEnvelope;
  module: ModuleMeta & { permissions: { edit: boolean }; picklistDependencies: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[] };
  columns: string[];
  fieldMap: Map<string, FieldMeta>;
  selected: boolean;
  /** needs attention — New pipeline stage for leads, unread-style elsewhere */
  isNew: boolean;
  /** explicitly favourited by this user — stays gold until unstarred */
  isStarred: boolean;
  onToggleSelect: (checked: boolean) => void;
  onOpen: () => void;
  onSaved: () => void;
}): JSX.Element {
  /*
    WhatsApp-shaped, because that is the list a rep already reads all day:
    name, number under it, the type at the right edge, status and follow-up
    below. The owner asked for exactly this and for the long-press peek to go —
    swipe right calls, swipe left opens WhatsApp, Gmail-style, with the action
    armed only once the card has travelled far enough to be deliberate.

    The fixed layout is for the contact module (leads); anything else keeps the
    generic card, because a property has no phone to call.
  */
  const isContact = module.name === 'leads';
  const phone = toInternational(
    String(row.values.country_code ?? 'India'),
    String(row.values.mobile ?? ''),
  );

  const swipe = useSwipeActions((side: SwipeSide) => {
    if (!isContact || !phone) return;
    if (side === 'right') {
      dial(phone);
    } else {
      void openExternal(`https://wa.me/${phone.replace(/[^\d+]/g, '')}`);
    }
  }, isContact && Boolean(phone));

  if (!isContact) {
    return (
      <div
        data-record-card={row.id}
        className={cn(
          'px-4 py-3 [-webkit-touch-callout:none]',
          isStarred
            ? 'bg-amber-50/80 dark:bg-amber-950/25'
            : 'bg-white dark:bg-slate-900',
        )}
      >
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300"
            checked={selected}
            onChange={(e) => onToggleSelect(e.target.checked)}
            aria-label="Select record"
          />
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            <p className={cn('truncate text-slate-900 dark:text-slate-100', isNew ? 'font-bold' : 'font-medium')}>
              {isStarred && <Star className="mr-1.5 inline-block h-3.5 w-3.5 fill-amber-400 text-amber-500 align-middle" aria-label="Favourite" />}
              {isNew && (
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-600 align-middle dark:bg-brand-400"
                  title="New — you haven’t opened this yet"
                />
              )}
              {row.label}
            </p>
            {row.recordNumber && (
              <p className="mt-0.5 font-mono text-2xs text-muted">{row.recordNumber}</p>
            )}
          </button>
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
        </div>

        <ContactDetails
          row={row}
          module={module}
          columns={columns}
          fieldMap={fieldMap}
          onSaved={onSaved}
        />
      </div>
    );
  }

  const statusValue = String(row.values.status ?? '');
  const statusDisplay = row.display?.status ?? statusValue;

  return (
    /*
      The swipe surface is the outer row: the coloured action sits behind the
      card, the card slides over it with the finger, and touch scrolling still
      works because the hook locks to whichever axis moved first.
    */
    <div
      data-record-card={row.id}
      className="relative overflow-hidden [-webkit-touch-callout:none]"
    >
      {/* The two action backgrounds. Only the armed one is fully opaque; the
          other fades with travel so the reveal reads as "where am I going"
          rather than a flash of colour. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 flex items-center justify-start bg-emerald-600 pl-6 text-white transition-opacity',
          swipe.state.armed === 'left' ? 'opacity-100' : 'opacity-0',
        )}
      >
        <MessageCircle className="h-5 w-5" />
      </div>
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 flex items-center justify-end bg-blue-600 pr-6 text-white transition-opacity',
          swipe.state.armed === 'right' ? 'opacity-100' : 'opacity-0',
        )}
      >
        <Phone className="h-5 w-5" />
      </div>

      <div
        {...swipe.handlers}
        style={{ transform: `translateX(${swipe.state.dx}px)` }}
        className={cn(
          'relative bg-white py-3 pl-4 pr-3 transition-transform dark:bg-slate-900',
          swipe.state.dx === 0 && 'transition-transform',
          isStarred && 'bg-amber-50/80 dark:bg-amber-950/25',
        )}
      >
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1.5 h-4 w-4 shrink-0 rounded border-slate-300"
            checked={selected}
            onChange={(e) => onToggleSelect(e.target.checked)}
            aria-label="Select record"
          />
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            <p className={cn('truncate text-slate-900 dark:text-slate-100', isNew ? 'font-bold' : 'font-medium')}>
              {isStarred && <Star className="mr-1.5 inline-block h-3.5 w-3.5 fill-amber-400 text-amber-500 align-middle" aria-label="Favourite" />}
              {isNew && (
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-600 align-middle dark:bg-brand-400"
                  title="New — you haven’t opened this yet"
                />
              )}
              {row.label}
            </p>
            {phone && (
              <p className="mt-0.5 tnum text-xs text-muted">{phone}</p>
            )}
          </button>
          {/* Contact type at the right edge — the one thing the owner asked
              to see without opening the record. */}
          {row.display?.contact_type && (
            <Badge className="mt-0.5 shrink-0" color="#64748b">{String(row.display.contact_type)}</Badge>
          )}
        </div>

        <div className="mt-1.5 flex items-center gap-2 pl-7 text-xs">
          {statusDisplay && (
            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-2xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {String(statusDisplay)}
            </span>
          )}
          {row.values.next_followup_at ? (
            <span className="truncate text-muted">
              Follow-up {new Date(String(row.values.next_followup_at)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The generic detail rows for non-contact modules — the previous card body. */
function ContactDetails({
  row, module, columns, fieldMap, onSaved,
}: {
  row: RecordEnvelope;
  module: ModuleMeta & { permissions: { edit: boolean }; picklistDependencies: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[] };
  columns: string[];
  fieldMap: Map<string, FieldMeta>;
  onSaved: () => void;
}): JSX.Element {
  const titleFields = new Set(module.labelFields ?? []);
  const detailCols = columns.filter((c) => {
    if (titleFields.has(c)) return false;
    const field = fieldMap.get(c);
    if (!field || field.uitype === 'autonumber') return false;
    const v = row.values[c];
    return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
  });

  if (!detailCols.length) return <></>;

  return (
    <dl className="mt-2.5 space-y-1.5 pl-7">
      {detailCols.map((col) => {
        const field = fieldMap.get(col)!;
        return (
          <div key={col} className="flex items-start gap-2 text-xs">
            <dt className="w-28 shrink-0 truncate text-muted">{field.label}</dt>
            <dd className="min-w-0 flex-1">
              {module.permissions.edit && isInlineEditable(field, 'list') ? (
                <EditableField
                        surface="list"
                  module={module.name}
                  recordId={row.id}
                  field={field}
                  value={row.values[col]}
                  display={row.display?.[col]}
                  compact
                  siblings={row.values}
                  restrictTo={restrictionForField(module.picklistDependencies, row.values, field.name)}
                  linkTo={field.uitype === 'reference' ? row.display?.[`${col}__module`] : undefined}
                  onSaved={onSaved}
                />
              ) : (
                <FieldValue
                  field={field}
                  value={row.values[col]}
                  display={row.display?.[col]}
                  compact
                  linkTo={field.uitype === 'reference' ? row.display?.[`${col}__module`] : undefined}
                />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function KanbanBoard({
  module, rows, groups, groupBy, attentionIds, onMove,
}: {
  module: { fields: FieldMeta[]; name: string; singularLabel: string; permissions: { edit: boolean } };
  rows: RecordEnvelope[];
  groups: { key: string; label: string; color?: string | null; count: number; sum?: number }[];
  groupBy: string;
  attentionIds: Set<string>;
  onMove: (id: string, value: string) => void;
}): JSX.Element {
  const navigate = useNavigate();
  // Same rule as the table: a kanban card opens where the list stays put.
  const openInNewTab = useApp((st) => st.user?.ui?.openInNewTab ?? true);
  const openRecord = (path: string): void => {
    if (openInNewTab) window.open(path, '_blank', 'noopener,noreferrer');
    else navigate(path);
  };
  const queryClient = useQueryClient();
  const [dragging, setDragging] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const ownerField = assignmentField(module.fields);

  const field = module.fields.find((f) => f.name === groupBy);
  const columns = groups.length
    ? groups
    : (field?.options ?? []).map((o) => ({ key: o.value, label: o.label, color: o.color, count: 0, sum: 0 }));

  const byGroup = new Map<string, RecordEnvelope[]>();
  for (const row of rows) {
    const key = String(row.values[groupBy] ?? '');
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(row);
  }

  // The first currency field becomes the column total — deal value, unit price.
  const amountField = module.fields.find((f) => f.uitype === 'currency');

  /**
   * The number on the card.
   *
   * A pipeline card had the budget on it, which on a lead desk is blank far
   * more often than it is filled — and a blank currency is not blank, it is
   * "₹0", printed on every card in every column. Zero rupees is not a fact
   * about the lead; it is the absence of one, and it crowded out the only
   * thing anybody actually wants from a card they are looking at in order to
   * decide who to ring next.
   *
   * Found by uitype, not by name, because the engine must not know that leads
   * call it `mobile` — see CLAUDE.md's rule about per-module branching.
   */
  const phoneField = module.fields.find((f) => f.uitype === 'phone' && f.isActive);
  const codeFieldName = phoneField?.config.digitsFrom
    ? String(phoneField.config.digitsFrom)
    : null;
  /** The code to paint in front when there is no country field to read one from. */
  const codePrefix = String(phoneField?.config.codePrefix ?? '');

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-4">
      {columns.map((col) => {
        const items = byGroup.get(col.key) ?? [];
        return (
          <div
            key={col.key}
            className={cn(
              'flex w-64 shrink-0 flex-col rounded-xl border bg-slate-100/60 transition-colors dark:bg-slate-900/60 sm:w-72',
              overColumn === col.key
                ? 'border-brand-400 bg-brand-50 dark:border-brand-700 dark:bg-brand-950/40'
                : 'border-slate-200 dark:border-slate-800',
            )}
            onDragOver={(e) => { e.preventDefault(); setOverColumn(col.key); }}
            onDragLeave={() => setOverColumn(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOverColumn(null);
              if (dragging) { onMove(dragging, col.key); setDragging(null); }
            }}
          >
            <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-slate-800">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: col.color ?? '#94a3b8' }} />
              <span className="truncate text-sm font-medium">{col.label}</span>
              <span className="ml-auto shrink-0 rounded-full bg-white px-1.5 text-2xs font-semibold tnum dark:bg-slate-800">
                {col.count}
              </span>
            </div>

            {amountField && (col.sum ?? 0) > 0 && (
              <div className="border-b border-slate-200 px-3 py-1.5 text-2xs font-medium text-muted tnum dark:border-slate-800">
                {formatIndianPrice(col.sum!)}
              </div>
            )}

            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {items.map((row) => (
                <div
                  key={row.id}
                  draggable
                  onDragStart={() => setDragging(row.id)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => openRecord(`/${module.name}/${row.id}`)}
                  className={cn(
                    'cursor-pointer rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm transition-all hover:shadow-md dark:border-slate-700 dark:bg-slate-800',
                    row.starred && 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30',
                    !row.starred && attentionIds.has(row.id) && 'border-brand-300 bg-brand-50/70 dark:border-brand-800 dark:bg-brand-950/30',
                    dragging === row.id && 'opacity-40',
                  )}
                >
                  <p className={cn('truncate text-sm', attentionIds.has(row.id) ? 'font-semibold' : 'font-medium')}>
                    {row.starred && <Star className="mr-1 inline-block h-3.5 w-3.5 fill-amber-400 text-amber-500 align-middle" aria-label="Favourite" />}
                    {attentionIds.has(row.id) && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-brand-500 align-middle" title="Needs attention" />}
                    {row.label}
                  </p>
                  {phoneField && row.values[phoneField.name] ? (
                    <a
                      href={`tel:${[
                        codeFieldName ? row.values[codeFieldName] ?? codePrefix : codePrefix,
                        row.values[phoneField.name],
                      ].join('')}`}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1 block text-xs text-slate-600 tnum hover:underline dark:text-slate-400"
                    >
                      {formatPhoneWithCode(
                        codeFieldName ? String(row.values[codeFieldName] ?? codePrefix) : codePrefix,
                        String(row.values[phoneField.name]),
                      )}
                    </a>
                  ) : null}
                  {/* Money only when there is some. */}
                  {amountField && Number(row.values[amountField.name]) > 0 && (
                    <p className="mt-1 text-xs font-semibold text-slate-700 tnum dark:text-slate-300">
                      {formatIndianPrice(Number(row.values[amountField.name]))}
                    </p>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {ownerField && (
                      <span className="truncate text-2xs text-muted" onClick={(e) => e.stopPropagation()}>
                        {module.permissions.edit && isInlineEditable(ownerField, 'list') ? (
                          <EditableField
                            surface="list"
                            module={module.name}
                            recordId={row.id}
                            field={ownerField}
                            value={row.values.owner_id}
                            display={row.display?.owner_id}
                            compact
                            onSaved={() => invalidateRecordQueries(queryClient, module.name, row.id)}
                          />
                        ) : (
                          <FieldValue field={ownerField} value={row.values.owner_id} display={row.display?.owner_id} compact />
                        )}
                      </span>
                    )}
                    {/* Coloured from the rating the server already worked out,
                        not by re-deciding here what Hot means. The two numbers
                        that used to live in this line are also in the scoring
                        engine, so an admin raising the Hot threshold moved the
                        word and left this badge on the old boundary.

                        The colour comes from the dropdown too. It used to be
                        three literals here, and they did not match the ones the
                        admin had actually chosen: Hot was red everywhere in the
                        CRM and green in this one badge. Worse, changing it in
                        Admin → Dropdowns had no effect here at all. */}
                  </div>
                </div>
              ))}
              {items.length === 0 && (
                <p className="py-6 text-center text-2xs text-muted">Drop here</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}


function ExportWizard({ open, onClose, module, fields, filter, selectedIds, allSelected }: {
  open: boolean; onClose: () => void; module: string; fields: FieldMeta[]; filter: FilterGroup; selectedIds?: string[]; allSelected: boolean;
}): JSX.Element {
  const available = fields.filter((f) => f.isActive && f.displayType !== 'hidden' && f.config.exportable !== false);
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

function MassOwnerButton({
  module, ids, allQuery, allCount, onDone,
}: {
  module: string;
  ids: string[];
  /** Set when "select all in this view" is on — the action then runs on the whole result set. */
  allQuery: ListQuery | null;
  allCount: number;
  onDone: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [ownerId, setOwnerId] = useState('');
  // Exactly the people the server will accept as a target — see the
  // assignableOnly note on GET /admin/users.
  const { data: users } = useQuery({ queryKey: ['users', 'assignable'], queryFn: () => api.users(false, false, true) });
  const [busy, setBusy] = useState(false);
  const countLabel = allQuery ? allCount.toLocaleString('en-IN') : String(ids.length);

  return (
    <>
      <button className="btn-secondary btn-sm" onClick={() => setOpen(true)}>
        <Users className="h-3.5 w-3.5" /> Reassign
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Reassign ${countLabel} record${countLabel === '1' ? '' : 's'}`}
        size="sm"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!ownerId || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = allQuery
                    ? await api.transferAll(module, allQuery as unknown as Record<string, unknown>, ownerId)
                    : await api.transfer(module, ids, ownerId);
                  toast.success(`${result.transferred.toLocaleString('en-IN')} records reassigned`);
                  setOpen(false);
                  onDone();
                } catch (err) {
                  toast.error('Reassign failed', (err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <Spinner />} Reassign
            </button>
          </>
        }
      >
        <label className="label">Assign to</label>
        <Select
          value={ownerId}
          onChange={setOwnerId}
          placeholder="— Select a user —"
          options={(users ?? []).map((u) => ({
            value: String((u as { id: string }).id),
            label: String((u as { fullName: string }).fullName),
          }))}
        />
      </Modal>
    </>
  );
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
      && f.massEditable
      // Reassignment has its own button, and that is the one that enforces
      // who a record may be handed to. Offering it here as a plain field
      // edit would route the same write around that check.
      && f.uitype !== 'owner'),
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
