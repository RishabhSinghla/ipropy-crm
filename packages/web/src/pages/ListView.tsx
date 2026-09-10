import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FieldMeta, type FilterGroup, formatIndianPrice, formatPhoneWithCode, toInternational, type ListQuery, type ModuleMeta, type RecordEnvelope } from '@ipropy/shared';
import {
  ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, CloudOff, Columns3, Compass, Download, Filter,
  LayoutGrid, List, MailCheck, MapPin, MessageCircle, Pencil, Phone, Plus, RefreshCw, Ruler, Save, Search, Settings2, Star, Trash2, Upload, Users, X,
} from 'lucide-react';
import { ApiError, api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { invalidateRecordQueries } from '../lib/invalidate';
import { saveListNav } from '../lib/listNav';
import { cn, restrictionForField } from '../lib/utils';
import { FieldInput, FieldValue } from '../components/FieldRenderer';
import { EditableField, isInlineEditable } from '../components/EditableField';
import { FilterBuilder, countConditions } from '../components/FilterBuilder';
import {
  Badge, ConfirmDialog, Dropdown, DropdownItem, EmptyState, Modal, Select, Skeleton, Spinner,
} from '../components/ui';
import { ModuleIcon } from '../components/Layout';
import RecordForm from '../components/RecordForm';
import RecordPeek from '../components/RecordPeek';
import { useSwipeActions, type SwipeSide } from '../lib/swipeActions';
import { MAX_WIDTH, MIN_WIDTH, SELECT_COL_WIDTH, useColumnWidths } from '../lib/columnWidths';
import { useOfflineList, useOfflineMeta } from '../lib/useOfflineList';

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
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
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
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  const activeView = views?.find((v) => v.id === viewId) ?? views?.find((v) => v.isDefault) ?? views?.[0];

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
    const previous = adoptedView.current;
    adoptedView.current = activeView.id;

    setColumns(activeView.columns?.length ? activeView.columns : defaultColumns(meta));
    setDisplayMode(activeView.displayMode === 'kanban' ? 'kanban' : 'table');

    // Same view, later render — metadata arriving is not a view change.
    if (previous === activeView.id) return;
    // Arriving on a link that names its own sort: the link wins.
    if (previous === null && urlNamedSort.current) return;

    setSortBy(activeView.sortBy ?? undefined);
    setSortDir(activeView.sortDir ?? 'desc');
  }, [activeView?.id, meta?.id]);

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
    if (countConditions(filter)) next.set('filter', JSON.stringify(filter));

    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [moduleName, hydratedFor, activeView?.id, search, sortBy, sortDir, page, filter]);

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
    pageSize: displayMode === 'kanban' ? 200 : 25,
    search: search || undefined,
    filter: countConditions(filter) ? filter : undefined,
    sortBy, sortDir,
    columns: columns.length ? columns : undefined,
    groupBy: groupByField,
  }), [activeView?.id, page, search, filter, sortBy, sortDir, columns, groupByField, displayMode]);

  const { data, isLoading, isFetching, failureCount, refetch } = useQuery({
    queryKey: ['records', moduleName, query],
    queryFn: () => api.list(moduleName!, query),
    enabled: Boolean(moduleName && meta),
    placeholderData: (prev) => prev,
  });

    // `failureCount`, not `isError`: react-query retries three times with backoff
  // before it calls a query failed, and somebody holding a phone in a basement
  // should not watch a spinner for seven seconds first. The first failed
  // attempt is enough to know the server is not answering.
  const offline = useOfflineList(moduleName, query, data, user?.id, failureCount > 0);

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

  // Which rows need attention. Leads remain highlighted while their pipeline
  // status is New; other modules use unread-style state. Asked for separately rather than returned by
  // the list, because the list endpoint is shared with exports and
  // the portal, none of which have a reader to be unread for.
  const pageIds = useMemo(() => (data?.rows ?? []).map((r) => r.id), [data]);
  const { data: unseenData } = useQuery({
    queryKey: ['unseen', moduleName, pageIds],
    queryFn: () => api.unseen(moduleName!, pageIds),
    enabled: Boolean(moduleName) && pageIds.length > 0,
    // Always refetch on mount: opening a record marks it seen, and coming
    // straight back to a cached "still unread" answer is the one moment the
    // highlight is visibly wrong. The query is a single indexed lookup over
    // one page of ids, so this is cheap.
    refetchOnMount: 'always',
    staleTime: 0,
  });
  const unseen = useMemo(() => new Set(unseenData?.unseen ?? []), [unseenData]);

  const markAllSeen = async (): Promise<void> => {
    if (!moduleName) return;
    await api.markModuleSeen(moduleName);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['unseen', moduleName] }),
      queryClient.invalidateQueries({ queryKey: ['unseen-counts'] }),
    ]);
  };

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
  const rows = offline.rows;
  // A fixed-layout table still shrinks its columns to fit a narrow container,
  // which would quietly undo a drag. Declaring the sum as a minimum makes the
  // body scroll instead.
  const tableMinWidth = SELECT_COL_WIDTH
    + visibleColumns.reduce((sum, col) => sum + colWidths.widthOf(col, fieldMap.get(col)), 0);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900 sm:px-4">
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
        <div className="flex items-center gap-2">
          <ViewTabStrip
            views={views ?? []}
            activeId={activeView?.id}
            onPick={(id) => {
              if (id === activeView?.id) return;
              // A view *is* a filter. Carrying an ad-hoc one across the switch
              // leaves the new tab quietly narrowed by conditions belonging to
              // the tab you just left. The URL is written by the sync effect
              // above — writing it here as well is how the two disagreed.
              setViewId(id);
              setPage(1);
              setFilter(EMPTY_FILTER);
              setSearch('');
              setSearchInput('');
              setSelected(new Set());
            }}
          />

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden shrink-0 text-xs text-muted tnum xl:inline">
              {isFetching && !data && !offline.stale
                ? 'Loading…'
                : `${(data?.total ?? (offline.stale ? offline.rows.length : 0)).toLocaleString('en-IN')} records`}
            </span>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                // The stable handle. The placeholder is built from the module's
                // label, which an admin renames — "Leads & Contacts" became
                // "Contacts" and every spec selecting on `/search leads/i` then
                // waited out its full timeout instead of failing fast. Same
                // lesson as `record-card-list`: a label is content, not an
                // identifier.
                data-testid="list-search"
                className="input w-36 py-1.5 pl-8 text-sm lg:w-52"
                placeholder={`Search ${meta.label.toLowerCase()}…`}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
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
                      onClick={() => { window.open(api.exportUrl(moduleName, query), '_blank'); close(); }}
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

            {moduleName !== 'leads' && unseen.size > 0 && (
              <button
                onClick={() => void markAllSeen()}
                className="btn-ghost btn-sm text-brand-600 dark:text-brand-400"
                title="Clear the highlight on records you haven’t opened"
              >
                <MailCheck className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Mark all as seen</span>
              </button>
            )}

            {canCreate && (
              // Same reason as `list-search` above: the label is the admin's
              // word for the record, so "New Lead" became "New Contact".
              // Properties gets a split button — the second action is the
              // gate-side capture screen, so it lives where "add a property"
              // already lives rather than as a separate tab competing with it.
              moduleName === 'properties' ? (
                <div className="inline-flex" data-testid="list-create">
                  <button
                    onClick={() => setShowQuickCreate(true)}
                    className="btn-primary btn-sm rounded-r-none focus:z-10"
                    title={`New ${meta.singularLabel}`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New {meta.singularLabel}
                  </button>
                  <Dropdown
                    align="right"
                    trigger={(
                      <button
                        className="btn-primary btn-sm rounded-l-none border-l border-l-white/30 px-2 focus:z-10"
                        aria-label={`More ways to add a ${meta.singularLabel.toLowerCase()}`}
                        title="More ways to add"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    )}
                  >
                    {(close) => (
                      <>
                        <Link
                          to={`/${moduleName}/new`}
                          onClick={close}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Full page form
                        </Link>
                        <Link
                          to="/capture"
                          onClick={close}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <MapPin className="h-3.5 w-3.5" />
                          Capture on site
                        </Link>
                      </>
                    )}
                  </Dropdown>
                </div>
              ) : (
                <button data-testid="list-create" onClick={() => setShowQuickCreate(true)} className="btn-primary btn-sm">
                  <Plus className="h-3.5 w-3.5" />
                  New {meta.singularLabel}
                </button>
              )
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

      {offline.stale && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:mx-6 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <CloudOff className="h-3.5 w-3.5 shrink-0" />
          <span>Can&rsquo;t reach the CRM — this is what was here at {offline.asOf}. Read only until it is back.</span>
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
                <th className="list-head">
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
                  return (
                    <th key={col} className="list-head relative">
                      <button
                        className="inline-flex max-w-full items-center gap-1 truncate hover:text-slate-700 dark:hover:text-slate-200"
                        onClick={() => {
                          if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
                          else { setSortBy(col); setSortDir('desc'); }
                        }}
                      >
                        <span className="truncate">{field?.label ?? col}</span>
                        {sortBy === col
                          ? <ChevronDown className={cn('h-3 w-3 shrink-0', sortDir === 'asc' && 'rotate-180')} />
                          : <ArrowUpDown className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-40" />}
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
                  <td className="list-cell" onClick={(e) => e.stopPropagation()}>
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
      {displayMode === 'table' && (data?.totalPages ?? 1) > 1 && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
          <p className="text-xs text-muted tnum">
            {((data!.page - 1) * data!.pageSize + 1).toLocaleString('en-IN')}–
            {Math.min(data!.page * data!.pageSize, data!.total).toLocaleString('en-IN')} of {data!.total.toLocaleString('en-IN')}
          </p>
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost p-1.5 disabled:opacity-30"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-2 text-xs tnum text-muted">
              {data!.page} / {data!.totalPages}
            </span>
            <button
              className="btn-ghost p-1.5 disabled:opacity-30"
              aria-label="Next page"
              disabled={page >= (data?.totalPages ?? 1)}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Modals */}
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
function defaultColumns(meta: {
  labelFields?: string[];
  fields: { name: string; isActive: boolean; displayType: string }[];
} | undefined): string[] {
  if (!meta) return [];
  const usable = meta.fields.filter((f) => f.isActive && f.displayType !== 'hidden');
  const identity = (meta.labelFields ?? []).filter((name) => usable.some((f) => f.name === name));
  const rest = usable.map((f) => f.name).filter((name) => !identity.includes(name));
  return [...identity, ...rest].slice(0, 7);
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
      window.location.href = `tel:${phone.replace(/[^\d+]/g, '')}`;
    } else {
      window.open(`https://wa.me/${phone.replace(/[^\d+]/g, '')}`, '_blank', 'noopener');
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
  const ownerField = module.fields.find((f) => f.name === 'owner_id');

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

/**
 * The saved-view tabs, on the toolbar row and able to hold any number of them.
 *
 * A plain `overflow-x-auto` strip is fine with six tabs and useless with
 * twenty: on a trackpad you can flick it, with a mouse there is nothing to
 * grab, and either way there is no sign that anything is off-screen. So the
 * arrows appear only when the strip actually overflows, and each one scrolls
 * by most of a screenful rather than a fixed pixel count.
 *
 * `scrollWidth > clientWidth` is re-measured on scroll, on resize, on font
 * load, and when the view list changes — a tab added by an admin can push it
 * over the edge without the window moving at all. The arrow buttons always
 * occupy their slot so the tab row never jumps sideways when overflow appears
 * or disappears mid-session; each button dims and leaves the tab order when
 * there is nothing to scroll to in its direction.
 */
function ViewTabStrip({
  views, activeId, onPick,
}: {
  views: { id: string; name: string; count?: number }[];
  activeId: string | undefined;
  onPick: (id: string) => void;
}): JSX.Element | null {
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = (): void => {
    const el = strip.current;
    if (!el) return;
    setOverflow({
      left: el.scrollLeft > 4,
      // The -4 absorbs sub-pixel widths, which otherwise leave the right arrow
      // enabled for ever at the end of the strip.
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  };

  useEffect(() => {
    measure();
    const el = strip.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The strip's own width tracks the window, but its scrollWidth also grows
    // when webfonts swap in after first paint — without this the arrows can
    // stay hidden on exactly the tab counts (8–10) where the fallback font
    // happened to fit. One re-measure after fonts settle covers it, and the
    // initial `measure()` already covers the font-blocked case.
    let fontsDone = false;
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(() => { if (!fontsDone) measure(); }).catch(() => undefined);
    }
    const onResize = (): void => measure();
    window.addEventListener('resize', onResize);
    return () => {
      fontsDone = true;
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [views.length]);

  // Keep the selected tab in sight when the view changes from elsewhere — a
  // dashboard drill-through can land on a tab that is scrolled out of view.
  useEffect(() => {
    strip.current?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  if (!views.length) return null;

  const nudge = (direction: -1 | 1): void => {
    const el = strip.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.8), behavior: 'smooth' });
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {/*
        Always in the layout, never always active. Conditionally *removing*
        the arrow buttons moved every tab a few pixels each time overflow
        appeared or cleared — on Contacts the strip sits near that boundary,
        so switching tabs visibly shoved the row sideways. `invisible` keeps
        the slot; `aria-disabled` + `tabIndex={-1}` keeps it out of the tab
        order and honest to assistive tech.
      */}
      <button
        type="button"
        onClick={() => nudge(-1)}
        disabled={!overflow.left}
        aria-disabled={!overflow.left}
        tabIndex={overflow.left ? 0 : -1}
        className={cn(
          'shrink-0 rounded p-0.5 transition-opacity',
          overflow.left
            ? 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            : 'invisible',
        )}
        aria-label="Scroll views left"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      <div
        ref={strip}
        onScroll={measure}
        role="tablist"
        aria-label="Saved views"
        // `scrollbar-none` is not available here, so the bar is simply thin and
        // below the row; hiding it entirely would remove the only affordance a
        // touch user has.
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scroll-smooth py-0.5"
      >
        {views.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={activeId === v.id}
            data-active={activeId === v.id}
            onClick={() => onPick(v.id)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
              activeId === v.id
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
            )}
          >
            {v.name}
            {v.count !== undefined && (
              <span className={cn(
                'rounded-full px-1.5 text-2xs tnum',
                activeId === v.id ? 'bg-white/20' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
              )}>
                {v.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => nudge(1)}
        disabled={!overflow.right}
        aria-disabled={!overflow.right}
        tabIndex={overflow.right ? 0 : -1}
        className={cn(
          'shrink-0 rounded p-0.5 transition-opacity',
          overflow.right
            ? 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            : 'invisible',
        )}
        aria-label="Scroll views right"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
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
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.users() });
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
        <label className="label">New owner</label>
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
  const [busy, setBusy] = useState(false);
  const countLabel = allQuery ? allCount.toLocaleString('en-IN') : String(ids.length);

  const editable = useMemo(
    () => Array.from(fieldMap.values()).filter((f) =>
      f.isActive
      && f.displayType !== 'hidden' && f.displayType !== 'detail_only'
      && f.displayType !== 'readonly' && f.displayType !== 'create_only'
      && !f.isReadonly
      && f.massEditable
      && f.name !== 'owner_id'),
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
                  const payload = { [field.name]: value };
                  const result = allQuery
                    ? await api.massUpdateAll(module, allQuery as unknown as Record<string, unknown>, payload)
                    : await api.massUpdate(module, ids, payload);
                  const ok = result.updated ?? 0;
                  const failed = (result.failed as unknown[] | undefined)?.length ?? 0;
                  toast.success(
                    `${ok.toLocaleString('en-IN')} record${ok === 1 ? '' : 's'} updated`,
                    failed ? `${failed} could not be updated — they were left unchanged.` : undefined,
                  );
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
              onChange={(v) => { setFieldName(v); setValue(emptyValue(fieldMap.get(v))); }}
              placeholder="— Choose a field —"
              options={editable.map((f) => ({ value: f.name, label: f.label }))}
            />
          </div>
          {field && (
            <div>
              <label className="label">{field.label}</label>
              <FieldInput
                field={field}
                value={value}
                onChange={(v) => setValue(v)}
                onChangeOther={(_, v) => setValue(v)}
                formValues={{ [field.name]: value }}
                moduleName={module}
              />
              <p className="mt-1 text-2xs text-muted">
                Every selected record gets this value. Records where the field is
                hidden or read-only for the acting user are left unchanged.
              </p>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
