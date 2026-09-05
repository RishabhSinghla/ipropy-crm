import type { JSX } from 'react';
/**
 * Ad-hoc reporting over any module.
 *
 * The controls are derived from the chosen module's metadata, which is the
 * whole point — but that also means they must be *rederived* when the module
 * changes. They previously were not: the page opened on a hard-coded `deals`
 * module that no longer exists, grouped by a `stage` field that no longer
 * exists, and measured an `amount` field that no longer exists, so the module
 * select showed the wrong label and both dropdowns underneath rendered blank.
 * Every default here now comes from the metadata that is actually loaded.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatIndianPrice } from '@ipropy/shared';
import type { FieldMeta } from '@ipropy/shared';
import { BarChart3, Download, Play, Plus, Save, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn } from '../lib/utils';
import { ConfirmDialog, EmptyState, Modal, Select, Skeleton, Spinner, Toggle } from '../components/ui';
import { toCsvDownload } from '../lib/download';

type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
type Aggregate = { field: string; fn: AggregateFn; label?: string };

interface SavedReport {
  id: string; name: string; description: string | null; type: string; module: string;
  ownerId: string; isShared: boolean; lastRunAt: string | null; canDelete: boolean;
}

/** Column keys that mean money even when no metadata says so — a user-typed label like "Rent roll" carries no uitype. */
const MONEY_WORDS = /value|amount|budget|price|rent|revenue|cost|deposit|emi/;


const GROUPABLE = ['picklist', 'reference', 'owner', 'user', 'boolean', 'string', 'date'];
const NUMERIC = ['currency', 'integer', 'decimal', 'percent', 'area', 'score'];

const FN_LABELS: Record<AggregateFn, string> = {
  count: 'Count of', sum: 'Sum of', avg: 'Average of', min: 'Lowest', max: 'Highest',
};

