import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import { Activity, Database, Layers, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, EmptyState, Select, Skeleton, Tabs } from '../../components/ui';

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
          { key: 'audit', label: 'Audit log', icon: <Layers className="h-3.5 w-3.5" /> },
          { key: 'ai', label: 'AI usage', icon: <Sparkles className="h-3.5 w-3.5" /> },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

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
            <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
              <p className="text-sm font-medium">AI usage — last 30 days</p>
            </div>
            {!aiUsage?.byFeature.length ? (
              <EmptyState
                icon={<Sparkles className="h-8 w-8" />}
                title="No AI calls recorded"
                body="Set ANTHROPIC_API_KEY to enable the AI features."
              />
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    {['Feature', 'Calls', 'Input tokens', 'Output tokens', 'Avg latency', 'Failures'].map((h) => (
                      <th key={h} className="table-head">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(aiUsage.byFeature as { feature: string; calls: number; input_tokens: number; output_tokens: number; avg_latency_ms: number; failures: number }[])
                    .map((row) => (
                      <tr key={row.feature}>
                        <td className="table-cell font-medium capitalize">{row.feature.replace(/_/g, ' ')}</td>
                        <td className="table-cell tnum">{row.calls}</td>
                        <td className="table-cell tnum text-slate-500">{row.input_tokens?.toLocaleString('en-IN')}</td>
                        <td className="table-cell tnum text-slate-500">{row.output_tokens?.toLocaleString('en-IN')}</td>
                        <td className="table-cell tnum text-slate-500">{row.avg_latency_ms}ms</td>
                        <td className="table-cell tnum">
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
