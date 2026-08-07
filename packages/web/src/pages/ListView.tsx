import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FieldMeta, FilterGroup, ListQuery, RecordEnvelope } from '@ipropy/shared';
import { formatIndianPrice } from '@ipropy/shared';
import {
  ArrowUpDown, ChevronDown, ChevronLeft, ChevronRight, Columns3, Download, Filter,
  LayoutGrid, List, Plus, RefreshCw, Search, Settings2, Sparkles, Trash2, Upload, Users, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { invalidateRecordQueries } from '../lib/invalidate';
import { saveListNav } from '../lib/listNav';
import { cn } from '../lib/utils';
import { FieldValue, isQuickEditable, QuickEditField } from '../components/FieldRenderer';
import { FilterBuilder, countConditions } from '../components/FilterBuilder';
import {
  Badge, ConfirmDialog, Dropdown, DropdownItem, EmptyState, Modal, Select, Skeleton, Spinner,
} from '../components/ui';
import { ModuleIcon } from '../components/Layout';
import RecordForm from '../components/RecordForm';

const EMPTY_FILTER: FilterGroup = { logic: 'AND', conditions: [] };

export default function ListView(): JSX.Element {
  const { module: moduleName } = useParams<{ module: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { moduleByName } = useApp();
  const summary = moduleByName(moduleName ?? '');

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [viewId, setViewId] = useState<string | undefined>(searchParams.get('view') ?? undefined);
  const [filter, setFilter] = useState<FilterGroup>(EMPTY_FILTER);
  const [sortBy, setSortBy] = useState<string | undefined>();
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [displayMode, setDisplayMode] = useState<'table' | 'kanban'>('table');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [columns, setColumns] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset per-module state when navigating between modules. A `filter` query
  // param (dashboard drill-through) seeds the filter builder directly, so
  // clicking a chart segment lands on exactly those records rather than the
  // whole module.
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
    setPage(1); setSearch(''); setSearchInput(''); setFilter(seeded);
    setSelected(new Set()); setSortBy(undefined); setColumns([]);
    setViewId(searchParams.get('view') ?? undefined);
    // The seeded filter is already applied to the list — don't pop the filter
    // panel open on arrival (dashboard drill-through lands on the records).
    setShowFilters(false);
  }, [moduleName]);

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName!),
    enabled: Boolean(moduleName),
  });

  const { data: views } = useQuery({
    queryKey: ['views', moduleName],
    queryFn: () => api.views(moduleName!, true),
    enabled: Boolean(moduleName),
  });

  const activeView = views?.find((v) => v.id === viewId) ?? views?.find((v) => v.isDefault) ?? views?.[0];

  // Adopt the selected view's columns, sort and display mode.
  useEffect(() => {
    if (!activeView) return;
    setColumns(activeView.columns?.length ? activeView.columns : defaultColumns(meta));
    setSortBy(activeView.sortBy ?? undefined);
    setSortDir(activeView.sortDir ?? 'desc');
    setDisplayMode(activeView.displayMode === 'kanban' ? 'kanban' : 'table');
  }, [activeView?.id, meta?.id]);

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

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['records', moduleName, query],
    queryFn: () => api.list(moduleName!, query),
    enabled: Boolean(moduleName && meta),
    placeholderData: (prev) => prev,
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: string[]) => api.massDelete(moduleName!, ids),
    onSuccess: (result) => {
      toast.success(`${result.deleted} record${result.deleted === 1 ? '' : 's'} deleted`);
      setSelected(new Set());
      invalidateRecordQueries(queryClient, moduleName);
    },
    onError: (err: Error) => toast.error('Delete failed', err.message),
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

  if (!moduleName) return <div />;

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
  const rows = data?.rows ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg"
              style={{ backgroundColor: `${meta.color}18`, color: meta.color }}
            >
              <ModuleIcon name={meta.icon} className="h-4.5 w-4.5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold leading-tight tracking-tight">{meta.label}</h1>
              <p className="text-xs text-slate-500 tnum">
                {isFetching && !data ? 'Loading…' : `${(data?.total ?? 0).toLocaleString('en-IN')} records`}
              </p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                className="input w-40 py-1.5 pl-8 text-sm sm:w-48"
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
              trigger={<button className="btn-secondary btn-sm"><Settings2 className="h-3.5 w-3.5" /></button>}
            >
              {(close) => (
                <>
                  <DropdownItem icon={<Columns3 className="h-3.5 w-3.5" />} onClick={() => { setShowColumns(true); close(); }}>
                    Choose columns
                  </DropdownItem>
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

            {canCreate && (
              <button onClick={() => setShowQuickCreate(true)} className="btn-primary btn-sm">
                <Plus className="h-3.5 w-3.5" />
                New {meta.singularLabel}
              </button>
            )}
          </div>
        </div>

        {/* View tabs */}
        {views && views.length > 0 && (
          <div className="mt-2.5 flex items-center gap-1 overflow-x-auto pb-0.5">
            {views.map((v) => (
              <button
                key={v.id}
                onClick={() => {
                  setViewId(v.id);
                  setPage(1);
                  setSearchParams({ view: v.id }, { replace: true });
                }}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  activeView?.id === v.id
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
                )}
              >
                {v.name}
                {v.count !== undefined && (
                  <span className={cn(
                    'rounded-full px-1.5 text-2xs tnum',
                    activeView?.id === v.id ? 'bg-white/20' : 'bg-slate-200 dark:bg-slate-700',
                  )}>
                    {v.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-b border-brand-200 bg-brand-50 px-4 py-2 dark:border-brand-900 dark:bg-brand-950/50 sm:px-6">
          <span className="text-sm font-medium text-brand-800 dark:text-brand-200">
            {selected.size} selected
          </span>
          <div className="ml-auto flex gap-2">
            <button className="btn-secondary btn-sm" onClick={() => setSelected(new Set())}>
              <X className="h-3.5 w-3.5" /> Clear
            </button>
            {meta.permissions.edit && (
              <MassOwnerButton module={moduleName} ids={[...selected]} onDone={() => { setSelected(new Set()); void refetch(); }} />
            )}
            {meta.permissions.delete && (
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
            onMove={(id, value) => stageMutation.mutate({ id, values: { [groupByField!]: value } })}
          />
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="table-head w-10">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                  />
                </th>
                {visibleColumns.map((col) => {
                  const field = fieldMap.get(col);
                  return (
                    <th key={col} className="table-head">
                      <button
                        className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
                        onClick={() => {
                          if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
                          else { setSortBy(col); setSortDir('desc'); }
                        }}
                      >
                        {field?.label ?? col}
                        {sortBy === col
                          ? <ChevronDown className={cn('h-3 w-3', sortDir === 'asc' && 'rotate-180')} />
                          : <ArrowUpDown className="h-2.5 w-2.5 opacity-0 group-hover:opacity-40" />}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="group cursor-pointer bg-white transition-colors hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800/60"
                  onClick={() => navigate(`/${moduleName}/${row.id}`)}
                >
                  <td className="table-cell" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300"
                      checked={selected.has(row.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(row.id); else next.delete(row.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                  {visibleColumns.map((col, ci) => {
                    const field = fieldMap.get(col);
                    if (!field) {
                      return <td key={col} className="table-cell text-slate-400">—</td>;
                    }
                    return (
                      <td key={col} className={cn('table-cell', ci === 0 && 'font-medium text-slate-900 dark:text-slate-100')}>
                        {isQuickEditable(field) ? (
                          <QuickEditField
                            module={moduleName}
                            recordId={row.id}
                            field={field}
                            value={row.values[col]}
                            display={row.display?.[col]}
                            compact
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
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {displayMode === 'table' && (data?.totalPages ?? 1) > 1 && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
          <p className="text-xs text-slate-500 tnum">
            {((data!.page - 1) * data!.pageSize + 1).toLocaleString('en-IN')}–
            {Math.min(data!.page * data!.pageSize, data!.total).toLocaleString('en-IN')} of {data!.total.toLocaleString('en-IN')}
          </p>
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost p-1.5 disabled:opacity-30"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-2 text-xs text-slate-600 tnum dark:text-slate-400">
              {data!.page} / {data!.totalPages}
            </span>
            <button
              className="btn-ghost p-1.5 disabled:opacity-30"
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
        footer={<button className="btn-primary" onClick={() => setShowColumns(false)}>Done</button>}
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
            onSaved={(record) => {
              setShowQuickCreate(false);
              toast.success(`${meta.singularLabel} created`, record.label);
              void refetch();
              navigate(`/${moduleName}/${record.id}`);
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

function defaultColumns(meta: { fields: { name: string; isActive: boolean; displayType: string }[] } | undefined): string[] {
  if (!meta) return [];
  return meta.fields
    .filter((f) => f.isActive && f.displayType !== 'hidden')
    .slice(0, 7)
    .map((f) => f.name);
}

function KanbanBoard({
  module, rows, groups, groupBy, onMove,
}: {
  module: { fields: FieldMeta[]; name: string; singularLabel: string };
  rows: RecordEnvelope[];
  groups: { key: string; label: string; color?: string | null; count: number; sum?: number }[];
  groupBy: string;
  onMove: (id: string, value: string) => void;
}): JSX.Element {
  const navigate = useNavigate();
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
  const titleField = module.fields.find((f) => ['string'].includes(f.uitype));

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
              <div className="border-b border-slate-200 px-3 py-1.5 text-2xs font-medium text-slate-500 tnum dark:border-slate-800">
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
                  onClick={() => navigate(`/${module.name}/${row.id}`)}
                  className={cn(
                    'cursor-pointer rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm transition-all hover:shadow-md dark:border-slate-700 dark:bg-slate-800',
                    dragging === row.id && 'opacity-40',
                  )}
                >
                  <p className="truncate text-sm font-medium">{row.label}</p>
                  {amountField && row.values[amountField.name] != null && (
                    <p className="mt-1 text-xs font-semibold text-slate-700 tnum dark:text-slate-300">
                      {formatIndianPrice(Number(row.values[amountField.name]))}
                    </p>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {ownerField && (
                      <span className="truncate text-2xs text-slate-500">
                        <QuickEditField
                          module={module.name}
                          recordId={row.id}
                          field={ownerField}
                          value={row.values.owner_id}
                          display={row.display?.owner_id}
                          compact
                          onSaved={() => invalidateRecordQueries(queryClient, module.name, row.id)}
                        />
                      </span>
                    )}
                    {typeof row.values.ai_score === 'number' && (
                      <Badge color={row.values.ai_score >= 70 ? '#22c55e' : row.values.ai_score >= 45 ? '#f59e0b' : '#94a3b8'}>
                        {row.values.ai_score}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
              {items.length === 0 && (
                <p className="py-6 text-center text-2xs text-slate-400">Drop here</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MassOwnerButton({
  module, ids, onDone,
}: { module: string; ids: string[]; onDone: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [ownerId, setOwnerId] = useState('');
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api.users() });
  const [busy, setBusy] = useState(false);

  return (
    <>
      <button className="btn-secondary btn-sm" onClick={() => setOpen(true)}>
        <Users className="h-3.5 w-3.5" /> Reassign
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Reassign ${ids.length} record${ids.length === 1 ? '' : 's'}`}
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
                  const result = await api.transfer(module, ids, ownerId);
                  toast.success(`${result.transferred} records reassigned`);
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