export default function ReportsPage(): JSX.Element {
  const { modules, user } = useApp();
  const queryClient = useQueryClient();
  const entityModules = useMemo(() => modules.filter((m) => m.isEntity), [modules]);

  const [moduleName, setModuleName] = useState('');
  const [type, setType] = useState<'tabular' | 'summary'>('summary');
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [aggregates, setAggregates] = useState<Aggregate[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; columns: string[]; totals?: Record<string, number> } | null>(null);
  const [running, setRunning] = useState(false);

  // Saving and re-opening reports.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveShared, setSaveShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<SavedReport | null>(null);
  // A saved report being opened is applied the moment its module's metadata
  // lands; the ref carries it across that render boundary.
  const loadRef = useRef<{ module: string; type: 'tabular' | 'summary'; groupBy: string[]; aggregates: Aggregate[]; columns: string[] } | null>(null);

  const saved = useQuery({
    queryKey: ['saved-reports'],
    queryFn: async (): Promise<SavedReport[]> => (await api.reports()) as unknown as SavedReport[],
  });


  // Modules arrive asynchronously, so the first real module is adopted once
  // rather than guessed at in the initialiser.
  useEffect(() => {
    if (!moduleName && entityModules.length) setModuleName(entityModules[0].name);
  }, [moduleName, entityModules]);

  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName),
    enabled: Boolean(moduleName),
  });

  const groupableFields = (meta?.fields ?? []).filter(
    (f) => f.isActive && f.displayType !== 'hidden' && GROUPABLE.includes(f.uitype),
  );
  const numericFields = (meta?.fields ?? []).filter(
    (f) => f.isActive && f.displayType !== 'hidden' && NUMERIC.includes(f.uitype),
  );
  const tabularFields = (meta?.fields ?? []).filter((f) => f.isActive && f.displayType !== 'hidden');

  /**
   * Sensible starting point for whichever module is loaded: group by its
   * pipeline field (Status on a lead), count the records, and total the first
   * money field if it has one. Skipped while a saved report is being opened —
   * its definition, not these defaults, owns the builder.
   */
  useEffect(() => {
    if (!meta || loadRef.current) return;

    const pipeline = meta.pipelineField && groupableFields.some((f) => f.name === meta.pipelineField)
      ? meta.pipelineField
      : groupableFields[0]?.name;
    setGroupBy(pipeline ? [pipeline] : []);

    const money = numericFields.find((f) => f.uitype === 'currency');
    setAggregates([
      { field: money?.name ?? numericFields[0]?.name ?? '', fn: 'count', label: `${meta.label} count` },
      ...(money ? [{ field: money.name, fn: 'sum' as const, label: `Total ${money.label.toLowerCase()}` }] : []),
    ]);
    setColumns(tabularFields.slice(0, 8).map((f) => f.name));
    setResult(null);
  }, [meta?.id]);

  const run = async (explicit?: { type: 'tabular' | 'summary'; groupBy: string[]; aggregates: Aggregate[]; columns: string[] }): Promise<void> => {
    if (!moduleName) return;
    const t = explicit?.type ?? type;
    const gb = explicit?.groupBy ?? groupBy;
    const aggs = explicit?.aggregates ?? aggregates;
    const cols = explicit?.columns ?? columns;
    if (t === 'summary' && !gb.length) {
      toast.error('Pick something to group by', 'A summary report needs at least one grouping.');
      return;
    }
    setRunning(true);
    try {
      setResult(await api.runReport(currentSpec(t, gb, aggs, cols)));
    } catch (err) {
      toast.error('Report failed', (err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  /** The payload the API expects for what is on screen. Shared by Run and Save so a saved report runs exactly like the one the user just looked at. */
  const currentSpec = (t: 'tabular' | 'summary', gb: string[], aggs: Aggregate[], cols: string[]) => ({
    module: moduleName,
    type: t,
    columns: t === 'tabular'
      ? (cols.length ? cols : tabularFields.slice(0, 8).map((f) => f.name))
      : [],
    groupBy: t === 'summary' ? gb : [],
    // COUNT does not read a field, but the API still expects one named;
    // any valid field will do, so an empty measure never blocks the run.
    aggregates: t === 'summary'
      ? aggs
          .filter((a) => a.fn === 'count' || a.field)
          .map((a) => ({ ...a, field: a.field || numericFields[0]?.name || 'id' }))
      : [],
    filter: { logic: 'AND', conditions: [] },
  });

  // A saved report is applied once the metadata for its module is on screen.
  useEffect(() => {
    const pending = loadRef.current;
    if (!pending || !meta || moduleName !== pending.module) return;
    loadRef.current = null;
    setType(pending.type);
    setGroupBy(pending.groupBy);
    setAggregates(pending.aggregates);
    setColumns(pending.columns);
    void run(pending);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, moduleName]);

  /** Load a saved report back into the builder and run it. */
  const openSaved = async (id: string): Promise<void> => {
    const def = await api.report(id) as {
      module: string; type: string; groupBy?: string[];
      aggregates?: Aggregate[]; columns?: string[];
    };
    const payload = {
      module: def.module,
      type: (def.type === 'tabular' ? 'tabular' : 'summary') as 'tabular' | 'summary',
      groupBy: def.groupBy ?? [],
      aggregates: def.aggregates ?? [],
      columns: def.columns ?? [],
    };
    setModuleName(payload.module);
    setResult(null);
    if (moduleName === payload.module && meta) {
      // This module's metadata is already on screen: apply straight away.
      setType(payload.type);
      setGroupBy(payload.groupBy);
      setAggregates(payload.aggregates);
      setColumns(payload.columns);
      void run(payload);
    } else {
      loadRef.current = payload;
    }
  };

  const openSaveDialog = (): void => {
    const moduleLabel = entityModules.find((m) => m.name === moduleName)?.label ?? moduleName;
    const first = groupBy[0];
    const by = type === 'summary' && first
      ? ` by ${(meta?.fields ?? []).find((f) => f.name === first)?.label ?? first}`
      : '';
    setSaveName(`${moduleLabel}${by}`);
    setSaveShared(false);
    setSaveOpen(true);
  };

  const save = async (): Promise<void> => {
    const name = saveName.trim();
    if (!name) {
      toast.error('Give the report a name', 'You will be looking for it in a list later.');
      return;
    }
    setSaving(true);
    try {
      await api.saveReport({ name, ...currentSpec(type, groupBy, aggregates, columns), isShared: saveShared });
      toast.success('Report saved', `Find “${name}” under Saved reports.`);
      setSaveOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['saved-reports'] });
    } catch (err) {
      toast.error('Could not save the report', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeSaved = async (id: string): Promise<void> => {
    try {
      await api.deleteReport(id);
      toast.success('Report deleted');
      void queryClient.invalidateQueries({ queryKey: ['saved-reports'] });
    } catch (err) {
      toast.error('Could not delete the report', (err as Error).message);
    }
  };

  /**
   * Columns that mean money, from metadata rather than guessing: a tabular
   * column key is a field name and a summary column key is the measure's
   * label over a field, so a currency-typed field marks both. The word list
   * stays as a fallback for labels metadata cannot see.
   */
  const moneyColumns = useMemo(() => {
    const currency = new Set((meta?.fields ?? []).filter((f) => f.uitype === 'currency').map((f) => f.name));
    const set = new Set<string>(currency);
    for (const a of aggregates) if (currency.has(a.field)) set.add(a.label ?? `${a.fn}(${a.field})`);
    return set;
  }, [meta, aggregates]);
  const isMoneyColumn = (c: string): boolean => moneyColumns.has(c) || MONEY_WORDS.test(c.toLowerCase());


  const fieldLabel = (name: string): string =>
    (meta?.fields ?? []).find((f) => f.name === name)?.label
      ?? aggregates.find((a) => a.label === name)?.label
      ?? name;

  const canRun = Boolean(moduleName) && (type === 'tabular' || groupBy.length > 0);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted">
          Build a summary or tabular report over any module, save it, then export it.
        </p>
      </div>

      {saved.data && saved.data.length > 0 && (
        <div className="card mb-4 overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <h2 className="text-sm font-semibold">Saved reports</h2>
            <p className="text-2xs text-muted">Run one again, or load it into the builder to tweak and re-save.</p>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {saved.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="text-2xs text-muted">
                    {modules.find((m) => m.name === r.module)?.label ?? r.module}
                    {' · '}{r.type === 'tabular' ? 'Tabular' : 'Summary'}
                    {r.isShared ? ' · Shared' : ''}
                    {' · '}{r.lastRunAt
                      ? `last run ${new Date(r.lastRunAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
                      : 'never run'}
                  </p>
                </div>
                <button className="btn-secondary btn-sm" onClick={() => void openSaved(r.id)}>
                  <Play className="h-3.5 w-3.5" /> Run
                </button>
                {r.canDelete && (
                  <button
                    className="btn-ghost btn-sm text-slate-400 hover:text-red-500"
                    aria-label={`Delete ${r.name}`}
                    onClick={() => setToDelete(r)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}


      <div className="card mb-4 overflow-hidden">
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <div>
            <label className="label">Module</label>
            <Select
              value={moduleName}
              onChange={(v) => { setModuleName(v); setResult(null); loadRef.current = null; }}

              options={entityModules.map((m) => ({ value: m.name, label: m.label }))}
              className="w-full"
            />
          </div>

          <div>
            <label className="label">Report type</label>
            <Select
              value={type}
              onChange={(v) => { setType(v as typeof type); setResult(null); }}
              options={[
                { value: 'summary', label: 'Summary — grouped totals' },
                { value: 'tabular', label: 'Tabular — one row per record' },
              ]}
              className="w-full"
            />
          </div>
        </div>

        {metaLoading || !meta ? (
          <div className="px-4 pb-4"><Skeleton className="h-24 w-full" /></div>
        ) : type === 'summary' ? (
          <div className="space-y-4 border-t border-slate-100 p-4 dark:border-slate-800">
            <div>
              <label className="label">Group by</label>
              <p className="mb-1.5 text-2xs text-muted">
                One row per distinct value. Add a second to break each group down further.
              </p>
              <div className="space-y-1.5">
                {groupBy.map((name, i) => (
                  <div key={`${name}-${i}`} className="flex items-center gap-2">
                    <Select
                      value={name}
                      onChange={(v) => setGroupBy(groupBy.map((g, j) => (j === i ? v : g)))}
                      options={groupableFields.map((f) => ({ value: f.name, label: f.label }))}
                      className="min-w-0 flex-1 py-1.5 text-sm sm:max-w-xs"
                    />
                    <button
                      onClick={() => setGroupBy(groupBy.filter((_, j) => j !== i))}
                      className="btn-ghost btn-sm shrink-0 text-slate-400 hover:text-red-500"
                      aria-label={`Remove grouping ${fieldLabel(name)}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {groupBy.length === 0 && (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-muted dark:border-slate-700">
                    Pick a field to group by before running the report.
                  </p>
                )}
                {groupBy.length < 2 && (
                  <button
                    onClick={() => {
                      const next = groupableFields.find((f) => !groupBy.includes(f.name));
                      if (next) setGroupBy([...groupBy, next.name]);
                    }}
                    disabled={groupableFields.every((f) => groupBy.includes(f.name))}
                    className="btn-secondary btn-sm disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" /> Grouping
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="label">Measures</label>
              <p className="mb-1.5 text-2xs text-muted">
                What to work out for each group. Count needs no field.
              </p>
              <div className="space-y-1.5">
                {aggregates.map((agg, i) => (
                  <MeasureRow
                    key={i}
                    aggregate={agg}
                    numericFields={numericFields}
                    onChange={(next) => setAggregates(aggregates.map((a, j) => (j === i ? next : a)))}
                    onRemove={() => setAggregates(aggregates.filter((_, j) => j !== i))}
                  />
                ))}
                {aggregates.length === 0 && (
                  <p className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-muted dark:border-slate-700">
                    No measures — the report will show the groups alone.
                  </p>
                )}
                <button
                  onClick={() => setAggregates([...aggregates, {
                    field: numericFields[0]?.name ?? '',
                    fn: numericFields.length ? 'sum' : 'count',
                  }])}
                  className="btn-secondary btn-sm"
                >
                  <Plus className="h-3 w-3" /> Measure
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="border-t border-slate-100 p-4 dark:border-slate-800">
            <label className="label">Columns</label>
            <p className="mb-1.5 text-2xs text-muted">
              {columns.length} of {tabularFields.length} selected.
            </p>
            <div className="flex flex-wrap gap-1">
              {tabularFields.map((f) => {
                const active = columns.includes(f.name);
                return (
                  <button
                    key={f.name}
                    onClick={() => setColumns(active ? columns.filter((c) => c !== f.name) : [...columns, f.name])}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs transition-colors',
                      active
                        ? 'bg-brand-100 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
                    )}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
          {result && result.rows.length > 0 && (
            <>
              <button
                onClick={() => toCsvDownload(result.rows, `${moduleName}-report.csv`)}
                className="btn-secondary"
              >
                <Download className="h-4 w-4" /> Export CSV
              </button>
              <button onClick={openSaveDialog} className="btn-secondary">
                <Save className="h-4 w-4" /> Save report
              </button>
            </>
          )}

          <button onClick={() => void run()} disabled={running || !canRun} className="btn-primary">
            {running ? <Spinner /> : <Play className="h-4 w-4" />} Run report
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        {!result ? (
          <EmptyState
            icon={<BarChart3 className="h-10 w-10" />}
            title="No report yet"
            body={type === 'summary'
              ? 'Choose a module and a grouping, then run the report.'
              : 'Choose a module and its columns, then run the report.'}
          />
        ) : result.rows.length === 0 ? (
          <EmptyState
            title="No matching data"
            body="No records in this module produced a row. Try a different grouping."
          />
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
                      return (
                        <td key={c} className={cn('table-cell', typeof value === 'number' && 'tnum font-medium')}>
                          {formatCell(value, isMoneyColumn(c))}
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
                        {i === 0 ? 'Total' : result.totals?.[c] !== undefined ? formatCell(result.totals[c], isMoneyColumn(c)) : ''}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save report" size="sm"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setSaveOpen(false)} disabled={saving}>Cancel</button>
            <button className="btn-primary" onClick={() => void save()} disabled={saving || !saveName.trim()}>
              {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="report-name">Report name</label>
            <input
              id="report-name"
              className="input w-full"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g. Properties by status"
            />
          </div>
          {user?.isAdmin && (
            <Toggle
              checked={saveShared}
              onChange={setSaveShared}
              label="Share with everyone"
              ariaLabel="Share this report with everyone"
            />
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete this report?"
        danger
        confirmLabel="Delete"
        body={toDelete ? `“${toDelete.name}” will be gone for everyone who can see it. Nothing in the CRM itself is affected.` : undefined}
        onConfirm={async () => { if (toDelete) await removeSaved(toDelete.id); }}
      />
    </div>
  );
}

/**
 * One measure: the function, the field it reads, and what to call the column.
 *
 * The field select is hidden for COUNT because counting rows does not read a
 * field — leaving it visible was the main reason the row looked broken when the
 * selected field wasn't in the list.
 */
function MeasureRow({
  aggregate, numericFields, onChange, onRemove,
}: {
  aggregate: Aggregate;
  numericFields: FieldMeta[];
  onChange: (next: Aggregate) => void;
  onRemove: () => void;
}): JSX.Element {
  const needsField = aggregate.fn !== 'count';
  const fieldOptions = numericFields.map((f) => ({ value: f.name, label: f.label }));
  const missing = needsField && aggregate.field && !numericFields.some((f) => f.name === aggregate.field);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={aggregate.fn}
        onChange={(fn) => {
          const next = fn as AggregateFn;
          onChange({
            ...aggregate,
            fn: next,
            // Moving off COUNT with nothing chosen would leave a blank select.
            field: next === 'count' ? aggregate.field : (aggregate.field || numericFields[0]?.name || ''),
          });
        }}
        options={(Object.keys(FN_LABELS) as AggregateFn[])
          .filter((fn) => fn === 'count' || numericFields.length > 0)
          .map((fn) => ({ value: fn, label: FN_LABELS[fn] }))}
        className="w-32 shrink-0 py-1.5 text-xs"
      />

      {needsField && (
        <Select
          value={missing ? '' : aggregate.field}
          placeholder={missing ? 'Field no longer exists — pick another' : 'Pick a field'}
          onChange={(field) => onChange({ ...aggregate, field })}
          options={fieldOptions}
          className={cn('min-w-[9rem] flex-1 py-1.5 text-xs sm:w-48 sm:flex-none', missing && 'border-red-400')}
        />
      )}
      {!needsField && <span className="text-xs text-muted">records</span>}

      <input
        className="input min-w-[7rem] flex-1 py-1.5 text-xs sm:w-44 sm:flex-none"
        placeholder="Column heading"
        aria-label="Column heading"
        value={aggregate.label ?? ''}
        onChange={(e) => onChange({ ...aggregate, label: e.target.value })}
      />

      <button
        onClick={onRemove}
        className="btn-ghost btn-sm shrink-0 text-slate-400 hover:text-red-500"
        aria-label="Remove measure"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Money reads as ₹ crores; every other number as a plain Indian-grouped figure. */
function formatCell(value: unknown, money: boolean): JSX.Element | string {
  if (value === null || value === undefined || value === '') {
    return <span className="text-slate-300 dark:text-slate-700">—</span>;
  }
  if (typeof value !== 'number') return String(value);
  return money
    ? formatIndianPrice(value)
    : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value);
}
