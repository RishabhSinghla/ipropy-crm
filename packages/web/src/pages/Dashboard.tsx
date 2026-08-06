import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DashboardWidget } from '@ipropy/shared';
import { formatIndianPrice } from '@ipropy/shared';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, ChevronDown, LayoutDashboard, Sparkles, TrendingUp,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { cn, renderMarkdown } from '../lib/utils';
import { Badge, Dropdown, DropdownItem, EmptyState, ScoreChip, Skeleton, Spinner } from '../components/ui';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#0ea5e9', '#a855f7', '#14b8a6', '#f97316', '#64748b', '#ef4444'];

export default function DashboardPage(): JSX.Element {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();

  const { data: dashboards } = useQuery({ queryKey: ['dashboards'], queryFn: () => api.dashboards() });
  const activeId = id ?? dashboards?.find((d) => d.isDefault)?.id ?? dashboards?.[0]?.id;

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ['dashboard', activeId],
    queryFn: () => api.dashboard(activeId!),
    enabled: Boolean(activeId),
  });

  return (
    <div className="p-4 sm:p-6">
      <DigestBanner />

      <div className="mb-4 mt-5 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{dashboard?.name ?? 'Dashboard'}</h1>
          {dashboard?.description && (
            <p className="text-sm text-slate-500">{dashboard.description}</p>
          )}
        </div>

        {dashboards && dashboards.length > 1 && (
          <Dropdown
            align="left"
            trigger={
              <button className="btn-secondary btn-sm">
                <LayoutDashboard className="h-3.5 w-3.5" />
                Switch
                <ChevronDown className="h-3 w-3" />
              </button>
            }
          >
            {(close) => (
              <>
                {dashboards.map((d) => (
                  <DropdownItem
                    key={d.id}
                    onClick={() => { navigate(`/dashboard/${d.id}`); close(); }}
                  >
                    {d.name}
                  </DropdownItem>
                ))}
              </>
            )}
          </Dropdown>
        )}
      </div>

      {isLoading || !dashboard ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : dashboard.widgets.length === 0 ? (
        <EmptyState icon={<LayoutDashboard className="h-10 w-10" />} title="This dashboard is empty" />
      ) : (
        <div className="grid auto-rows-[minmax(0,auto)] grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12">
          {dashboard.widgets.map((widget) => (
            <div
              key={widget.id}
              className={cn(
                'min-w-0',
                widget.w <= 3 ? 'lg:col-span-3' :
                widget.w <= 4 ? 'lg:col-span-4' :
                widget.w <= 5 ? 'lg:col-span-5' :
                widget.w <= 6 ? 'lg:col-span-6' :
                widget.w <= 8 ? 'lg:col-span-8' : 'lg:col-span-12',
              )}
            >
              <Widget widget={widget} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DigestBanner(): JSX.Element | null {
  const { user } = useApp();
  const { data, isLoading } = useQuery({ queryKey: ['digest'], queryFn: () => api.digest() });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data) return null;

  const stats = data.stats ?? {};

  return (
    <div className="card overflow-hidden bg-gradient-to-br from-brand-600 to-brand-700 text-white">
      <div className="flex flex-wrap items-start gap-6 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-200" />
            <h2 className="text-lg font-semibold">{data.greeting || `Welcome back, ${user?.firstName}`}</h2>
          </div>
          {data.summary && (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-brand-50">{data.summary}</p>
          )}

          {data.priorities?.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {data.priorities.slice(0, 4).map((raw, i) => {
                const p = raw as { title: string; reason: string; recordId?: string; module?: string };
                const content = (
                  <span className="inline-flex max-w-xs items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs backdrop-blur transition-colors hover:bg-white/20">
                    <span className="truncate font-medium">{p.title}</span>
                  </span>
                );
                return p.recordId && p.module
                  ? <li key={i}><Link to={`/${p.module}/${p.recordId}`} title={p.reason}>{content}</Link></li>
                  : <li key={i} title={p.reason}>{content}</li>;
              })}
            </ul>
          )}
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {[
            { label: 'Open leads', value: stats.openLeads },
            { label: 'Visits today', value: stats.visitsToday },
            { label: 'Overdue', value: stats.overdueFollowups },
            { label: 'Pipeline', value: stats.pipelineValue, currency: true },
          ].map((s) => (
            <div key={s.label}>
              <p className="text-2xs uppercase tracking-wide text-brand-200">{s.label}</p>
              <p className="text-lg font-semibold tnum">
                {s.currency ? formatIndianPrice(Number(s.value ?? 0)) : (s.value ?? 0)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

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
        <p className="mt-2 text-xs text-red-500">{(error as Error).message}</p>
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
    default:
      return (
        <div className="card p-4">
          <p className="text-sm font-medium">{widget.title}</p>
          <p className="mt-2 text-xs text-slate-400">Widget type “{widget.type}” has no renderer yet.</p>
        </div>
      );
  }
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
  const linkTo = widget.config.module ? `/${widget.config.module}` : undefined;

  const body = (
    <div className="card h-full p-4 transition-shadow hover:shadow-md">
      <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">{widget.title}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tnum" style={{ color }}>
        {formatValue(value, format)}
      </p>
      {change !== undefined && (
        <div className="mt-1.5 flex items-center gap-1 text-xs">
          {change >= 0
            ? <ArrowUpRight className="h-3.5 w-3.5 text-emerald-600" />
            : <ArrowDownRight className="h-3.5 w-3.5 text-red-500" />}
          <span className={cn('font-medium tnum', change >= 0 ? 'text-emerald-600' : 'text-red-500')}>
            {change > 0 ? '+' : ''}{change}%
          </span>
          <span className="text-slate-400">vs previous period</span>
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

  return (
    <div className="card h-full p-4">
      <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">{widget.title}</p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tnum" style={{ color }}>
        {formatValue(value, (data.format as string) ?? 'currency')}
      </p>
      <div className="mt-2">
        <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
        <p className="mt-1 text-2xs text-slate-500 tnum">
          {pct.toFixed(0)}% of {formatValue(target, 'currency')} target
        </p>
      </div>
    </div>
  );
}

interface Series { key: string; label: string; value: number; color?: string | null; secondary?: number }

function BarCard({
  widget, data, horizontal,
}: { widget: DashboardWidget; data: Record<string, unknown>; horizontal?: boolean }): JSX.Element {
  const series = (data.series as Series[] | undefined) ?? [];
  const format = (data.format as string) ?? widget.config.format;

  if (!series.length) return <EmptyWidget title={widget.title} />;

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
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
          <Bar dataKey="value" radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}>
            {series.map((s, i) => (
              <Cell key={s.key} fill={s.color ?? PALETTE[i % PALETTE.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LineCard({
  widget, data, area,
}: { widget: DashboardWidget; data: Record<string, unknown>; area?: boolean }): JSX.Element {
  const series = (data.series as Series[] | undefined) ?? [];
  const format = (data.format as string) ?? widget.config.format;
  if (!series.length) return <EmptyWidget title={widget.title} />;

  const Chart = area ? AreaChart : LineChart;

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
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
            <Area type="monotone" dataKey="value" stroke="#6366f1" fill="#6366f1" fillOpacity={0.15} strokeWidth={2} />
          ) : (
            <Line type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} dot={{ r: 2.5 }} activeDot={{ r: 4 }} />
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

function PieCard({
  widget, data, donut,
}: { widget: DashboardWidget; data: Record<string, unknown>; donut?: boolean }): JSX.Element {
  const series = (data.series as Series[] | undefined) ?? [];
  if (!series.length) return <EmptyWidget title={widget.title} />;

  return (
    <div className="card h-full p-4">
      <p className="mb-2 text-sm font-medium">{widget.title}</p>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={series}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={donut ? 45 : 0}
            outerRadius={75}
            paddingAngle={1}
          >
            {series.map((s, i) => <Cell key={s.key} fill={s.color ?? PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function FunnelCard({ widget, data }: { widget: DashboardWidget; data: Record<string, unknown> }): JSX.Element {
  const stages = (data.stages as { key: string; label: string; value: number; conversionFromPrevious: number; conversionFromFirst: number }[] | undefined) ?? [];
  if (!stages.length) return <EmptyWidget title={widget.title} />;
  const max = Math.max(...stages.map((s) => s.value), 1);

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
      <div className="space-y-1.5">
        {stages.map((stage, i) => (
          <div key={stage.key}>
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-slate-700 dark:text-slate-300">{stage.label}</span>
              <span className="flex items-baseline gap-2">
                <span className="font-semibold tnum">{stage.value}</span>
                {i > 0 && (
                  <span className={cn(
                    'text-2xs tnum',
                    stage.conversionFromPrevious >= 70 ? 'text-emerald-600'
                      : stage.conversionFromPrevious >= 40 ? 'text-amber-600' : 'text-red-500',
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
        <p className="mt-3 border-t border-slate-100 pt-2 text-2xs text-slate-500 dark:border-slate-800">
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
  const stacked = (data.stacked as { key: string; label: string; segments: { key: string; label: string; value: number; color?: string | null }[] }[] | undefined) ?? [];
  if (!stacked.length) return <EmptyWidget title={widget.title} />;

  const allSegments = [...new Set(stacked.flatMap((g) => g.segments.map((s) => s.key)))];
  const colorOf = new Map(stacked.flatMap((g) => g.segments.map((s) => [s.key, s.color])));

  return (
    <div className="card h-full p-4">
      <p className="mb-3 text-sm font-medium">{widget.title}</p>
      <div className="space-y-3">
        {stacked.map((group) => {
          const total = group.segments.reduce((n, s) => n + s.value, 0);
          return (
            <div key={group.key}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="truncate font-medium text-slate-700 dark:text-slate-300">{group.label}</span>
                <span className="shrink-0 text-slate-500 tnum">{total} units</span>
              </div>
              <div className="mt-1 flex h-5 overflow-hidden rounded">
                {group.segments.map((seg) => (
                  <div
                    key={seg.key}
                    className="flex items-center justify-center text-[9px] font-semibold text-white transition-all"
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
          <span key={key} className="inline-flex items-center gap-1 text-2xs text-slate-500">
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
          <Link to={`/${module}`} className="text-2xs text-brand-600 hover:underline dark:text-brand-400">
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
                    <Link
                      to={`/${module ?? row.module}/${row.id}`}
                      className="text-sm font-medium text-slate-800 hover:text-brand-600 dark:text-slate-200"
                    >
                      {String(row.label ?? '')}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-2xs text-slate-500">
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
        <p className="py-4 text-center text-xs text-slate-400">
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
      <p className="py-8 text-center text-xs text-slate-400">No data for this period</p>
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
