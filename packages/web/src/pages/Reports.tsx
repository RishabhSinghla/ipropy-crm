/**
 * Reports: a question the CRM can answer, kept so nobody has to build it twice.
 *
 * Deliberately not a new query engine. A report is a saved `WidgetConfig`, run
 * by the same code a dashboard tile uses, against the same permission-scoped
 * SQL as every list — so "contacts by source" means the same thing here, on the
 * dashboard and in an export, and a field an admin deletes disappears from all
 * three at once.
 *
 * The screen is built around one sentence a non-technical owner can read back:
 * *count / total / average — of — contacts — grouped by — status — in — this
 * month*. Everything else (chart type, sharing, export) hangs off that.
 */
import { type JSX, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { BarChart3, Download, Plus, Save, Share2, Trash2 } from 'lucide-react';
import type { FieldMeta, WidgetConfig } from '@ipropy/shared';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { ChartFrame, SeriesSummary, formatValue, type Series } from '../components/ChartFrame';
import { ConfirmDialog, EmptyState, Skeleton, Spinner } from '../components/ui';

/** What a report can be drawn as. Each maps to a widget type the engine runs. */
const SHAPES = [
  { type: 'bar', label: 'Bars' },
  { type: 'pie', label: 'Pie' },
  { type: 'line', label: 'Over time' },
  { type: 'table', label: 'Table' },
  { type: 'metric', label: 'One number' },
] as const;

const MEASURES = [
  { aggregate: 'count', label: 'How many' },
  { aggregate: 'sum', label: 'Total of' },
  { aggregate: 'avg', label: 'Average of' },
] as const;

/**
 * The date ranges somebody actually asks for, as filter conditions.
 *
 * The filter grammar already has these operators, so a range is three words
 * rather than two date pickers — and the same words the list's own filter uses,
 * so a report and a list agree about what "this month" means.
 */
const RANGES = [
  { key: 'all', label: 'All time', operator: null },
  { key: 'this_month', label: 'This month', operator: 'this_month' },
  { key: 'last_30', label: 'Last 30 days', operator: 'last_n_days', value: 30 },
  { key: 'this_quarter', label: 'This quarter', operator: 'this_quarter' },
  { key: 'this_year', label: 'This year', operator: 'this_year' },
] as const;

const NUMERIC = new Set(['number', 'currency', 'decimal', 'percent', 'integer']);
const GROUPABLE = ['picklist', 'select', 'status', 'owner', 'user', 'reference', 'boolean', 'checkbox'];

interface SavedReport {
  id: string;
  name: string;
  description: string | null;
  module: string;
  type: string;
  config: WidgetConfig;
  isShared: boolean;
  isMine: boolean;
}

export default function Reports(): JSX.Element {
  const { modules, user } = useApp();
  const queryClient = useQueryClient();
  const entityModules = useMemo(
    () => modules.filter((m) => m.isEntity && m.permissions.view),
    [modules],
  );

  const [tab, setTab] = useState<'records' | 'whatsapp'>('records');
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('bar');
  const [config, setConfig] = useState<WidgetConfig>({ aggregate: 'count' });
  const [range, setRange] = useState<string>('all');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: saved, isLoading } = useQuery({ queryKey: ['reports'], queryFn: () => api.reports() });
  const moduleName = config.module ?? entityModules[0]?.name;

  const { data: meta } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName!),
    enabled: Boolean(moduleName),
  });

  const fields = useMemo(
    () => (meta?.fields ?? []).filter((f: FieldMeta) => f.isActive && f.displayType !== 'hidden'),
    [meta],
  );
  const groupable = fields.filter((f: FieldMeta) => GROUPABLE.includes(f.uitype));
  const numeric = fields.filter((f: FieldMeta) => NUMERIC.has(f.uitype));
  const dates = fields.filter((f: FieldMeta) => ['date', 'datetime'].includes(f.uitype));

  /*
    A report is only as good as its defaults: somebody who opens this screen and
    changes nothing should already see a real answer rather than an empty frame
    asking them to choose four things first.
  */
  useEffect(() => {
    if (!moduleName) return;
    setConfig((prev) => {
      const next: WidgetConfig = { ...prev, module: moduleName };
      if (!next.groupBy && groupable.length) next.groupBy = groupable[0].name;
      if (!next.dateField && dates.length) next.dateField = dates[0].name;
      return next;
    });
  }, [moduleName, groupable.length, dates.length]);

  /** The chosen range, expressed in the filter grammar both engines read. */
  const filter = useMemo((): WidgetConfig['filter'] => {
    const chosen = RANGES.find((r) => r.key === range);
    if (!chosen?.operator || !config.dateField) return undefined;
    return {
      logic: 'AND',
      conditions: [{
        field: config.dateField,
        operator: chosen.operator,
        value: 'value' in chosen ? chosen.value : undefined,
      }],
    } as WidgetConfig['filter'];
  }, [range, config.dateField]);

  const runnable = useMemo((): { type: string; config: WidgetConfig } => ({
    type,
    config: {
      ...config,
      filter,
      // A pie of two hundred stages is unreadable; the engine's own limit is
      // what keeps the biggest groups and drops the tail.
      limit: type === 'table' ? 200 : 15,
      interval: config.interval ?? 'month',
    },
  }), [type, config, filter]);

  const [result, setResult] = useState<{ loading: boolean; error?: string; data?: Record<string, unknown> }>({ loading: true });
  useEffect(() => {
    if (!runnable.config.module) return;
    setResult((prev) => ({ ...prev, loading: true }));
    // Debounced: changing a dropdown is one query, not one per keystroke in
    // the name box beside it.
    const timer = setTimeout(() => {
      api.runReport(runnable.type, runnable.config as Record<string, unknown>)
        .then((data) => setResult({ loading: false, data }))
        .catch((err: Error) => setResult({ loading: false, error: err.message }));
    }, 300);
    return () => clearTimeout(timer);
  }, [runnable]);

  const open = (report: SavedReport): void => {
    setOpenId(report.id);
    setName(report.name);
    setType(report.type);
    setConfig(report.config);
    // The saved filter carries the range, so the picker is set back to "all"
    // rather than silently applying a second one on top of it.
    setRange('all');
    setConfig((prev) => ({ ...prev, filter: report.config.filter }));
  };

  const startNew = (): void => {
    setOpenId(null);
    setName('');
    setType('bar');
    setRange('all');
    setConfig({ module: entityModules[0]?.name, aggregate: 'count' });
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        module: runnable.config.module!,
        type: runnable.type,
        config: runnable.config as Record<string, unknown>,
      };
      return openId ? api.updateReport(openId, payload) : api.createReport(payload);
    },
    onSuccess: (report) => {
      setOpenId(report.id);
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      toast.success('Report saved', 'It is in your list on the left.');
    },
    onError: (err: Error) => toast.error('Could not save that report', err.message),
  });

  const share = useMutation({
    mutationFn: (isShared: boolean) => api.updateReport(openId!, { isShared }),
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      toast.success(report.isShared ? 'Shared with the team' : 'Back to just you');
    },
    onError: (err: Error) => toast.error('Could not change that', err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteReport(openId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      startNew();
      toast.success('Report deleted');
    },
    onError: (err: Error) => toast.error('Could not delete that', err.message),
  });

  const current = saved?.find((r) => r.id === openId);
  const measureLabel = MEASURES.find((m) => m.aggregate === (config.aggregate ?? 'count'))!.label;

  if (tab === 'whatsapp') {
    return (
      <div className="p-4 sm:p-6">
        <ReportTabs tab={tab} onChange={setTab} />
        <MessagingReport />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <ReportTabs tab={tab} onChange={setTab} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <aside className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight text-muted">Saved</h2>
            <button className="btn-primary btn-sm" onClick={startNew}>
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          </div>
          {isLoading ? <Skeleton className="h-40 w-full" /> : (
            <nav aria-label="Saved reports" className="space-y-1">
              {!saved?.length && (
                <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-muted dark:border-slate-700">
                  Nothing saved yet. Build a question on the right and press Save.
                </p>
              )}
              {saved?.map((report) => (
                <button
                  key={report.id}
                  type="button"
                  onClick={() => open(report)}
                  aria-current={report.id === openId}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md p-2 text-left text-[13px] transition-colors',
                    report.id === openId
                      ? 'bg-brand-100 font-bold text-brand-900 ring-1 ring-brand-300 dark:bg-brand-900/60 dark:text-brand-50 dark:ring-brand-700'
                      : 'font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800',
                  )}
                >
                  <BarChart3 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate">{report.name}</span>
                  {report.isShared && <Share2 className="h-3 w-3 shrink-0 text-slate-400" aria-label="Shared with the team" />}
                </button>
              ))}
            </nav>
          )}
        </aside>

        <section className="space-y-3">
          <div className="card space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[12rem] flex-1">
                <span className="label">Report name</span>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Contacts by status this month"
                />
              </label>
              <button
                className="btn-primary btn-sm"
                disabled={!name.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                {openId ? 'Save' : 'Save report'}
              </button>
              <button
                className="btn-secondary btn-sm"
                onClick={() => void exportCsv(runnable, name || 'report')}
              >
                <Download className="h-3.5 w-3.5" /> Export
              </button>
              {current && (current.isMine || user?.isAdmin) && (
                <>
                  <button className="btn-secondary btn-sm" onClick={() => share.mutate(!current.isShared)}>
                    <Share2 className="h-3.5 w-3.5" /> {current.isShared ? 'Unshare' : 'Share'}
                  </button>
                  <button className="btn-secondary btn-sm text-red-600" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </>
              )}
            </div>

            {/* The question, as one sentence left to right. */}
            <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
              <label>
                <span className="label">Measure</span>
                <select
                  className="input w-auto"
                  value={config.aggregate ?? 'count'}
                  onChange={(e) => setConfig((p) => ({ ...p, aggregate: e.target.value as WidgetConfig['aggregate'] }))}
                >
                  {MEASURES.map((m) => <option key={m.aggregate} value={m.aggregate}>{m.label}</option>)}
                </select>
              </label>

              {config.aggregate && config.aggregate !== 'count' && (
                <label>
                  <span className="label">Which number</span>
                  <select
                    className="input w-auto"
                    value={config.aggregateField ?? ''}
                    onChange={(e) => setConfig((p) => ({ ...p, aggregateField: e.target.value }))}
                  >
                    <option value="">Choose a field…</option>
                    {numeric.map((f: FieldMeta) => <option key={f.name} value={f.name}>{f.label}</option>)}
                  </select>
                </label>
              )}

              <label>
                <span className="label">Of</span>
                <select
                  className="input w-auto"
                  value={moduleName ?? ''}
                  onChange={(e) => setConfig({ aggregate: config.aggregate, module: e.target.value })}
                >
                  {entityModules.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
                </select>
              </label>

              {type !== 'metric' && type !== 'line' && (
                <label>
                  <span className="label">Grouped by</span>
                  <select
                    className="input w-auto"
                    value={config.groupBy ?? ''}
                    onChange={(e) => setConfig((p) => ({ ...p, groupBy: e.target.value }))}
                  >
                    {groupable.map((f: FieldMeta) => <option key={f.name} value={f.name}>{f.label}</option>)}
                  </select>
                </label>
              )}

              <label>
                <span className="label">When</span>
                <select className="input w-auto" value={range} onChange={(e) => setRange(e.target.value)}>
                  {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>

              {(range !== 'all' || type === 'line') && dates.length > 0 && (
                <label>
                  <span className="label">Date to use</span>
                  <select
                    className="input w-auto"
                    value={config.dateField ?? ''}
                    onChange={(e) => setConfig((p) => ({ ...p, dateField: e.target.value }))}
                  >
                    {dates.map((f: FieldMeta) => <option key={f.name} value={f.name}>{f.label}</option>)}
                  </select>
                </label>
              )}

              <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                {SHAPES.map((shape) => (
                  <button
                    key={shape.type}
                    type="button"
                    onClick={() => setType(shape.type)}
                    aria-pressed={type === shape.type}
                    className={cn(
                      'px-2.5 py-1.5 text-xs font-semibold transition-colors',
                      type === shape.type
                        ? 'bg-brand-600 text-white'
                        : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800',
                    )}
                  >
                    {shape.label}
                  </button>
                ))}
              </span>
            </div>
          </div>

          <div className="card p-4">
            <p className="mb-2 text-xs text-muted">
              {measureLabel}
              {config.aggregate !== 'count' && config.aggregateField
                ? ` ${numeric.find((f: FieldMeta) => f.name === config.aggregateField)?.label ?? ''}`
                : ''}
              {` · ${entityModules.find((m) => m.name === moduleName)?.label ?? ''}`}
              {config.groupBy && type !== 'metric' && type !== 'line'
                ? ` · by ${groupable.find((f: FieldMeta) => f.name === config.groupBy)?.label ?? config.groupBy}`
                : ''}
              {` · ${RANGES.find((r) => r.key === range)?.label}`}
            </p>
            <ReportResult state={result} type={type} title={name || 'Report'} />
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this report?"
        body="The question is deleted. No records are touched."
        confirmLabel="Delete"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); remove.mutate(); }}
      />
    </div>
  );
}

