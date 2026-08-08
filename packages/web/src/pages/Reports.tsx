import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatIndianPrice } from '@ipropy/shared';
import { BarChart3, Download, Play, Plus, Table2 } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { EmptyState, Select, Skeleton, Spinner } from '../components/ui';
import { toCsvDownload } from '../lib/download';

type Aggregate = { field: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; label?: string };

export default function ReportsPage(): JSX.Element {
  const { modules } = useApp();
  const [moduleName, setModuleName] = useState('deals');
  const [type, setType] = useState<'tabular' | 'summary'>('summary');
  const [groupBy, setGroupBy] = useState<string[]>(['stage']);
  const [aggregates, setAggregates] = useState<Aggregate[]>([
    { field: 'amount', fn: 'sum', label: 'Total value' },
    { field: 'amount', fn: 'count', label: 'Deals' },
  ]);
  const [columns, setColumns] = useState<string[]>([]);
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; columns: string[]; totals?: Record<string, number> } | null>(null);
  const [running, setRunning] = useState(false);

  const { data: meta } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName),
  });

  const groupableFields = (meta?.fields ?? []).filter(
    (f) => f.isActive && ['picklist', 'reference', 'owner', 'user', 'boolean', 'string'].includes(f.uitype),
  );
  const numericFields = (meta?.fields ?? []).filter(
    (f) => f.isActive && ['currency', 'integer', 'decimal', 'percent', 'area', 'score'].includes(f.uitype),
  );

  const run = async (): Promise<void> => {
    setRunning(true);
    try {
      const spec = {
        module: moduleName,
        type,
        columns: type === 'tabular'
          ? (columns.length ? columns : (meta?.fields ?? []).slice(0, 8).map((f) => f.name))
          : [],
        groupBy: type === 'summary' ? groupBy : [],
        aggregates: type === 'summary' ? aggregates : [],
        filter: { logic: 'AND', conditions: [] },
      };
      setResult(await api.runReport(spec));
    } catch (err) {
      toast.error('Report failed', (err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const fieldLabel = (name: string): string =>
    (meta?.fields ?? []).find((f) => f.name === name)?.label ?? name;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted">
          Build a summary or tabular report over any module, then export it.
        </p>
      </div>

      <div className="card mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label">Module</label>
            <Select
              value={moduleName}
              onChange={(v) => { setModuleName(v); setGroupBy([]); setResult(null); }}
              options={modules.filter((m) => m.isEntity).map((m) => ({ value: m.name, label: m.label }))}
            />
          </div>

          <div>
            <label className="label">Report type</label>
            <Select
              value={type}
              onChange={(v) => { setType(v as typeof type); setResult(null); }}
              options={[
                { value: 'summary', label: 'Summary (grouped)' },
                { value: 'tabular', label: 'Tabular (raw rows)' },
              ]}
            />
          </div>

          {type === 'summary' && (
            <div className="lg:col-span-2">
              <label className="label">Group by</label>
              <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 p-1.5 dark:border-slate-700">
                {groupableFields.slice(0, 14).map((f) => {
                  const active = groupBy.includes(f.name);
                  return (
                    <button
                      key={f.name}
                      onClick={() => setGroupBy(active ? groupBy.filter((g) => g !== f.name) : [...groupBy, f.name])}
                      className={cn(
                        'rounded px-2 py-0.5 text-xs transition-colors',
                        active
                          ? 'bg-brand-100 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                          : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
                      )}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {type === 'summary' && (
          <div className="mt-3">
            <label className="label">Measures</label>
            <div className="space-y-1.5">
              {aggregates.map((agg, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select
                    value={agg.fn}
                    onChange={(fn) => setAggregates(aggregates.map((a, j) => j === i ? { ...a, fn: fn as Aggregate['fn'] } : a))}
                    options={['count', 'sum', 'avg', 'min', 'max'].map((f) => ({ value: f, label: f.toUpperCase() }))}
                    className="w-28 py-1.5 text-xs"
                  />
                  <Select
                    value={agg.field}
                    onChange={(field) => setAggregates(aggregates.map((a, j) => j === i ? { ...a, field } : a))}
                    options={numericFields.map((f) => ({ value: f.name, label: f.label }))}
                    className="w-44 py-1.5 text-xs"
                  />
                  <input
                    className="input w-40 py-1.5 text-xs"
                    placeholder="Column label"
                    value={agg.label ?? ''}
                    onChange={(e) => setAggregates(aggregates.map((a, j) => j === i ? { ...a, label: e.target.value } : a))}
                  />
                  <button
                    onClick={() => setAggregates(aggregates.filter((_, j) => j !== i))}
                    className="btn-ghost btn-sm text-slate-400"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                onClick={() => setAggregates([...aggregates, { field: numericFields[0]?.name ?? '', fn: 'sum' }])}
                className="btn-secondary btn-sm"
              >
                <Plus className="h-3 w-3" /> Measure
              </button>
            </div>
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          {result && (
            <button
              onClick={() => toCsvDownload(result.rows, `${moduleName}-report.csv`)}
              className="btn-secondary"
            >
              <Download className="h-4 w-4" /> Export CSV
            </button>
          )}
          <button onClick={() => void run()} disabled={running} className="btn-primary">
            {running ? <Spinner /> : <Play className="h-4 w-4" />} Run report
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        {!result ? (
          <EmptyState
            icon={<BarChart3 className="h-10 w-10" />}
            title="No report yet"
            body="Choose a module and grouping, then run the report."
          />
        ) : result.rows.length === 0 ? (
          <EmptyState title="No matching data" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c} className="table-head">{fieldLabel(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {result.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    {result.columns.map((c) => {
                      const value = row[c];
                      const isMoney = c.toLowerCase().includes('value') || c.toLowerCase().includes('amount');
                      return (
                        <td key={c} className={cn('table-cell', typeof value === 'number' && 'tnum font-medium')}>
                          {value === null || value === undefined || value === ''
                            ? <span className="text-slate-300">—</span>
                            : typeof value === 'number' && isMoney
                              ? formatIndianPrice(value)
                              : typeof value === 'number'
                                ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value)
                                : String(value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              {result.totals && Object.keys(result.totals).length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-800">
                    {result.columns.map((c, i) => (
                      <td key={c} className="table-cell tnum">
                        {i === 0 ? 'Total' : result.totals?.[c] !== undefined
                          ? (c.toLowerCase().includes('value') || c.toLowerCase().includes('amount')
                              ? formatIndianPrice(result.totals[c])
                              : new Intl.NumberFormat('en-IN').format(result.totals[c]))
                          : ''}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
