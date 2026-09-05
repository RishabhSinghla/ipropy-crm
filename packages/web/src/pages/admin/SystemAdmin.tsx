import { type JSX, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import { Activity, AlertTriangle, CheckCircle2, CircleHelp, Database, Layers, Rocket, Sparkles, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, EmptyState, Select, Skeleton, Tabs } from '../../components/ui';

/**
 * Whether this deployment is ready for a team, checked by the deployment itself.
 *
 * The go-live list is six pieces of configuration spread across a database
 * host, a hosting dashboard, an admin screen and everybody's phone. Written
 * down, it records what somebody intended; asked of the running server, it
 * records what is actually true — which is a different thing, and the one that
 * matters the morning you hand the address to five people.
 *
 * Failures first, deliberately. A list that reads top to bottom in its original
 * order buries the one item that loses data under four that are already fine.
 */
function ReadinessPanel(): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['readiness'],
    queryFn: () => api.readiness(),
    refetchInterval: 60_000,
  });

  if (isLoading) return <Skeleton className="h-64" />;
  if (!data) return <EmptyState title="Could not run the check" />;

  const rank: Record<string, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 };
  const checks = [...data.checks].sort((a, b) => rank[a.status] - rank[b.status]);

  const icon = (status: string): JSX.Element => {
    if (status === 'ok') return <CheckCircle2 className="h-4 w-4 shrink-0 text-positive" />;
    if (status === 'fail') return <XCircle className="h-4 w-4 shrink-0 text-negative" />;
    if (status === 'warn') return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />;
    return <CircleHelp className="h-4 w-4 shrink-0 text-slate-400" />;
  };

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <p className="text-sm font-medium">
          {data.readyCount} of {data.total} ready
        </p>
        <p className="mt-1 text-xs text-muted">
          Checked against this running server, not against a document. Anything it cannot see
          from here says so rather than guessing.
        </p>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div
            className="h-full bg-positive transition-all"
            style={{ width: `${(data.readyCount / data.total) * 100}%` }}
          />
        </div>
      </div>

      <ul className="card divide-y divide-slate-100 dark:divide-slate-800">
        {checks.map((check) => (
          <li key={check.id} className="flex gap-3 p-4">
            {icon(check.status)}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{check.title}</p>
              <p className="mt-0.5 text-xs text-muted">{check.detail}</p>
              {check.fix && check.status !== 'ok' && (
                <p className="mt-1.5 text-xs text-brand-600 dark:text-brand-400">{check.fix}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Paise to something readable.
 *
 * Free is the common case here and the one worth stating plainly rather than as
 * "₹0.00", which reads like a rounding error. Below a rupee it shows paise,
 * because the difference between 4 paise and 40 paise a call is the difference
 * between a free month and a noticeable bill at volume.
 */
function formatRupees(paise: number | null | undefined): string {
  const value = Number(paise ?? 0);
  // Per row, a dash rather than "Free": a call made before pricing existed and
  // a call on a free model both land here, and only one of them is free.
  if (!value) return '—';
  if (value < 100) return `${value}p`;
  return `₹${(value / 100).toLocaleString('en-IN', { maximumFractionDigits: value < 10_000 ? 2 : 0 })}`;
}

export default function SystemAdmin(): JSX.Element {
  const [tab, setTab] = useState('overview');
  const [auditModule, setAuditModule] = useState('');

  const { data: health, isLoading } = useQuery({
    queryKey: ['system-health'],
    queryFn: () => api.systemHealth(),
  });

  const { data: audit } = useQuery({
    queryKey: ['audit', auditModule],
    queryFn: () => api.auditLog({ module: auditModule || undefined, limit: 100 }),
    enabled: tab === 'audit',
  });

  const { data: aiUsage } = useQuery({
    queryKey: ['ai-usage'],
    queryFn: () => api.aiUsage(),
    enabled: tab === 'ai',
  });

  const meta = (health?.metadata ?? {}) as Record<string, number>;
  const counts = (health?.recordCounts ?? []) as unknown as { module_name: string; count: number }[];
  const queue = (health?.taskQueue ?? {}) as Record<string, number>;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">System & Audit</h1>
        <p className="text-sm text-muted">Health, data volumes and the org-wide change log.</p>
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: 'Overview', icon: <Activity className="h-3.5 w-3.5" /> },
          { key: 'readiness', label: 'Go live', icon: <Rocket className="h-3.5 w-3.5" /> },
          { key: 'audit', label: 'Audit log', icon: <Layers className="h-3.5 w-3.5" /> },
          { key: 'ai', label: 'AI usage', icon: <Sparkles className="h-3.5 w-3.5" /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'readiness' && <ReadinessPanel />}

      {tab === 'overview' && (
        isLoading ? (
          <div className="grid gap-3 sm:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: 'Modules', value: meta.modules, hint: `${meta.customModules ?? 0} custom` },
                { label: 'Fields', value: meta.fields, hint: `${meta.customFields ?? 0} custom` },
                { label: 'Total records', value: counts.reduce((n, c) => n + c.count, 0) },
                { label: 'Uptime', value: `${Math.round(Number(health?.uptimeSeconds ?? 0) / 60)}m` },
              ].map((card) => (
                <div key={card.label} className="card p-4">
                  <p className="text-2xs uppercase tracking-wide text-muted">{card.label}</p>
                  <p className="mt-1 text-2xl font-semibold tnum">{String(card.value ?? 0)}</p>
                  {card.hint && <p className="text-2xs text-muted">{card.hint}</p>}
                </div>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card overflow-hidden">
                <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
                  <Database className="h-4 w-4 text-slate-400" />
                  <p className="text-sm font-medium">Records by module</p>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {counts.map((c) => (
                    <li key={c.module_name} className="flex items-center justify-between px-4 py-2">
                      <span className="text-sm capitalize">{c.module_name.replace(/_/g, ' ')}</span>
                      <span className="text-sm font-medium tnum">{c.count.toLocaleString('en-IN')}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="card overflow-hidden">
                <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
                  <p className="text-sm font-medium">Automation queue</p>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {Object.entries(queue).length === 0 && (
                    <li className="px-4 py-6 text-center text-xs text-muted">Queue is empty</li>
                  )}
                  {Object.entries(queue).map(([status, count]) => (
                    <li key={status} className="flex items-center justify-between px-4 py-2">
                      <Badge color={
                        status === 'done' ? '#22c55e'
                          : status === 'failed' ? '#ef4444'
                          : status === 'pending' ? '#f59e0b' : '#94a3b8'
                      }>
                        {status}
                      </Badge>
                      <span className="text-sm font-medium tnum">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )
      )}

      {tab === 'audit' && (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Change log</p>
            <Select
              value={auditModule}
              onChange={setAuditModule}
              placeholder="All modules"
              options={counts.map((c) => ({ value: c.module_name, label: c.module_name.replace(/_/g, ' ') }))}
              className="ml-auto w-44 py-1 text-xs"
            />
          </div>

          {!audit?.length ? (
            <EmptyState title="No audit entries" />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {(audit as { id: string; action: string; module_name: string; record_label: string | null; user_name: string | null; changes: { label?: string; from?: unknown; to?: unknown }[]; created_at: string; source: string }[])
                .map((entry) => (
                  <li key={entry.id} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge color={
                        entry.action === 'create' ? '#22c55e'
                          : entry.action === 'delete' ? '#ef4444'
                          : entry.action === 'export' ? '#a855f7' : '#0ea5e9'
                      }>
                        {entry.action}
                      </Badge>
                      <span className="text-sm font-medium">{entry.record_label ?? entry.module_name}</span>
                      <span className="text-2xs text-muted">
                        by {entry.user_name ?? 'System'} · {relativeTime(entry.created_at)}
                        {entry.source !== 'app' && ` · via ${entry.source}`}
                      </span>
                    </div>
                    {entry.changes?.length > 0 && entry.action === 'update' && (
                      <ul className="mt-1 space-y-0.5">
                        {entry.changes.slice(0, 4).map((c, i) => (
                          <li key={i} className="text-2xs text-muted">
                            <span className="font-medium">{c.label}</span>:{' '}
                            <span className="line-through opacity-60">{fmt(c.from)}</span> → {fmt(c.to)}
                          </li>
                        ))}
                        {entry.changes.length > 4 && (
                          <li className="text-2xs text-muted">…and {entry.changes.length - 4} more</li>
                        )}
                      </ul>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'ai' && (
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
              <p className="text-sm font-medium">AI usage — last 30 days</p>
              {/*
                The number somebody actually wants. Tokens answer "how much did
                it think"; this answers "what did it cost", which is the question
                being asked. Free models total ₹0, and that is worth seeing.
              */}
              {aiUsage ? (
                <p className="text-sm tnum font-medium">
                  {/*
                    "Free" would be a claim about a bill, and calls made before
                    pricing existed carry no cost — so a zero total means "none
                    recorded", not "none charged". Saying the first when the
                    second is true is the one mistake worth avoiding on a screen
                    somebody checks to see what they are spending.
                  */}
                  {aiUsage.totalPaise > 0 ? formatRupees(aiUsage.totalPaise) : 'No spend recorded'}
                  {aiUsage.totalPaise > 0
                    ? <span className="ml-1.5 text-2xs font-normal text-muted">this month</span>
                    : null}
                </p>
              ) : null}
            </div>
            {!aiUsage?.byFeature.length ? (
              <EmptyState
                icon={<Sparkles className="h-8 w-8" />}
                title="No AI calls recorded"
                body="Add a provider key under Admin → Integrations, then pick a model for each job under Settings → AI models."
              />
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    {['Feature', 'Calls', 'Cost', 'Input tokens', 'Output tokens', 'Avg latency', 'Failures'].map((h) => (
                      <th key={h} className="list-head">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(aiUsage.byFeature as { feature: string; calls: number; cost_paise: number; input_tokens: number; output_tokens: number; avg_latency_ms: number; failures: number }[])
                    .map((row) => (
                      <tr key={row.feature}>
                        <td className="list-cell font-medium capitalize">{row.feature.replace(/_/g, ' ')}</td>
                        <td className="list-cell tnum">{row.calls}</td>
                        <td className="list-cell tnum font-medium">{formatRupees(row.cost_paise)}</td>
                        <td className="list-cell tnum text-slate-500">{row.input_tokens?.toLocaleString('en-IN')}</td>
                        <td className="list-cell tnum text-slate-500">{row.output_tokens?.toLocaleString('en-IN')}</td>
                        <td className="list-cell tnum text-slate-500">{row.avg_latency_ms}ms</td>
                        <td className="list-cell tnum">
                          {row.failures > 0 ? <span className="text-negative">{row.failures}</span> : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
  return String(v).slice(0, 40);
}
