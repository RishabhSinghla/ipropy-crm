import { type JSX, useEffect, useMemo, useState } from 'react';
import { byLabel } from '../lib/fields';
/**
 * Add / edit a dashboard widget.
 *
 * The server already accepted arbitrary widget definitions (`POST /widgets`,
 * `POST /preview`) and rendered 20 widget types; there was simply no UI to
 * write one, so a dashboard could only ever contain what the seed put there.
 *
 * The form is driven by WIDGET_TYPES below rather than by a switch: each type
 * declares which config sections it needs, so adding a type is one entry here
 * plus a renderer in Dashboard.tsx. Preview runs the real `/preview` endpoint
 * under the current user's permissions, so what the builder shows is what the
 * widget will show.
 */
import { useQuery } from '@tanstack/react-query';
import type { DashboardWidget, FilterGroup, ModuleMeta, WidgetConfig, WidgetType } from '@ipropy/shared';
import {
  Activity, BarChart3, Calendar, Filter as FilterIcon, Gauge, Globe, Grid3x3,
  LayoutList, LineChart, ListChecks, PieChart, Sparkles, Table2, TrendingUp, Type, Users,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { FilterBuilder } from './FilterBuilder';
import { Modal, Select, Spinner } from './ui';

/** Which config sections a type needs. Everything else stays hidden. */
interface WidgetTypeDef {
  type: WidgetType;
  label: string;
  hint: string;
  icon: JSX.Element;
  needs: {
    module?: boolean;
    aggregate?: boolean;
    groupBy?: boolean;
    timeSeries?: boolean;
    stages?: boolean;
    columns?: boolean;
    target?: boolean;
    content?: boolean;
    url?: boolean;
    ai?: boolean;
  };
  defaultSize: { w: number; h: number };
}

const ICON = 'h-4 w-4';

export const WIDGET_TYPES: WidgetTypeDef[] = [
  { type: 'metric', label: 'Metric', hint: 'One big number, optionally vs the previous period.', icon: <TrendingUp className={ICON} />, needs: { module: true, aggregate: true }, defaultSize: { w: 3, h: 2 } },
  { type: 'gauge', label: 'Gauge', hint: 'A number against a target, with a progress bar.', icon: <Gauge className={ICON} />, needs: { module: true, aggregate: true, target: true }, defaultSize: { w: 3, h: 2 } },
  { type: 'bar', label: 'Bar chart', hint: 'Compare a measure across categories.', icon: <BarChart3 className={ICON} />, needs: { module: true, aggregate: true, groupBy: true }, defaultSize: { w: 6, h: 4 } },
  { type: 'line', label: 'Line chart', hint: 'A measure over time.', icon: <LineChart className={ICON} />, needs: { module: true, aggregate: true, timeSeries: true }, defaultSize: { w: 6, h: 4 } },
  { type: 'area', label: 'Area chart', hint: 'A measure over time, filled.', icon: <LineChart className={ICON} />, needs: { module: true, aggregate: true, timeSeries: true }, defaultSize: { w: 6, h: 4 } },
  { type: 'pie', label: 'Pie chart', hint: 'Share of a total by category.', icon: <PieChart className={ICON} />, needs: { module: true, aggregate: true, groupBy: true }, defaultSize: { w: 4, h: 4 } },
  { type: 'donut', label: 'Donut chart', hint: 'Share of a total, with the centre free.', icon: <PieChart className={ICON} />, needs: { module: true, aggregate: true, groupBy: true }, defaultSize: { w: 4, h: 4 } },
  { type: 'leaderboard', label: 'Leaderboard', hint: 'Ranked horizontal bars — top performers.', icon: <Users className={ICON} />, needs: { module: true, aggregate: true, groupBy: true }, defaultSize: { w: 4, h: 5 } },
  { type: 'funnel', label: 'Funnel', hint: 'Stage-to-stage conversion through a pipeline.', icon: <FilterIcon className={ICON} />, needs: { module: true, groupBy: true, stages: true }, defaultSize: { w: 6, h: 5 } },
  { type: 'pipeline_forecast', label: 'Forecast', hint: 'Probability-weighted pipeline by close month.', icon: <TrendingUp className={ICON} />, needs: { module: true, timeSeries: true }, defaultSize: { w: 6, h: 4 } },
  { type: 'table', label: 'Table', hint: 'A list of records with the columns you pick.', icon: <Table2 className={ICON} />, needs: { module: true, columns: true }, defaultSize: { w: 6, h: 5 } },
  { type: 'list', label: 'List', hint: 'Compact record list.', icon: <LayoutList className={ICON} />, needs: { module: true, columns: true }, defaultSize: { w: 4, h: 5 } },
  { type: 'tasks', label: 'My follow-ups', hint: 'Records assigned to the viewer with a follow-up due.', icon: <ListChecks className={ICON} />, needs: { module: true, columns: true }, defaultSize: { w: 4, h: 5 } },
  { type: 'heatmap', label: 'Heatmap', hint: 'Day × hour density — e.g. the best time to call.', icon: <Grid3x3 className={ICON} />, needs: { module: true, timeSeries: true }, defaultSize: { w: 6, h: 4 } },
  { type: 'inventory_status', label: 'Inventory status', hint: 'Stacked unit status per project.', icon: <BarChart3 className={ICON} />, needs: { module: true, groupBy: true }, defaultSize: { w: 6, h: 5 } },
  { type: 'activity_feed', label: 'Activity feed', hint: 'What changed across the CRM, newest first.', icon: <Activity className={ICON} />, needs: {}, defaultSize: { w: 4, h: 5 } },
  { type: 'calendar', label: 'Calendar', hint: 'Follow-ups by the day they are due.', icon: <Calendar className={ICON} />, needs: {}, defaultSize: { w: 4, h: 5 } },
  { type: 'ai_insights', label: 'AI insight', hint: 'A written read of the live numbers.', icon: <Sparkles className={ICON} />, needs: { ai: true }, defaultSize: { w: 4, h: 4 } },
  { type: 'markdown', label: 'Text / notes', hint: 'Free text, links and headings.', icon: <Type className={ICON} />, needs: { content: true }, defaultSize: { w: 4, h: 3 } },
  { type: 'iframe', label: 'Embed', hint: 'Any external page, embedded.', icon: <Globe className={ICON} />, needs: { url: true }, defaultSize: { w: 6, h: 5 } },
];

const AGGREGATES = [
  { value: 'count', label: 'Count of records' },
  { value: 'sum', label: 'Sum of' },
  { value: 'avg', label: 'Average of' },
  { value: 'min', label: 'Minimum of' },
  { value: 'max', label: 'Maximum of' },
];

const INTERVALS = ['day', 'week', 'month', 'quarter', 'year'];
const FORMATS = [
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency (₹)' },
  { value: 'percent', label: 'Percent' },
];
const FONT_SCALES = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'large', label: 'Large' },
];