/** Downloads the answer on screen, as the spreadsheet somebody will email on. */
async function exportCsv(runnable: { type: string; config: WidgetConfig }, title: string): Promise<void> {
  try {
    await api.exportReport(runnable.type, runnable.config as Record<string, unknown>, title);
  } catch (err) {
    toast.error('Could not export that', (err as Error).message);
  }
}

function ReportResult({
  state, type, title,
}: {
  state: { loading: boolean; error?: string; data?: Record<string, unknown> };
  type: string;
  title: string;
}): JSX.Element {
  if (state.error) {
    return (
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        {state.error}
      </p>
    );
  }
  if (!state.data) return <Skeleton className="h-64 w-full" />;

  const data = state.data;
  const series = (data.series as Series[] | undefined) ?? [];
  const format = data.format as string | undefined;

  if (type === 'metric') {
    return (
      <p className="text-3xl font-semibold tracking-tight tnum">
        {formatValue(Number(data.value ?? 0), format)}
      </p>
    );
  }

  if (type === 'table') {
    const rows = (data.rows as Record<string, unknown>[] | undefined) ?? [];
    const columns = (data.columns as string[] | undefined) ?? (rows[0] ? Object.keys(rows[0]) : []);
    if (!rows.length) return <EmptyState title="Nothing to show" body="No records match this question yet." />;
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-muted dark:border-slate-700">
              {columns.map((column) => <th key={column} className="py-2 pr-4 font-semibold">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                {columns.map((column) => (
                  <td key={column} className="py-1.5 pr-4">{String(row[column] ?? '—')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!series.length) {
    return <EmptyState title="Nothing to show" body={(data.note as string) ?? 'No records match this question yet.'} />;
  }

  return (
    <div className="flex h-80 flex-col">
      <ChartFrame title={title} series={series} format={format}>
        <ResponsiveContainer width="100%" height="100%">
          {type === 'pie' ? (
            <PieChart>
              <Pie data={series} dataKey="value" nameKey="label" innerRadius="45%" outerRadius="75%">
                {series.map((point) => (
                  <Cell key={point.key} fill={point.color ?? 'var(--brand-500, #6366f1)'} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          ) : type === 'line' ? (
            <LineChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={44} />
              <Tooltip />
              <Line type="monotone" dataKey="value" stroke="var(--brand-500, #6366f1)" strokeWidth={2} dot={false} />
            </LineChart>
          ) : (
            <BarChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={44} />
              <Tooltip />
              <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={64}>
                {series.map((point) => (
                  <Cell key={point.key} fill={point.color ?? 'var(--brand-500, #6366f1)'} />
                ))}
              </Bar>
            </BarChart>
          )}
        </ResponsiveContainer>
      </ChartFrame>
      <SeriesSummary series={series} format={format} />
    </div>
  );
}

/**
 * Two kinds of question, and they are genuinely different.
 *
 * A record report is built by the person asking it. A messaging report is one
 * fixed set of numbers about the business number, because "how many messages
 * did we send" has no dimensions worth choosing between.
 */
function ReportTabs({
  tab, onChange,
}: { tab: 'records' | 'whatsapp'; onChange: (tab: 'records' | 'whatsapp') => void }): JSX.Element {
  return (
    <div className="mb-4 flex items-center gap-4 border-b border-slate-200 dark:border-slate-800">
      <h1 className="pb-2 text-lg font-semibold tracking-tight">Reports</h1>
      <nav className="flex gap-1" aria-label="Report kind">
        {([['records', 'Records'], ['whatsapp', 'WhatsApp']] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-current={tab === key}
            className={cn(
              'border-b-2 px-3 pb-2 pt-1 text-sm font-semibold transition-colors',
              tab === key
                ? 'border-brand-600 text-brand-700 dark:text-brand-300'
                : 'border-transparent text-muted hover:text-slate-700 dark:hover:text-slate-200',
            )}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  queued: 'Waiting to go',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed',
};

/** What the business number did: in, out, and how each campaign ended. */
function MessagingReport(): JSX.Element {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['wa-biz', 'report', days],
    queryFn: () => api.waBizReport(days),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data) return <EmptyState title="Nothing to show" body="No WhatsApp activity yet." />;

  const byDay: Series[] = data.byDay.map((row) => ({
    key: row.day, label: row.day.slice(5), value: row.outbound + row.inbound,
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="label">When</span>
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 3 months</option>
          </select>
        </label>
        <p className="text-sm text-muted">
          {data.totals.outbound.toLocaleString('en-IN')} sent ·{' '}
          {data.totals.inbound.toLocaleString('en-IN')} received ·{' '}
          {data.totals.conversations.toLocaleString('en-IN')} conversations
        </p>
      </div>

      <div className="card p-4">
        <p className="mb-2 flex flex-wrap items-center gap-x-3 text-xs text-muted">
          Messages a day
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: '#2563eb' }} /> sent
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: '#22c55e' }} /> received
          </span>
        </p>
        {byDay.length ? (
          <div className="flex h-64 flex-col">
            <ChartFrame title="Messages a day" series={byDay}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.byDay} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                  <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={40} />
                  <Tooltip />
                  <Bar dataKey="outbound" stackId="m" fill="#2563eb" maxBarSize={44} />
                  <Bar dataKey="inbound" stackId="m" fill="#22c55e" maxBarSize={44} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>
          </div>
        ) : (
          <EmptyState title="No messages yet" body="Nothing has been sent or received on the business number in this period." />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <p className="mb-2 text-xs text-muted">What happened to the ones we sent</p>
          {data.outcomes.length ? (
            <ul className="space-y-1 text-sm">
              {data.outcomes.map((outcome) => (
                <li key={outcome.status} className="flex justify-between gap-3 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800">
                  <span>{OUTCOME_LABEL[outcome.status] ?? outcome.status}</span>
                  <span className="font-semibold tnum">{outcome.count.toLocaleString('en-IN')}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Nothing has been sent yet.</p>}
        </div>

        <div className="card p-4">
          <p className="mb-2 text-xs text-muted">Campaigns</p>
          {data.campaigns.length ? (
            <ul className="space-y-2 text-sm">
              {data.campaigns.map((campaign) => (
                <li key={campaign.id} className="border-b border-slate-100 pb-2 last:border-0 dark:border-slate-800">
                  <p className="font-semibold">{campaign.name}</p>
                  <p className="text-xs text-muted tnum">
                    {campaign.sent.toLocaleString('en-IN')} sent · {campaign.failed} failed ·{' '}
                    {campaign.skipped} skipped · {campaign.pending} still to go
                  </p>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No campaigns in this period.</p>}
        </div>
      </div>
    </div>
  );
}
