import { useEffect, useRef, useState, type JSX, type ReactNode, type Ref } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Dashboard, type DashboardWidget, type FilterGroup, type FilterOperator, formatIndianPrice, relativeTime } from '@ipropy/shared';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import GridLayout, { useContainerWidth, type EventCallback, type Layout, type LayoutItem } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import {
  ArrowDownRight, ArrowUpRight, Check, ChevronDown, Copy, LayoutDashboard, MoreHorizontal,
  Pencil, Plus, Sparkles, Star, TrendingUp, Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { tintedTextVars } from '../lib/color';
import { cn, renderMarkdown } from '../lib/utils';
import { Badge, ConfirmDialog, Dropdown, DropdownItem, EmptyState, Modal, ScoreChip, Skeleton, Spinner } from '../components/ui';
import WidgetBuilder from '../components/WidgetBuilder';
import { PeekLink } from '../components/PeekLink';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#0ea5e9', '#a855f7', '#14b8a6', '#f97316', '#64748b', '#ef4444'];

export default function DashboardPage(): JSX.Element {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useApp();
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const { data: dashboards } = useQuery({ queryKey: ['dashboards'], queryFn: () => api.dashboards() });

  // Two dashboards can legitimately be flagged default at once — a personal one
  // and the team's shared one, since making a dashboard your landing page must
  // not move everyone else's. The viewer's own choice wins.
  const activeId = id
    ?? dashboards?.find((d) => d.isDefault && !d.isShared && d.ownerId === user?.id)?.id
    ?? dashboards?.find((d) => d.isDefault)?.id
    ?? dashboards?.[0]?.id;

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ['dashboard', activeId],
    queryFn: () => api.dashboard(activeId!),
    enabled: Boolean(activeId),
  });

  const [editing, setEditing] = useState(false);
  const [builderFor, setBuilderFor] = useState<DashboardWidget | null | undefined>(undefined);
  const [manage, setManage] = useState<ManageMode>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
    if (activeId) void queryClient.invalidateQueries({ queryKey: ['dashboard', activeId] });
  };

  const removeWidget = async (widget: DashboardWidget): Promise<void> => {
    if (!dashboard) return;
    try {
      await api.deleteWidget(dashboard.id, widget.id);
      toast.success(`Removed “${widget.title}”`);
      refresh();
    } catch (err) {
      toast.error('Could not remove the widget', (err as Error).message);
    }
  };

  const deleteDashboard = async (): Promise<void> => {
    if (!dashboard) return;
    await api.deleteDashboard(dashboard.id);
    toast.success(`Deleted “${dashboard.name}”`);
    setConfirmDelete(false);
    void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
    navigate('/dashboard');
  };

  const duplicate = async (): Promise<void> => {
    if (!dashboard) return;
    try {
      const { id: newId } = await api.duplicateDashboard(dashboard.id);
      toast.success('Copied — this one is yours to change');
      await queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      navigate(`/dashboard/${newId}`);
    } catch (err) {
      toast.error('Could not duplicate', (err as Error).message);
    }
  };

  const makeDefault = async (): Promise<void> => {
    if (!dashboard) return;
    try {
      await api.updateDashboard(dashboard.id, { isDefault: true });
      toast.success(`“${dashboard.name}” is now the landing dashboard`);
      refresh();
    } catch (err) {
      toast.error('Could not set the default', (err as Error).message);
    }
  };

  return (
    <div className="p-4 sm:p-6">
      <DigestBanner />
      {/* Above everything, because it is only here at all when the CRM is not
          yet somebody's working day, and under the charts is where a new
          person never scrolls. */}
      <div className="mb-4">
      </div>

      {/* Title and controls stack on a phone. Sharing one flex row meant a
          name like "Collections & Finance" wrapped *behind* the button group,
          and in edit mode the third button pushed the title apart entirely. */}
      <div className="mb-4 mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{dashboard?.name ?? 'Dashboard'}</h1>
          {dashboard?.description && (
            <p className="text-sm text-muted">{dashboard.description}</p>
          )}
          {dashboard?.canEdit && isDesktop && (
            <p className="mt-0.5 text-2xs text-muted">
              {editing
                ? 'Editing — hover a widget to change or remove it. Drag to rearrange, pull the corner to resize.'
                : 'Drag widgets to rearrange · pull the corner handle to resize'}
            </p>
          )}
        </div>

        <div className="-mx-1 flex shrink-0 items-center gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
          <Dropdown
            align="left"
            trigger={
              <button className="btn-secondary btn-sm">
                <LayoutDashboard className="h-3.5 w-3.5" />
                {dashboards && dashboards.length > 1 ? 'Switch' : 'Dashboards'}
                <ChevronDown className="h-3 w-3" />
              </button>
            }
          >
            {(close) => (
              <>
                {(dashboards ?? []).map((d) => (
                  <DropdownItem
                    key={d.id}
                    icon={d.id === activeId ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
                    onClick={() => { navigate(`/dashboard/${d.id}`); close(); }}
                  >
                    <span className="flex items-center gap-1.5">
                      {d.name}
                      {d.isDefault && <Badge>Default</Badge>}
                      {d.isShared && <Badge color="#0ea5e9">Shared</Badge>}
                    </span>
                  </DropdownItem>
                ))}
                <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
                <DropdownItem icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { setManage({ kind: 'create' }); close(); }}>
                  New dashboard
                </DropdownItem>
              </>
            )}
          </Dropdown>

          {dashboard?.canEdit && (
            <button
              className={cn('btn-sm', editing ? 'btn-primary' : 'btn-secondary')}
              onClick={() => setEditing((v) => !v)}
            >
              <Pencil className="h-3.5 w-3.5" />
              {editing ? 'Done' : 'Customise'}
            </button>
          )}

          {dashboard && editing && (
            <button className="btn-primary btn-sm" onClick={() => setBuilderFor(null)}>
              <Plus className="h-3.5 w-3.5" /> Add widget
            </button>
          )}

          {dashboard && (
            <Dropdown
              trigger={<button className="btn-ghost p-2" aria-label="Dashboard actions"><MoreHorizontal className="h-4 w-4" /></button>}
            >
              {(close) => (
                <>
                  {dashboard.canEdit && (
                    <DropdownItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setManage({ kind: 'rename', dashboard }); close(); }}>
                      Rename &amp; describe
                    </DropdownItem>
                  )}
                  <DropdownItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => { void duplicate(); close(); }}>
                    Duplicate
                  </DropdownItem>
                  {!dashboard.isDefault && (
                    <DropdownItem icon={<Star className="h-3.5 w-3.5" />} onClick={() => { void makeDefault(); close(); }}>
                      Make this my landing page
                    </DropdownItem>
                  )}
                  {dashboard.canEdit && (
                    <DropdownItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={() => { setConfirmDelete(true); close(); }}>
                      Delete dashboard
                    </DropdownItem>
                  )}
                </>
              )}
            </Dropdown>
          )}
        </div>
      </div>

      {isLoading || !dashboard ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : dashboard.widgets.length === 0 ? (
        <EmptyState
          icon={<LayoutDashboard className="h-10 w-10" />}
          title="This dashboard is empty"
          body={dashboard.canEdit ? 'Add your first widget — a metric, a chart, a list, an embed or a note.' : undefined}
          action={dashboard.canEdit
            ? <button className="btn-primary btn-sm" onClick={() => { setEditing(true); setBuilderFor(null); }}><Plus className="h-3.5 w-3.5" /> Add widget</button>
            : undefined}
        />
      ) : isDesktop ? (
        <DashboardGrid
          key={dashboard.id}
          widgets={dashboard.widgets}
          canEdit={dashboard.canEdit}
          dashboardId={dashboard.id}
          editing={editing}
          onEditWidget={setBuilderFor}
          onRemoveWidget={(w) => void removeWidget(w)}
        />
      ) : (
        // Below `lg` the drag grid is replaced by a flow grid. Two columns, so
        // narrow tiles (metrics, gauges) pair up instead of eating a screen
        // each; anything wider than a quarter of the desktop grid still spans
        // the full width, where charts are readable.
        <div className="grid auto-rows-[minmax(0,auto)] grid-cols-2 gap-3 lg:grid-cols-12">
          {dashboard.widgets.map((widget) => (
            <div
              key={widget.id}
              className={cn(
                'min-w-0',
                widget.w <= 3 ? 'col-span-1' : 'col-span-2',
                widget.w <= 3 ? 'lg:col-span-3' :
                widget.w <= 4 ? 'lg:col-span-4' :
                widget.w <= 5 ? 'lg:col-span-5' :
                widget.w <= 6 ? 'lg:col-span-6' :
                widget.w <= 8 ? 'lg:col-span-8' : 'lg:col-span-12',
              )}
            >
              <WidgetFrame
                widget={widget}
                editing={editing && dashboard.canEdit}
                onEdit={() => setBuilderFor(widget)}
                onRemove={() => void removeWidget(widget)}
              />
            </div>
          ))}
        </div>
      )}

      {builderFor !== undefined && dashboard && (
        <WidgetBuilder
          dashboardId={dashboard.id}
          widget={builderFor}
          onClose={() => setBuilderFor(undefined)}
          onSaved={() => { setBuilderFor(undefined); refresh(); }}
        />
      )}

      {manage && (
        <DashboardSettingsModal
          mode={manage}
          onClose={() => setManage(null)}
          onSaved={(newId) => {
            setManage(null);
            void queryClient.invalidateQueries({ queryKey: ['dashboards'] });
            if (newId) navigate(`/dashboard/${newId}`);
            else refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={deleteDashboard}
        title={`Delete “${dashboard?.name ?? ''}”?`}
        body="The dashboard and its widgets are removed permanently. Records and reports are untouched."
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard create / rename
// ---------------------------------------------------------------------------

type ManageMode =
  | { kind: 'create' }
  | { kind: 'rename'; dashboard: Dashboard & { canEdit: boolean } }
  | null;

function DashboardSettingsModal({
  mode, onClose, onSaved,
}: {
  mode: NonNullable<ManageMode>;
  onClose: () => void;
  onSaved: (newId?: string) => void;
}): JSX.Element {
  const { user } = useApp();
  const existing = mode.kind === 'rename' ? mode.dashboard : null;
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [isShared, setIsShared] = useState(existing?.isShared ?? false);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (!name.trim()) { toast.error('Give the dashboard a name'); return; }
    setSaving(true);
    try {
      if (existing) {
        await api.updateDashboard(existing.id, { name: name.trim(), description, isShared });
        toast.success('Dashboard updated');
        onSaved();
      } else {
        const { id } = await api.createDashboard({ name: name.trim(), description, isShared });
        toast.success('Dashboard created — add your first widget');
        onSaved(id);
      }
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? 'Dashboard settings' : 'New dashboard'}
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
            {saving && <Spinner className="h-3 w-3" />}{existing ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Faridabad sales" autoFocus />
        </div>
        <div>
          <label className="label">Description</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this dashboard is for" />
        </div>
        {user?.isAdmin && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300"
              checked={isShared}
              onChange={(e) => setIsShared(e.target.checked)}
            />
            <span>
              Share with the whole team
              <span className="block text-2xs text-muted">
                Everyone sees it, but each person still only sees records they have access to.
              </span>
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** A widget plus its edit affordances, which only appear in Customise mode. */
function WidgetFrame({
  widget, editing, onEdit, onRemove,
}: {
  widget: DashboardWidget;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  if (!editing) return <Widget widget={widget} />;
  return (
    <div className="group relative h-full">
      {/* data-no-drag so clicking these does not start a grid drag. */}
      <div data-no-drag className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          onClick={onEdit}
          className="rounded-md border border-slate-200 bg-white/95 p-1.5 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900/95 dark:hover:bg-slate-800"
          aria-label={`Edit ${widget.title}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onRemove}
          className="rounded-md border border-slate-200 bg-white/95 p-1.5 text-negative shadow-sm hover:bg-red-50 dark:border-slate-700 dark:bg-slate-900/95 dark:hover:bg-red-950/40"
          aria-label={`Remove ${widget.title}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="h-full ring-1 ring-dashed ring-brand-300 dark:ring-brand-700">
        <Widget widget={widget} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag-to-move / drag-to-resize grid (desktop). Positions and sizes are the
// widget's own x/y/w/h from the layout, persisted through saveDashboardLayout
// after each drag or resize settles. Below lg the page falls back to the
// responsive auto-flow grid above.
// ---------------------------------------------------------------------------

const GRID_COLS = 12;
const GRID_ROW_H = 80;

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function DashboardGrid({ widgets, canEdit, dashboardId, editing, onEditWidget, onRemoveWidget }: {
  widgets: DashboardWidget[];
  canEdit: boolean;
  dashboardId: string;
  editing: boolean;
  onEditWidget: (widget: DashboardWidget) => void;
  onRemoveWidget: (widget: DashboardWidget) => void;
}): JSX.Element {
  const { width, containerRef, mounted } = useContainerWidth();
  const queryClient = useQueryClient();
  const [grid, setGrid] = useState<LayoutItem[]>(() =>
    widgets.map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 1, minH: 1 })),
  );

  const persist = (layout: Layout): void => {
    api.saveDashboardLayout(
      dashboardId,
      layout.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
    )
      .then(() => {
        // Refresh the cached layout so the mobile fallback and re-mounts see
        // the dragged positions, not the stale pre-drag snapshot.
        void queryClient.invalidateQueries({ queryKey: ['dashboard', dashboardId] });
        toast.success('Layout saved');
      })
      .catch((err) => toast.error('Could not save layout', (err as Error).message));
  };

  const stopDrag: EventCallback = (layout) => persist(layout);
  const stopResize: EventCallback = (layout) => persist(layout);

  return (
    <div ref={containerRef as Ref<HTMLDivElement>}>
      {mounted && (
        <GridLayout
          width={width}
          layout={grid}
          gridConfig={{ cols: GRID_COLS, rowHeight: GRID_ROW_H, margin: [12, 12] }}
          dragConfig={{ enabled: canEdit, cancel: 'a, button, input, select, textarea, [data-no-drag]' }}
          resizeConfig={{ enabled: canEdit }}
          onLayoutChange={(layout) => setGrid([...layout])}
          onDragStop={stopDrag}
          onResizeStop={stopResize}
        >
          {widgets.map((w) => (
            <div key={w.id} className="h-full min-w-0">
              <WidgetFrame
                widget={w}
                editing={editing && canEdit}
                onEdit={() => onEditWidget(w)}
                onRemove={() => onRemoveWidget(w)}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The dashboard's own load is fast; the digest behind this banner is a model
 * call and takes seconds. It used to hold a 96px skeleton and then render at
 * 429px, so the whole dashboard lurched a third of a screen downwards while
 * somebody was already reading it — the single biggest jump in the app, on the
 * page every session starts at.
 *
 * The card is now drawn immediately at close to its final height, with the
 * greeting and summary as placeholder lines and the four counters showing an
 * em dash until they arrive. Nothing moves when the text lands.
 */
function DigestBanner(): JSX.Element | null {
  const { user } = useApp();
  const { data, isLoading } = useQuery({ queryKey: ['digest'], queryFn: () => api.digest() });

  if (!isLoading && !data) return null;

  const stats = data?.stats ?? {};

  return (
    <div className="card overflow-hidden bg-gradient-to-br from-brand-600 to-brand-700 text-white">
      {/* The stat block used to be shrink-0, which on a phone squeezed the
          greeting into a three-word-tall column. Below `sm` it now sits under
          the greeting at full width instead of competing with it. */}
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:flex-wrap sm:items-start sm:gap-6 sm:p-5">
        {/* The floor stops a short digest from being *smaller* than the
            placeholder and jumping the other way. */}
        <div className="min-h-[9.5rem] min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Sparkles className={cn('h-4 w-4 text-brand-200', isLoading && 'animate-pulse')} />
            <h2 className="text-lg font-semibold">
              {data?.greeting || `Welcome back, ${user?.firstName}`}
            </h2>
          </div>

          {isLoading && (
            <div className="mt-2 max-w-2xl space-y-2" aria-label="Reading today’s numbers">
              <div className="h-3.5 w-full animate-pulse rounded bg-white/20" />
              <div className="h-3.5 w-11/12 animate-pulse rounded bg-white/20" />
              <div className="h-3.5 w-3/4 animate-pulse rounded bg-white/20" />
              <div className="mt-3 flex flex-wrap gap-2 pt-1">
                {[0, 1, 2, 3].map((i) => <div key={i} className="h-7 w-40 animate-pulse rounded-lg bg-white/10" />)}
              </div>
            </div>
          )}

          {data?.summary && (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-brand-50">{data.summary}</p>
          )}

          {data && data.priorities?.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {data.priorities.slice(0, 4).map((raw, i) => {
                const p = raw as { title: string; reason: string; recordId?: string; module?: string };
                const content = (
                  <span className="inline-flex max-w-xs items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs backdrop-blur transition-colors hover:bg-white/20">
                    <span className="truncate font-medium">{p.title}</span>
                  </span>
                );
                // The reason lives in a title attribute, which a phone has no
                // way to show — press and hold reaches the record itself,
                // which is the thing the reason was pointing at anyway.
                return p.recordId && p.module
                  ? (
                    <li key={i}>
                      <PeekLink module={p.module} id={p.recordId} label={p.title} title={p.reason}>
                        {content}
                      </PeekLink>
                    </li>
                  )
                  : <li key={i} title={p.reason}>{content}</li>;
              })}
            </ul>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-white/15 pt-3 sm:shrink-0 sm:grid-cols-4 sm:border-0 sm:pt-0">
          {[
            { label: 'Open leads', value: stats.openLeads },
            { label: 'Due today', value: stats.dueToday },
            { label: 'Overdue', value: stats.overdueFollowups },
            { label: 'Pipeline', value: stats.pipelineValue, currency: true },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-2xs uppercase tracking-wide text-brand-200">{s.label}</p>
              <p className="text-lg font-semibold tnum">
                {isLoading
                  ? '—'
                  : s.currency ? formatIndianPrice(Number(s.value ?? 0)) : (s.value ?? 0)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-through — every widget already knows the module/groupBy/filter it
// queried with (WidgetConfig), so clicking a bar, slice, funnel stage or
// stacked segment can jump to exactly those records instead of just the
// module's unfiltered list.
// ---------------------------------------------------------------------------

/** Combine the widget's own server-side filter with the clicked segment's condition. */
function withCondition(
  base: FilterGroup | undefined,
  field: string,
  operator: FilterOperator,
  value?: unknown,
  value2?: unknown,
): FilterGroup {
  const cond = { field, operator, value, value2 };
  return base?.conditions?.length ? { logic: 'AND', conditions: [base, cond] } : { logic: 'AND', conditions: [cond] };
}

function drillPath(module: string | undefined, filter?: FilterGroup): string | undefined {
  if (!module) return undefined;
  return filter ? `/${module}?filter=${encodeURIComponent(JSON.stringify(filter))}` : `/${module}`;
}

/** [start, end) for a date-truncated bucket like the ones runTimeSeries emits. */
function bucketRange(bucket: string, interval?: string): { start: string; end: string } {
  const start = new Date(`${bucket}T00:00:00`);
  const end = new Date(start);
  switch (interval) {
    case 'day': end.setDate(end.getDate() + 1); break;
    case 'week': end.setDate(end.getDate() + 7); break;
    case 'quarter': end.setMonth(end.getMonth() + 3); break;
    case 'year': end.setFullYear(end.getFullYear() + 1); break;
    default: end.setMonth(end.getMonth() + 1); // month
  }
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function Widget({ widget }: { widget: DashboardWidget }): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['widget', widget.id],
    queryFn: () => api.widgetData(widget.id),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="card p-4">
        <Skeleton className="mb-3 h-4 w-32" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-4">
        <p className="text-sm font-medium">{widget.title}</p>
        <p className="mt-2 text-xs text-negative">{(error as Error).message}</p>
      </div>
    );
  }

  const d = (data ?? {}) as Record<string, unknown>;

  switch (widget.type) {
    case 'metric':
      return <MetricCard widget={widget} data={d} />;
    case 'gauge':
      return <GaugeCard widget={widget} data={d} />;
    case 'bar':
    case 'leaderboard':
      return <BarCard widget={widget} data={d} horizontal={widget.type === 'leaderboard'} />;
    case 'line':
    case 'area':
      return <LineCard widget={widget} data={d} area={widget.type === 'area'} />;
    case 'pie':
    case 'donut':
      return <PieCard widget={widget} data={d} donut={widget.type === 'donut'} />;
    case 'funnel':
      return <FunnelCard widget={widget} data={d} />;
    case 'inventory_status':
      return <StackedCard widget={widget} data={d} />;
    case 'table':
    case 'list':
    case 'tasks':
      return <TableCard widget={widget} data={d} />;
    case 'ai_insights':
      return <AiInsightCard widget={widget} />;
    case 'pipeline_forecast':
      return <ForecastCard widget={widget} data={d} />;
    case 'heatmap':
      return <HeatmapCard widget={widget} data={d} />;
    case 'markdown':
      return <MarkdownCard widget={widget} />;
    case 'iframe':
      return <IframeCard widget={widget} />;
    case 'activity_feed':
      return <ActivityFeedCard widget={widget} data={d} />;
    case 'calendar':
      return <CalendarCard widget={widget} data={d} />;
    default:
      return (
        <div className="card p-4">
          <p className="text-sm font-medium">{widget.title}</p>
          <p className="mt-2 text-xs text-muted">Widget type “{widget.type}” has no renderer yet.</p>
        </div>
      );
  }
}

/**
 * Weighted pipeline by close month. Two bars per bucket: the weighted number
 * the business should plan against, and gross behind it — showing only the
 * weighted figure hides how much is riding on low-probability deals.
 */
function ForecastCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const series = (data.series as Series[] | undefined) ?? [];
  if (!series.length) return <EmptyWidget title={widget.title} />;

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
      <ChartFrame title={widget.title} series={series} format="currency">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-200 dark:text-slate-800" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => shortFormat(v, 'currency')} width={55} />
            <Tooltip
              formatter={(v: number, name) => [formatValue(v, 'currency'), name === 'secondary' ? 'Gross' : 'Weighted']}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
            />
            <Bar tabIndex={-1} dataKey="secondary" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
            <Bar tabIndex={-1} dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="mt-2 text-2xs text-muted">Solid = probability-weighted · grey = gross pipeline</p>
    </div>
  );
}

/** Day × hour density, e.g. when enquiries actually arrive. */
function HeatmapCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const series = (data.series as Series[] | undefined) ?? [];
  if (!series.length) return <EmptyWidget title={widget.title} />;

  const byCell = new Map(series.map((s) => [s.key, s.value]));
  const max = Math.max(...series.map((s) => s.value), 1);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Business hours only — a 24-column grid is unreadable in a dashboard tile
  // and the 00:00–07:00 band is empty for every real estate team.
  const hours = Array.from({ length: 15 }, (_, i) => i + 7);

  return (
    <div className="card h-full overflow-auto p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
      <table className="w-full border-separate border-spacing-[2px]">
        <tbody>
          {days.map((day, dow) => (
            <tr key={day}>
              <th scope="row" className="pr-1 text-right text-2xs font-normal text-muted">{day}</th>
              {hours.map((hour) => {
                const value = byCell.get(`${dow}-${hour}`) ?? 0;
                return (
                  <td
                    key={hour}
                    title={`${day} ${String(hour).padStart(2, '0')}:00 — ${value}`}
                    className="h-5 rounded-sm"
                    style={{
                      backgroundColor: value ? `rgba(99,102,241,${0.15 + (value / max) * 0.85})` : undefined,
                      outline: value ? undefined : '1px solid rgb(226 232 240 / 0.6)',
                    }}
                  />
                );
              })}
            </tr>
          ))}
          <tr>
            <td />
            {hours.map((hour) => (
              <td key={hour} className="pt-1 text-center text-[8px] text-muted tnum">
                {hour % 3 === 1 ? hour : ''}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className="sr-only">
        {series.map((s) => `${s.label}: ${s.value}`).join('. ')}
      </p>
    </div>
  );
}

function MarkdownCard({ widget }: { widget: DashboardWidget }): JSX.Element {
  const content = (widget.config.content as string) ?? '';
  return (
    <div className="card h-full overflow-auto p-4">
      <p className="mb-2 text-sm font-medium">{widget.title}</p>
      {content
        ? <div className="prose-ai" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        : <p className="py-6 text-center text-xs text-muted">No content yet — edit this widget to add some.</p>}
    </div>
  );
}

function IframeCard({ widget }: { widget: DashboardWidget }): JSX.Element {
  const url = (widget.config.url as string) ?? '';
  // Only http(s): a config value reaching `src` would otherwise accept
  // `javascript:` and run in the app's origin.
  const safe = /^https?:\/\//i.test(url) ? url : '';
  return (
    <div className="card flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <p className="truncate text-sm font-medium">{widget.title}</p>
        {safe && (
          <a href={safe} target="_blank" rel="noreferrer noopener" className="shrink-0 text-2xs text-brand-600 hover:underline dark:text-brand-400">
            Open ↗
          </a>
        )}
      </div>
      {safe ? (
        <iframe
          src={safe}
          title={widget.title}
          className="min-h-[12rem] flex-1 border-0"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      ) : (
        <p className="px-4 py-8 text-center text-xs text-muted">
          {url ? 'Only http(s) URLs can be embedded.' : 'No URL set — edit this widget to add one.'}
        </p>
      )}
    </div>
  );
}

interface WidgetRow { id: string; module?: string; label?: string; __display?: Record<string, string>; [key: string]: unknown }

/** Recently touched records, newest first — "what has the team been doing". */
function ActivityFeedCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const rows = (data.rows as WidgetRow[] | undefined) ?? [];
  const module = (widget.config.module as string | undefined) ?? 'leads';
  if (!rows.length) return <EmptyWidget title={widget.title} />;

  const sortField = (widget.config.sortBy as string) ?? 'last_activity_at';

  return (
    <div className="card h-full overflow-hidden">
      <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-medium dark:border-slate-800">{widget.title}</p>
      <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
        {rows.map((row) => {
          const when = row[sortField];
          return (
            <li key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
              <PeekLink
                module={String(row.module ?? module)}
                id={String(row.id)}
                label={String(row.label ?? '')}
                className="block px-4 py-2 [-webkit-touch-callout:none]"
              >
                <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">{row.label}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-muted">
                  {Object.entries(row.__display ?? {})
                    .filter(([key]) => key !== sortField)
                    .slice(0, 2)
                    .map(([key, value]) => <span key={key}>{value}</span>)}
                  {typeof when === 'string' && <span>{relativeTime(when)}</span>}
                </p>
              </PeekLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Upcoming follow-ups as an agenda, grouped by day. */
function CalendarCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const rows = (data.rows as WidgetRow[] | undefined) ?? [];
  const module = (widget.config.module as string | undefined) ?? 'leads';
  const dateField = (widget.config.sortBy as string) ?? 'next_followup_at';
  if (!rows.length) return <EmptyWidget title={widget.title} />;

  const grouped = new Map<string, WidgetRow[]>();
  for (const row of rows) {
    const raw = row[dateField];
    const date = typeof raw === 'string' ? new Date(raw) : null;
    const key = date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })
      : 'No date';
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return (
    <div className="card h-full overflow-hidden">
      <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-medium dark:border-slate-800">{widget.title}</p>
      <div className="max-h-72 overflow-y-auto px-4 py-2">
        {[...grouped.entries()].map(([day, list]) => (
          <div key={day} className="mb-3 last:mb-0">
            <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">{day}</p>
            <ul className="space-y-0.5">
              {list.map((row) => {
                const raw = row[dateField];
                const date = typeof raw === 'string' ? new Date(raw) : null;
                const time = date && !Number.isNaN(date.getTime())
                  ? date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                  : '—';
                return (
                  <li key={row.id}>
                    <PeekLink
                      module={String(row.module ?? module)}
                      id={String(row.id)}
                      label={String(row.label ?? '')}
                      className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-slate-50 [-webkit-touch-callout:none] dark:hover:bg-slate-800/60"
                    >
                      <span className="shrink-0 text-2xs text-muted tnum">{time}</span>
                      <span className="min-w-0 truncate text-xs text-slate-800 dark:text-slate-200">{row.label}</span>
                    </PeekLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatValue(value: number, format?: string): string {
  if (format === 'currency') return formatIndianPrice(value);
  if (format === 'percent') return `${value.toFixed(1)}%`;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value);
}

function MetricCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const value = Number(data.value ?? 0);
  const change = data.changePercent as number | undefined;
  const format = (data.format as string) ?? widget.config.format;
  const color = (widget.config.color as string) ?? '#6366f1';
  const linkTo = drillPath(widget.config.module, widget.config.filter);

  const body = (
    <div className={cn('card h-full p-4 transition-shadow', linkTo && 'hover:shadow-md hover:ring-1 hover:ring-brand-200 dark:hover:ring-brand-800')}>
      <p className="truncate text-xs font-medium text-muted">{widget.title}</p>
      <p className="text-tinted mt-1.5 text-2xl font-semibold tracking-tight tnum" style={tintedTextVars(color, { large: true })}>
        {formatValue(value, format)}
      </p>
      {change !== undefined && (
        <div className="mt-1.5 flex items-center gap-1 text-xs">
          {change >= 0
            ? <ArrowUpRight className="h-3.5 w-3.5 text-positive" />
            : <ArrowDownRight className="h-3.5 w-3.5 text-negative" />}
          <span className={cn('font-medium tnum', change >= 0 ? 'text-positive' : 'text-negative')}>
            {change > 0 ? '+' : ''}{change}%
          </span>
          {/* Two tiles share the width on a phone; the caption is the first
              thing to go rather than wrapping under the number. */}
          <span className="hidden text-muted sm:inline">vs previous period</span>
        </div>
      )}
    </div>
  );

  return linkTo ? <Link to={linkTo} className="block h-full">{body}</Link> : body;
}

function GaugeCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const value = Number(data.value ?? 0);
  const target = Number(data.target ?? widget.config.target ?? 0);
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  const color = pct >= 100 ? '#22c55e' : pct >= 70 ? '#f59e0b' : '#6366f1';
  const linkTo = drillPath(widget.config.module, widget.config.filter);

  const body = (
    <div className={cn('card h-full p-4 transition-shadow', linkTo && 'hover:shadow-md hover:ring-1 hover:ring-brand-200 dark:hover:ring-brand-800')}>
      <p className="truncate text-xs font-medium text-muted">{widget.title}</p>
      <p className="text-tinted mt-1.5 text-2xl font-semibold tracking-tight tnum" style={tintedTextVars(color, { large: true })}>
        {formatValue(value, (data.format as string) ?? 'currency')}
      </p>
      <div className="mt-2">
        <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
        <p className="mt-1 text-2xs text-muted tnum">
          {pct.toFixed(0)}% of {formatValue(target, 'currency')} target
        </p>
      </div>
    </div>
  );

  return linkTo ? <Link to={linkTo} className="block h-full">{body}</Link> : body;
}

interface Series { key: string; label: string; value: number; color?: string | null; secondary?: number }

/**
 * Wraps a chart so assistive tech gets the numbers instead of the drawing.
 *
 * recharts renders every segment as `<path role="img">` with no accessible
 * name, so a screen reader announces a row of unlabelled images and none of
 * the data — a serious axe failure, and useless to the person hearing it.
 * Labelling each path would fix the rule while still conveying nothing, so the
 * SVG is hidden and the same series is exposed as text, which is what someone
 * actually needs from a chart.
 *
 * This went unnoticed until the a11y scans started waiting for animations to
 * finish: recharts animates on mount, so axe had been measuring an empty
 * canvas.
 */
function ChartFrame({
  title, series, format, children,
}: { title: string; series: Series[]; format?: string; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // recharts puts tabindex="0" on its own layer groups and ignores a tabIndex
  // prop, which would leave focusable elements inside an aria-hidden subtree —
  // axe's aria-hidden-focus, and a real defect: focus would land somewhere a
  // screen reader says nothing about.
  //
  // Done here rather than with `inert`, which is the obvious answer and the
  // wrong one: inert also suppresses pointer events, so it silently killed
  // click-to-drill on every chart while making the accessibility tests pass.
  // The observer is needed because recharts rebuilds this subtree on resize
  // and on every data change.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const neutralise = (): void => {
      root.querySelectorAll<HTMLElement>('[tabindex]:not([tabindex="-1"])')
        .forEach((el) => el.setAttribute('tabindex', '-1'));
    };
    neutralise();
    const observer = new MutationObserver(neutralise);
    observer.observe(root, { subtree: true, childList: true, attributeFilter: ['tabindex'] });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {/* Hidden from assistive tech, with the series given as text below —
          labelling each segment would satisfy the rule while still conveying
          nothing useful. Clicking a segment to drill through is unaffected;
          it is a shortcut to a filtered list that is reachable from the nav
          anyway. */}
      <div ref={ref} aria-hidden="true">{children}</div>
      <p className="sr-only">
        {`${title}. ${series.map((s) => `${s.label}: ${formatValue(s.value, format)}`).join('. ')}`}
      </p>
    </>
  );
}

function BarCard({
  widget, data, horizontal,
}: { widget: DashboardWidget; data: Record<string, unknown>; horizontal?: boolean }): JSX.Element {
  const navigate = useNavigate();
  const series = (data.series as Series[] | undefined) ?? [];
  const format = (data.format as string) ?? widget.config.format;
  const groupBy = widget.config.groupBy as string | undefined;
  const drillable = Boolean(widget.config.module && groupBy);

  if (!series.length) return <EmptyWidget title={widget.title} />;

  const drill = (index: number): void => {
    const s = series[index];
    if (!drillable || !s) return;
    const path = drillPath(widget.config.module, withCondition(widget.config.filter, groupBy!, 'equals', s.key));
    if (path) navigate(path);
  };

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
      <ChartFrame title={widget.title} series={series} format={format}>
        <ResponsiveContainer width="100%" height={horizontal ? Math.max(180, series.length * 32) : 220}>
          <BarChart data={series} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, left: horizontal ? 8 : 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-200 dark:text-slate-800" vertical={!horizontal} horizontal={horizontal} />
            {horizontal ? (
              <>
                <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => shortFormat(v, format)} />
                <YAxis type="category" dataKey="label" tick={{ fontSize: 10 }} width={110} />
              </>
            ) : (
              <>
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={series.length > 5 ? -25 : 0} textAnchor={series.length > 5 ? 'end' : 'middle'} height={series.length > 5 ? 55 : 30} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => shortFormat(v, format)} width={55} />
              </>
            )}
            <Tooltip
              formatter={(v: number) => formatValue(v, format)}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
            />
            <Bar tabIndex={-1}
              dataKey="value"
              radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              cursor={drillable ? 'pointer' : undefined}
              onClick={(_data, index) => drill(index)}
            >
              {series.map((s, i) => (
                <Cell key={s.key} fill={s.color ?? PALETTE[i % PALETTE.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}

function LineCard({
  widget, data, area,
}: { widget: DashboardWidget; data: Record<string, unknown>; area?: boolean }): JSX.Element {
  const navigate = useNavigate();
  const series = (data.series as Series[] | undefined) ?? [];
  const format = (data.format as string) ?? widget.config.format;
  if (!series.length) return <EmptyWidget title={widget.title} />;

  const Chart = area ? AreaChart : LineChart;
  const dateField = (widget.config.dateField as string) ?? 'created_at';
  const interval = widget.config.interval as string | undefined;
  const drillable = Boolean(widget.config.module);

  const drill = (index: number): void => {
    const s = series[index];
    if (!drillable || !s) return;
    const { start, end } = bucketRange(s.key, interval);
    const path = drillPath(widget.config.module, withCondition(widget.config.filter, dateField, 'between', start, end));
    if (path) navigate(path);
  };

  // Recharts renders `dot` per point without forwarding extra props, so the
  // click handler has to close over `drill` here rather than living on a
  // standalone component.
  const clickableDot = (props: { cx?: number; cy?: number; index?: number }): JSX.Element => (
    <circle
      key={`point-${props.index ?? 'active'}`}
      cx={props.cx}
      cy={props.cy}
      r={3.5}
      fill="#6366f1"
      stroke="#fff"
      strokeWidth={1}
      style={{ cursor: drillable ? 'pointer' : undefined }}
      onClick={() => drill(props.index ?? -1)}
    />
  );

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
      <ChartFrame title={widget.title} series={series} format={format}>
        <ResponsiveContainer width="100%" height={220}>
          <Chart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => shortFormat(v, format)} width={55} />
            <Tooltip
              formatter={(v: number) => formatValue(v, format)}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
            />
            {area ? (
              <Area tabIndex={-1} type="monotone" dataKey="value" stroke="#6366f1" fill="#6366f1" fillOpacity={0.15} strokeWidth={2} dot={clickableDot as never} activeDot={clickableDot as never} />
            ) : (
              <Line tabIndex={-1} type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} dot={clickableDot as never} activeDot={clickableDot as never} />
            )}
          </Chart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}

function PieCard({
  widget, data, donut,
}: { widget: DashboardWidget; data: Record<string, unknown>; donut?: boolean }): JSX.Element {
  const navigate = useNavigate();
  const series = (data.series as Series[] | undefined) ?? [];
  const groupBy = widget.config.groupBy as string | undefined;
  const drillable = Boolean(widget.config.module && groupBy);
  if (!series.length) return <EmptyWidget title={widget.title} />;

  const drill = (index: number): void => {
    const s = series[index];
    if (!drillable || !s) return;
    const path = drillPath(widget.config.module, withCondition(widget.config.filter, groupBy!, 'equals', s.key));
    if (path) navigate(path);
  };

  return (
    <div className="card h-full p-4">
      <p className="mb-2 text-sm font-medium">{widget.title}</p>
      <ChartFrame title={widget.title} series={series} format={widget.config.format as string | undefined}>
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie tabIndex={-1}
              data={series}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={donut ? 45 : 0}
              outerRadius={75}
              paddingAngle={1}
              cursor={drillable ? 'pointer' : undefined}
              onClick={(_entry, index) => drill(index)}
            >
              {series.map((s, i) => <Cell key={s.key} fill={s.color ?? PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
          </PieChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}

function FunnelCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const navigate = useNavigate();
  const stages = (data.stages as { key: string; label: string; value: number; conversionFromPrevious: number; conversionFromFirst: number }[] | undefined) ?? [];
  if (!stages.length) return <EmptyWidget title={widget.title} />;
  const max = Math.max(...stages.map((s) => s.value), 1);
  const groupBy = widget.config.groupBy as string | undefined;
  const drillable = Boolean(widget.config.module && groupBy);
  // Server returns the funnel's ordered stage keys. A stage's number counts
  // records that reached it *or later*, so drilling must filter on every key
  // from the clicked stage onward, not just that one stage.
  const keys = (data.keys as string[] | undefined) ?? stages.map((s) => s.key);

  const drill = (index: number): void => {
    if (!drillable) return;
    const path = drillPath(widget.config.module, withCondition(widget.config.filter, groupBy!, 'in', keys.slice(index)));
    if (path) navigate(path);
  };

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
      <div className="space-y-1.5">
        {stages.map((stage, i) => (
          <div
            key={stage.key}
            onClick={() => drill(i)}
            className={cn(drillable && 'cursor-pointer rounded transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60')}
          >
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-slate-700 dark:text-slate-300">{stage.label}</span>
              <span className="flex items-baseline gap-2">
                <span className="font-semibold tnum">{stage.value}</span>
                {i > 0 && (
                  <span className={cn(
                    'text-2xs tnum',
                    stage.conversionFromPrevious >= 70 ? 'text-positive'
                      : stage.conversionFromPrevious >= 40 ? 'text-amber-700 dark:text-amber-400' : 'text-negative',
                  )}>
                    {stage.conversionFromPrevious}%
                  </span>
                )}
              </span>
            </div>
            <div className="mt-1 h-6 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
              <div
                className="flex h-full items-center rounded transition-all"
                style={{
                  width: `${(stage.value / max) * 100}%`,
                  backgroundColor: PALETTE[i % PALETTE.length],
                  minWidth: stage.value > 0 ? '2%' : 0,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {stages.length > 1 && (
        <p className="mt-3 border-t border-slate-100 pt-2 text-2xs text-muted dark:border-slate-800">
          End-to-end conversion:{' '}
          <span className="font-semibold text-slate-700 tnum dark:text-slate-300">
            {stages[stages.length - 1].conversionFromFirst}%
          </span>
        </p>
      )}
    </div>
  );
}

function StackedCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const navigate = useNavigate();
  const stacked = (data.stacked as { key: string; label: string; segments: { key: string; label: string; value: number; color?: string | null }[] }[] | undefined) ?? [];
  if (!stacked.length) return <EmptyWidget title={widget.title} />;

  const allSegments = [...new Set(stacked.flatMap((g) => g.segments.map((s) => s.key)))];
  const colorOf = new Map(stacked.flatMap((g) => g.segments.map((s) => [s.key, s.color])));
  const groupBy = widget.config.groupBy as string | undefined;
  const stackBy = (widget.config.stackBy as string) ?? 'status';
  const drillable = Boolean(widget.config.module && groupBy);

  const drill = (groupKey: string, segmentKey: string): void => {
    if (!drillable) return;
    const withGroup = withCondition(widget.config.filter, groupBy!, 'equals', groupKey);
    const path = drillPath(widget.config.module, withCondition(withGroup, stackBy, 'equals', segmentKey));
    if (path) navigate(path);
  };

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
      <div className="space-y-3">
        {stacked.map((group) => {
          const total = group.segments.reduce((n, s) => n + s.value, 0);
          return (
            <div key={group.key}>
              <div className="flex items-baseline justify-between text-xs">
                <span
                  className={cn('truncate font-medium text-slate-700 dark:text-slate-300', drillable && 'cursor-pointer hover:text-brand-600 dark:hover:text-brand-400')}
                  onClick={() => drillable && navigate(drillPath(widget.config.module, withCondition(widget.config.filter, groupBy!, 'equals', group.key))!)}
                >
                  {group.label}
                </span>
                <span className="shrink-0 text-slate-500 tnum">{total} units</span>
              </div>
              <div className="mt-1 flex h-5 overflow-hidden rounded">
                {group.segments.map((seg) => (
                  <div
                    key={seg.key}
                    onClick={() => drill(group.key, seg.key)}
                    className={cn('flex items-center justify-center text-[9px] font-semibold text-white transition-all', drillable && 'cursor-pointer hover:brightness-110')}
                    style={{ width: `${(seg.value / total) * 100}%`, backgroundColor: seg.color ?? '#94a3b8' }}
                    title={`${seg.label}: ${seg.value}`}
                  >
                    {seg.value / total > 0.1 ? seg.value : ''}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
        {allSegments.map((key) => (
          <span key={key} className="inline-flex items-center gap-1 text-2xs text-muted">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorOf.get(key) ?? '#94a3b8' }} />
            {key}
          </span>
        ))}
      </div>
    </div>
  );
}

function TableCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const rows = (data.rows as Record<string, unknown>[] | undefined) ?? [];
  const columns = (data.columns as string[] | undefined) ?? [];
  const module = widget.config.module as string | undefined;

  if (!rows.length) return <EmptyWidget title={widget.title} />;

  return (
    <div className="card h-full overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <p className="text-sm font-medium">{widget.title}</p>
        {module && (
          <Link to={drillPath(module, widget.config.filter)!} className="text-2xs text-brand-600 hover:underline dark:text-brand-400">
            View all
          </Link>
        )}
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full">
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => {
              const display = (row.__display ?? {}) as Record<string, string>;
              return (
                <tr key={String(row.id)} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <td className="px-4 py-2">
                    <PeekLink
                      module={String(module ?? row.module)}
                      id={String(row.id)}
                      label={String(row.label ?? '')}
                      className="text-sm font-medium text-slate-800 hover:text-brand-600 [-webkit-touch-callout:none] dark:text-slate-200"
                    >
                      {String(row.label ?? '')}
                    </PeekLink>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-2xs text-muted">
                      {columns.slice(1, 4).map((c) => {
                        const v = display[c] ?? row[c];
                        if (v === null || v === undefined || v === '') return null;
                        return <span key={c} className="truncate">{String(v)}</span>;
                      })}
                    </div>
                  </td>
                  <td className="w-16 px-4 py-2 text-right">
                    {typeof row.ai_score === 'number' && <ScoreChip score={row.ai_score as number} />}
                    {typeof row.priority === 'string' && (
                      <Badge color={row.priority === 'High' || row.priority === 'Urgent' ? '#f97316' : undefined}>
                        {String(row.priority)}
                      </Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AiInsightCard({ widget }: { widget: DashboardWidget }): JSX.Element {
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await api.dashboardInsight(
        (widget.config.aiScope as string) ?? 'sales_overview',
        widget.config.aiPrompt as string,
      );
      setInsight(result.insight);
    } catch (err) {
      setInsight(`Could not generate insights: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card h-full p-4">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-500" />
        <p className="text-sm font-medium">{widget.title}</p>
        <button onClick={() => void load()} disabled={loading} className="btn-ghost btn-sm ml-auto">
          {loading ? <Spinner className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
          {insight ? 'Refresh' : 'Generate'}
        </button>
      </div>
      {insight ? (
        <div className="prose-ai" dangerouslySetInnerHTML={{ __html: renderMarkdown(insight) }} />
      ) : (
        <p className="py-4 text-center text-xs text-muted">
          Generate an AI read of the live numbers on this dashboard.
        </p>
      )}
    </div>
  );
}

function EmptyWidget({ title }: { title: string }): JSX.Element {
  return (
    <div className="card h-full p-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="py-8 text-center text-xs text-muted">No data for this period</p>
    </div>
  );
}

function shortFormat(value: number, format?: string): string {
  if (format === 'currency') {
    if (Math.abs(value) >= 1e7) return `₹${(value / 1e7).toFixed(1)}Cr`;
    if (Math.abs(value) >= 1e5) return `₹${(value / 1e5).toFixed(0)}L`;
    if (Math.abs(value) >= 1000) return `₹${(value / 1000).toFixed(0)}K`;
    return `₹${value}`;
  }
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}