const EMPTY_FILTER: FilterGroup = { logic: 'AND', conditions: [] };

/** Numeric fields are the only sensible targets for sum/avg/min/max. */
const NUMERIC_UITYPES = new Set(['integer', 'decimal', 'currency', 'percent', 'number', 'area', 'score']);

export default function WidgetBuilder({
  dashboardId, widget, onClose, onSaved,
}: {
  dashboardId: string;
  /** null = adding a new widget */
  widget: DashboardWidget | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { modules } = useApp();
  const entityModules = useMemo(
    () => modules.filter((m) => m.isEntity && m.permissions.view),
    [modules],
  );

  const [type, setType] = useState<WidgetType>(widget?.type ?? 'metric');
  const [title, setTitle] = useState(widget?.title ?? '');
  const [config, setConfig] = useState<WidgetConfig>(widget?.config ?? { module: entityModules[0]?.name, aggregate: 'count' });
  const [saving, setSaving] = useState(false);
  const [showFilter, setShowFilter] = useState(false);

  const def = WIDGET_TYPES.find((t) => t.type === type)!;
  const set = (patch: Partial<WidgetConfig>): void => setConfig((prev) => ({ ...prev, ...patch }));

  // Full metadata for the chosen module — the sidebar list carries only
  // labels, and the field pickers need uitypes to filter sensibly.
  const { data: moduleMeta } = useQuery({
    queryKey: ['module', config.module],
    queryFn: () => api.module(config.module!),
    enabled: Boolean(config.module) && Boolean(def.needs.module),
  });

  const fields = moduleMeta?.fields.filter((f) => f.isActive && f.displayType !== 'hidden') ?? [];
  const numericFields = fields.filter((f) => NUMERIC_UITYPES.has(f.uitype));
  const groupableFields = fields.filter((f) => ['picklist', 'select', 'status', 'owner', 'user', 'reference', 'boolean', 'checkbox'].includes(f.uitype));
  const dateFields = fields.filter((f) => ['date', 'datetime'].includes(f.uitype));

  // Preview against the live endpoint, debounced so dragging a number field
  // does not fire a query per keystroke.
  const [preview, setPreview] = useState<{ loading: boolean; error?: string; data?: Record<string, unknown> }>({ loading: false });
  useEffect(() => {
    if (def.needs.content || def.needs.url) { setPreview({ loading: false }); return; }
    setPreview((p) => ({ ...p, loading: true }));
    const timer = setTimeout(() => {
      api.previewWidget(type, config as Record<string, unknown>)
        .then((data) => setPreview({ loading: false, data }))
        .catch((err: Error) => setPreview({ loading: false, error: err.message }));
    }, 400);
    return () => clearTimeout(timer);
  }, [type, config, def.needs.content, def.needs.url]);

  const save = async (): Promise<void> => {
    if (!title.trim()) { toast.error('Give the widget a title'); return; }
    setSaving(true);
    try {
      const payload = { type, title: title.trim(), config: config as Record<string, unknown> };
      if (widget) {
        await api.updateWidget(dashboardId, widget.id, payload);
      } else {
        // New widgets land at the bottom of the grid; the drag layer persists
        // wherever the user moves them next.
        await api.addWidget(dashboardId, { ...payload, x: 0, y: 999, ...def.defaultSize });
      }
      toast.success(widget ? 'Widget updated' : 'Widget added');
      onSaved();
    } catch (err) {
      toast.error('Could not save the widget', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const filterCount = (config.filter?.conditions ?? []).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={widget ? 'Edit widget' : 'Add widget'}
      size="xl"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
            {saving && <Spinner className="h-3 w-3" />}
            {widget ? 'Save changes' : 'Add widget'}
          </button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="space-y-4">
          <div>
            <label className="label">Widget type</label>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {WIDGET_TYPES.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  onClick={() => {
                    setType(t.type);
                    if (!title.trim()) setTitle(t.label);
                  }}
                  title={t.hint}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors',
                    type === t.type
                      ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
                  )}
                >
                  <span className="shrink-0">{t.icon}</span>
                  <span className="truncate">{t.label}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-2xs text-muted">{def.hint}</p>
          </div>

          <div>
            <label className="label">Title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New leads this month" />
          </div>

          {def.needs.module && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Module</label>
                <Select
                  value={config.module ?? ''}
                  onChange={(v) => set({ module: v, groupBy: undefined, aggregateField: undefined, dateField: undefined, filter: undefined })}
                  options={entityModules.map((m) => ({ value: m.name, label: m.label }))}
                />
              </div>

              {def.needs.aggregate && (
                <div>
                  <label className="label">Measure</label>
                  <Select
                    value={config.aggregate ?? 'count'}
                    onChange={(v) => set({ aggregate: v as WidgetConfig['aggregate'] })}
                    options={AGGREGATES}
                  />
                </div>
              )}

              {def.needs.aggregate && config.aggregate && config.aggregate !== 'count' && (
                <div>
                  <label className="label">Field to aggregate</label>
                  <Select
                    value={config.aggregateField ?? ''}
                    onChange={(v) => set({ aggregateField: v })}
                    options={byLabel(numericFields).map((f) => ({ value: f.name, label: f.label }))}
                    placeholder="Pick a numeric field"
                  />
                </div>
              )}

              {def.needs.groupBy && (
                <div>
                  <label className="label">Group by</label>
                  <Select
                    value={config.groupBy ?? ''}
                    onChange={(v) => set({ groupBy: v })}
                    options={byLabel(groupableFields).map((f) => ({ value: f.name, label: f.label }))}
                    placeholder="Pick a field"
                  />
                </div>
              )}

              {def.needs.timeSeries && (
                <>
                  <div>
                    <label className="label">Date field</label>
                    <Select
                      value={config.dateField ?? 'created_at'}
                      onChange={(v) => set({ dateField: v })}
                      options={[
                        { value: 'created_at', label: 'Created At' },
                        { value: 'updated_at', label: 'Modified At' },
                        ...byLabel(dateFields).map((f) => ({ value: f.name, label: f.label })),
                      ]}
                    />
                  </div>
                  {type !== 'heatmap' && type !== 'pipeline_forecast' && (
                    <div>
                      <label className="label">Bucket by</label>
                      <Select
                        value={config.interval ?? 'month'}
                        onChange={(v) => set({ interval: v as WidgetConfig['interval'] })}
                        options={INTERVALS.map((i) => ({ value: i, label: i[0].toUpperCase() + i.slice(1) }))}
                      />
                    </div>
                  )}
                </>
              )}

              {def.needs.target && (
                <div>
                  <label className="label">Target</label>
                  <input
                    type="number"
                    className="input"
                    value={config.target ?? ''}
                    onChange={(e) => set({ target: e.target.value === '' ? undefined : Number(e.target.value) })}
                    placeholder="e.g. 50000000"
                  />
                </div>
              )}

              {def.needs.columns && (
                <div className="sm:col-span-2">
                  <label className="label">Columns</label>
                  <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                    {fields.slice(0, 40).map((f) => {
                      const on = (config.columns ?? []).includes(f.name);
                      return (
                        <button
                          key={f.name}
                          type="button"
                          onClick={() => set({
                            columns: on
                              ? (config.columns ?? []).filter((c) => c !== f.name)
                              : [...(config.columns ?? []), f.name],
                          })}
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-2xs transition-colors',
                            on
                              ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300'
                              : 'border-slate-200 text-muted hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
                          )}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label className="label">Number format</label>
                <Select
                  value={config.format ?? 'number'}
                  onChange={(v) => set({ format: v as WidgetConfig['format'] })}
                  options={FORMATS}
                />
              </div>

              <div>
                <label className="label">Rows / points</label>
                <input
                  type="number"
                  className="input"
                  value={config.limit ?? ''}
                  onChange={(e) => set({ limit: e.target.value === '' ? undefined : Number(e.target.value) })}
                  placeholder="10"
                />
              </div>

              <div>
                <label className="label">Accent colour</label>
                <input
                  type="color"
                  value={config.color ?? '#6366f1'}
                  onChange={(e) => set({ color: e.target.value })}
                  className="h-9 w-full cursor-pointer rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900"
                  aria-label="Widget accent colour"
                />
              </div>

              <div>
                <label className="label">Content size</label>
                <Select
                  value={String(config.fontScale ?? 'comfortable')}
                  onChange={(v) => set({ fontScale: v as WidgetConfig['fontScale'] })}
                  options={FONT_SCALES}
                />
              </div>

              {(type === 'line' || type === 'area') && (
                <div>
                  <label className="label">Chart line thickness</label>
                  <input
                    type="number"
                    min="1"
                    max="8"
                    step="1"
                    className="input"
                    value={Number(config.lineWidth ?? 2)}
                    onChange={(e) => set({ lineWidth: Math.max(1, Math.min(8, Number(e.target.value) || 2)) })}
                  />
                </div>
              )}

              {type === 'metric' && (
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-slate-300"
                    checked={Boolean(config.comparePrevious)}
                    onChange={(e) => set({ comparePrevious: e.target.checked })}
                  />
                  Compare with previous period
                </label>
              )}
            </div>
          )}

          {def.needs.stages && (
            <div>
              <label className="label">Stages, in order</label>
              <input
                className="input"
                value={(config.stages ?? []).join(', ')}
                onChange={(e) => set({ stages: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                placeholder="Enquiry, Site Visit, Negotiation, Booked"
              />
              <p className="mt-1 text-2xs text-muted">
                Each stage counts records that reached it <em>or any later stage</em>.
              </p>
            </div>
          )}

          {def.needs.content && (
            <div>
              <label className="label">Content (Markdown)</label>
              <textarea
                className="input min-h-[8rem] font-mono text-xs"
                value={config.content ?? ''}
                onChange={(e) => set({ content: e.target.value })}
                placeholder={'## Team notes\n- Follow up on Meridian Crest enquiries'}
              />
            </div>
          )}

          {def.needs.url && (
            <div>
              <label className="label">URL to embed</label>
              <input
                className="input"
                value={config.url ?? ''}
                onChange={(e) => set({ url: e.target.value })}
                placeholder="https://…"
              />
              <p className="mt-1 text-2xs text-muted">
                Many sites refuse to be framed. If the tile stays blank, that site has blocked embedding.
              </p>
            </div>
          )}

          {def.needs.ai && (
            <div>
              <label className="label">What should the AI look at?</label>
              <textarea
                className="input min-h-[5rem]"
                value={config.aiPrompt ?? ''}
                onChange={(e) => set({ aiPrompt: e.target.value })}
                placeholder="Where are we losing deals this month, and what should the team do about it?"
              />
            </div>
          )}

          {def.needs.module && moduleMeta && (
            <div>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setShowFilter((v) => !v)}>
                <FilterIcon className="h-3.5 w-3.5" />
                {showFilter ? 'Hide filter' : filterCount ? `Filter (${filterCount})` : 'Add a filter'}
              </button>
              {showFilter && (
                <div className="mt-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <FilterBuilder
                    module={moduleMeta as ModuleMeta}
                    value={config.filter ?? EMPTY_FILTER}
                    onChange={(filter) => set({ filter })}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="lg:border-l lg:border-slate-200 lg:pl-5 lg:dark:border-slate-800">
          <p className="label">Live preview</p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/40">
            {preview.loading && <div className="flex justify-center py-8"><Spinner className="text-slate-400" /></div>}
            {!preview.loading && preview.error && (
              <p className="py-6 text-center text-xs text-negative">{preview.error}</p>
            )}
            {!preview.loading && !preview.error && (def.needs.content || def.needs.url) && (
              <p className="py-6 text-center text-xs text-muted">
                This widget has no data query — it renders exactly what you typed.
              </p>
            )}
            {!preview.loading && !preview.error && preview.data && !def.needs.content && !def.needs.url && (
              <PreviewSummary data={preview.data} />
            )}
          </div>
          <p className="mt-2 text-2xs text-muted">
            The preview runs the real query with your own record permissions, so colleagues
            with narrower access will see smaller numbers.
          </p>
        </div>
      </div>
    </Modal>
  );
}

/**
 * A compact, type-agnostic read of whatever `/preview` returned. Rendering the
 * true chart here would mean lifting every renderer out of Dashboard.tsx; what
 * the builder actually needs to answer is "is my query returning the right
 * rows?", which the numbers answer directly.
 */
function PreviewSummary({ data }: { data: Record<string, unknown> }): JSX.Element {
  const series = data.series as { label: string; value: number }[] | undefined;
  const stages = data.stages as { label: string; value: number }[] | undefined;
  const rows = data.rows as Record<string, unknown>[] | undefined;
  const stacked = data.stacked as { label: string; segments: { value: number }[] }[] | undefined;

  if (data.value !== undefined && !series) {
    return (
      <div className="py-4 text-center">
        <p className="text-2xl font-semibold tnum">{new Intl.NumberFormat('en-IN').format(Number(data.value))}</p>
        {data.changePercent !== undefined && (
          <p className="mt-1 text-2xs text-muted">{String(data.changePercent)}% vs previous period</p>
        )}
      </div>
    );
  }

  const list = series ?? stages
    ?? stacked?.map((g) => ({ label: g.label, value: g.segments.reduce((n, s) => n + s.value, 0) }))
    ?? rows?.map((r) => ({ label: String(r.label ?? r.id ?? ''), value: NaN }));

  if (!list?.length) return <p className="py-6 text-center text-xs text-muted">No data matches this configuration.</p>;

  const max = Math.max(...list.map((s) => (Number.isFinite(s.value) ? s.value : 0)), 1);

  return (
    <ul className="space-y-1.5">
      {list.slice(0, 10).map((s, i) => (
        <li key={`${s.label}-${i}`}>
          <div className="flex items-baseline justify-between gap-2 text-2xs">
            <span className="min-w-0 truncate text-slate-600 dark:text-slate-300">{s.label || '—'}</span>
            {Number.isFinite(s.value) && (
              <span className="shrink-0 font-semibold tnum">{new Intl.NumberFormat('en-IN', { notation: 'compact' }).format(s.value)}</span>
            )}
          </div>
          {Number.isFinite(s.value) && (
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.max(2, (s.value / max) * 100)}%` }} />
            </div>
          )}
        </li>
      ))}
      {list.length > 10 && <li className="pt-1 text-2xs text-muted">+{list.length - 10} more</li>}
    </ul>
  );
}
