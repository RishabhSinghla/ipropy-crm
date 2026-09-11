import { type JSX, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatIndianPrice, relativeTime } from '@ipropy/shared';
import {
  AlertTriangle, ArrowLeft, Check, Database, Download, FileUp, Upload, X,
} from 'lucide-react';
import { api, authedFileUrl, type ImportSection } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Dropdown, DropdownItem, EmptyState, Modal, Select, Spinner } from '../../components/ui';
import { ImportDuplicateReview } from '../../components/ImportDuplicateReview';

interface Suggestion {
  header: string;
  field: string | null;
  confidence: 'certain' | 'likely' | 'possible';
  reason: string;
}

interface Preview {
  headers: string[];
  sample: Record<string, string>[];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  suggestions: Suggestion[];
  dateOrder: { detected: 'dmy' | 'mdy' | 'ymd'; certain: boolean };
  fields: { name: string; label: string; uitype: string; mandatory: boolean;
    options: { value: string; label: string }[] }[];
}

interface DryRun {
  totalRows: number;
  shown: number;
  rows: {
    row: number; outcome: string; matched: string | null;
    values: Record<string, unknown>; problems: string[];
  }[];
  optionsAdded: string[];
  optionsSkipped: string[];
}

interface JobRow {
  id: string; file_name: string; module: string; module_label: string; status: string;
  total_rows: number; processed_rows: number; created_rows: number;
  skipped_rows: number; failed_rows: number; created_at: string;
  duplicate_rows: number; pending_rows: number; updated_rows: number;
  errors: { row: number; error: string }[];
  details: { created: string[]; skipped: string[]; optionsAdded?: string[]; optionsSkipped?: string[] };
}

/**
 * What this file is for, in the order somebody actually decides it.
 *
 * The old page put every switch on one row above the mapping table, so the
 * first thing a person met was six settings about a file the CRM had not read
 * yet. Three steps instead — the file, then its columns, then the rules — and
 * each step only asks what it can answer: duplicate handling is a question
 * about records, and it is not worth asking before the columns are agreed.
 */
const STEPS = [
  { key: 'file', label: 'The file' },
  { key: 'columns', label: 'The columns' },
  { key: 'rules', label: 'The rules' },
  { key: 'check', label: 'What will happen' },
] as const;
type Step = typeof STEPS[number]['key'];

/**
 * How sure the CRM is, in words rather than a percentage.
 *
 * A number invites arithmetic nobody can do — 0.82 against what? These three
 * say what to do about it: leave it, glance at it, or look properly. Only
 * `certain` is filled in without being asked (see `certainMapping` on the
 * server); the rest arrive as suggestions beside an empty box.
 */
const CONFIDENCE: Record<Suggestion['confidence'], { label: string; colour: string }> = {
  certain: { label: 'Certain', colour: '#22c55e' },
  likely: { label: 'Likely', colour: '#0ea5e9' },
  possible: { label: 'Check this', colour: '#f59e0b' },
};

const DATE_ORDERS = [
  { value: 'dmy', label: 'Day / Month / Year  — 05/03/2026 is 5 March' },
  { value: 'mdy', label: 'Month / Day / Year  — 05/03/2026 is 3 May' },
  { value: 'ymd', label: 'Year / Month / Day  — 2026/05/03' },
];

const MODES = [
  { value: 'create', title: 'Add as new', hint: 'Every row becomes a new record.' },
  { value: 'upsert', title: 'Add or update', hint: 'Update the ones already here, add the rest. The usual answer for a refresh.' },
  { value: 'update', title: 'Only update', hint: 'Change what is already here and never invent a record.' },
  { value: 'skip_existing', title: 'Only add what is missing', hint: 'Leave every existing record exactly as it is.' },
];

export default function ImportAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { modules } = useApp();
  const [searchParams] = useSearchParams();
  const [moduleName, setModuleName] = useState(searchParams.get('module') ?? 'leads');
  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [staticValues, setStaticValues] = useState<Record<string, string>>({});
  const [dateOrder, setDateOrder] = useState('dmy');
  // Review by default. The other two answer a per-row question with a
  // file-wide rule, and both are wrong often enough to lose real data —
  // "skip" throws away the corrected spelling and the new budget, "create"
  // leaves the desk with two of the same person.
  const [duplicateHandling, setDuplicateHandling] = useState('review');
  const [importMode, setImportMode] = useState('create');
  // Off on purpose: an import that queues five hundred WhatsApp greetings is
  // the failure this checkbox exists to prevent. Automations stay one tick
  // away for the day they are wanted.
  const [runWorkflows, setRunWorkflows] = useState(false);
  // On by default — see the tooltip beside it, and core/import/picklistGrowth.ts.
  const [createOptions, setCreateOptions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [openJob, setOpenJob] = useState<JobRow | null>(null);
  const [reviewJob, setReviewJob] = useState<JobRow | null>(null);

  const { data: jobs } = useQuery({
    queryKey: ['import-jobs'],
    queryFn: () => api.importJobs(),
    // Live while something is running, quiet otherwise. Two seconds because a
    // row lands about every hundred milliseconds; faster polls just re-render
    // the same numbers.
    refetchInterval: (query) =>
      (query.state.data as JobRow[] | undefined)?.some((j) => j.status === 'running') ? 2000 : false,
  });

  const cancel = async (id: string): Promise<void> => {
    try {
      await api.cancelImport(id);
      toast.success('Cancelling', 'The import stops on its current row.');
      void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    } catch (err) {
      toast.error('Could not cancel', (err as Error).message);
    }
  };

  /*
    The rehearsal.

    It runs the same preparation the import runs and rolls it back, so this
    screen is the answer rather than a second implementation that agrees most
    of the time. Re-run whenever a rule changes, because the outcome of a row
    depends on the mode: the same person is "new" under Add as new and
    "updates Amit Verma" under Add or update.
  */
  const check = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setStep('check');
    try {
      setDryRun(await api.importDryRun(moduleName, file, {
        mapping, importMode, staticValues, dateOrder, createOptions,
      }) as unknown as DryRun);
    } catch (err) {
      toast.error('Could not work out what the file would do', (err as Error).message);
      setStep('rules');
    } finally {
      setBusy(false);
    }
  };

  const reset = (): void => { setFile(null); setPreview(null); setMapping({}); setStaticValues({}); setDryRun(null); setStep('file'); };

  const analyse = async (selected: File): Promise<void> => {
    setBusy(true);
    setFile(selected);
    try {
      const result = await api.importPreview(moduleName, selected) as unknown as Preview;
      setPreview(result);
      setMapping(result.suggestedMapping);
      setDateOrder(result.dateOrder?.detected ?? 'dmy');
      setStep('columns');
    } catch (err) {
      toast.error('Could not read the file', (err as Error).message);
      setFile(null);
    } finally {
      setBusy(false);
    }
  };

  const run = async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await api.runImport(moduleName, file, {
        mapping, duplicateHandling, importMode, staticValues, dateOrder, runWorkflows, createOptions,
      });
      toast.success('Import started', `${result.totalRows} rows queued — progress appears below.`);
      reset();
      void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    } catch (err) {
      toast.error('Import failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const byHeader = useMemo(() => {
    const map: Record<string, Suggestion> = {};
    for (const s of preview?.suggestions ?? []) map[s.header] = s;
    return map;
  }, [preview]);

  const mappedCount = Object.values(mapping).filter(Boolean).length;
  /*
    A required field is answered by a column *or* by a fixed value.

    It used to count only columns, so a file with no Status column could not be
    imported at all — including when the person had just told the CRM that
    every row in it is New. That is the case fixed values exist for.
  */
  const unmappedMandatory = (preview?.fields ?? []).filter((f) => f.mandatory
    && !Object.values(mapping).includes(f.name)
    && !String(staticValues[f.name] ?? '').trim());
  // A field the file has no column for is a candidate for one fixed value.
  // Offering a field that is already mapped would mean two answers for one
  // box, and the column has to win, so it is not offered at all.
  const spareFields = (preview?.fields ?? [])
    .filter((f) => !Object.values(mapping).includes(f.name) && !(f.name in staticValues));
  const hasDates = (preview?.headers ?? []).some((h) => {
    const target = mapping[h];
    const field = preview?.fields.find((f) => f.name === target);
    return field?.uitype === 'date' || field?.uitype === 'datetime';
  });

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Import Data</h1>
        <p className="text-sm text-muted">
          Bring existing contacts or inventory in from Excel or a CSV. Columns are matched to fields
          automatically, and nothing is written until you have seen what it will do.
        </p>
      </div>

      {preview && (
        <div className="mb-4 flex items-center gap-2">
          {STEPS.map((s, i) => {
            const done = STEPS.findIndex((x) => x.key === step) > i;
            return (
              <div key={s.key} className="flex items-center gap-2">
                <button
                  onClick={() => done && setStep(s.key)}
                  disabled={!done}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                    step === s.key ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                      : done ? 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                        : 'bg-slate-50 text-slate-400 dark:bg-slate-900 dark:text-slate-600',
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : <span className="tnum">{i + 1}</span>}
                  {s.label}
                </button>
                {i < STEPS.length - 1 && <span className="text-slate-300">›</span>}
              </div>
            );
          })}
          <button onClick={reset} className="ml-auto btn-secondary btn-sm">
            <X className="h-3.5 w-3.5" /> Start again
          </button>
        </div>
      )}

      {step === 'file' && (
        <div className="card mb-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-56">
              <label className="label">Import into</label>
              <Select
                value={moduleName}
                onChange={(v) => { setModuleName(v); reset(); }}
                options={modules.filter((m) => m.isEntity && m.permissions.import)
                  .map((m) => ({ value: m.name, label: m.label }))}
              />
            </div>

            <label className="btn-primary cursor-pointer">
              {busy ? <Spinner /> : <FileUp className="h-4 w-4" />}
              {file ? file.name : 'Choose Excel or CSV file'}
              <input
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void analyse(f); e.target.value = ''; }}
              />
            </label>

            <a
              className="btn-secondary"
              href={authedFileUrl(`/api/import/${moduleName}/template`)}
              download
              title="A ready-made sheet with the right columns and one example row. Opens in Excel."
            >
              <Download className="h-4 w-4" /> Template
            </a>
          </div>
          <p className="mt-3 text-xs text-muted">
            The first row must name the columns. Nothing is imported from this step — the next screen
            shows what each column was understood to be.
          </p>
        </div>
      )}

      {step === 'columns' && preview && (
        <div className="card mb-4 overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <div>
              <p className="text-sm font-medium">What each column is</p>
              <p className="text-xs text-muted">
                {mappedCount} of {preview.headers.length} matched · {preview.totalRows} rows in {file?.name}
              </p>
            </div>
            {hasDates && (
              <div className="ml-auto w-72">
                <label className="label">
                  Dates in this file are written
                  {!preview.dateOrder.certain && (
                    <span className="ml-1 text-2xs text-amber-600">every date is before the 13th — please confirm</span>
                  )}
                </label>
                <Select value={dateOrder} onChange={setDateOrder} options={DATE_ORDERS} className="py-1.5 text-sm" />
              </div>
            )}
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {preview.headers.map((header) => {
              const hint = byHeader[header];
              const chosen = mapping[header] ?? '';
              return (
                <div key={header} className="flex flex-wrap items-center gap-3 px-4 py-2">
                  <div className="w-52 shrink-0">
                    <p className="truncate text-sm font-medium">{header}</p>
                    <p className="truncate text-2xs text-muted">
                      e.g. {preview.sample[0]?.[header] || '(empty)'}
                    </p>
                  </div>
                  <span className="text-slate-300">→</span>
                  <Select
                    value={chosen}
                    onChange={(v) => setMapping({ ...mapping, [header]: v })}
                    placeholder="— Ignore this column —"
                    options={preview.fields.map((f) => ({
                      value: f.name,
                      label: `${f.label}${f.mandatory ? ' *' : ''}`,
                    }))}
                    className="max-w-xs py-1.5 text-sm"
                  />
                  {hint?.field && (
                    <span className="flex items-center gap-1.5" title={hint.reason}>
                      <Badge color={CONFIDENCE[hint.confidence].colour}>
                        {CONFIDENCE[hint.confidence].label}
                      </Badge>
                      {/* A guess the CRM did not dare fill in is one click away
                          rather than a menu to hunt through. */}
                      {chosen !== hint.field && (
                        <button
                          onClick={() => setMapping({ ...mapping, [header]: hint.field as string })}
                          className="text-2xs underline decoration-dotted underline-offset-2 text-muted hover:opacity-80"
                        >
                          use {preview.fields.find((f) => f.name === hint.field)?.label ?? hint.field}
                        </button>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
            <p className="text-sm font-medium">Also set on every row</p>
            <p className="mb-2 text-xs text-muted">
              For what is true of the whole file and has no column in it — “these are all referrals”.
              A column always wins over one of these.
            </p>
            <div className="space-y-2">
              {Object.entries(staticValues).map(([name, value]) => (
                <div key={name} className="flex items-center gap-2">
                  <span className="w-52 shrink-0 truncate text-sm">
                    {preview.fields.find((f) => f.name === name)?.label ?? name}
                  </span>
                  <FixedValueInput
                    field={preview.fields.find((f) => f.name === name)}
                    value={value}
                    onChange={(v) => setStaticValues({ ...staticValues, [name]: v })}
                  />
                  <button
                    onClick={() => {
                      const next = { ...staticValues };
                      delete next[name];
                      setStaticValues(next);
                    }}
                    className="text-slate-400 hover:text-negative"
                    title="Remove"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {spareFields.length > 0 && (
                <Select
                  value=""
                  onChange={(v) => v && setStaticValues({ ...staticValues, [v]: '' })}
                  placeholder="+ Add a fixed value"
                  options={spareFields.map((f) => ({ value: f.name, label: f.label }))}
                  className="max-w-xs py-1.5 text-sm"
                />
              )}
            </div>
          </div>

          {unmappedMandatory.length > 0 && (
            <p className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              These are required: {unmappedMandatory.map((f) => f.label).join(', ')}. Map a column to each,
              or set one value for the whole file below.
            </p>
          )}

          <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
            <button onClick={reset} className="btn-secondary">
              <ArrowLeft className="h-4 w-4" /> Choose another file
            </button>
            <button
              onClick={() => setStep('rules')}
              disabled={mappedCount === 0 || unmappedMandatory.length > 0}
              className="btn-primary ml-auto"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'rules' && preview && (
        <div className="card mb-4 overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">What to do with each row</p>
          </div>

          <div className="grid gap-2 p-4 sm:grid-cols-2">
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setImportMode(m.value)}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  importMode === m.value
                    ? 'border-slate-900 bg-slate-50 dark:border-white dark:bg-slate-800'
                    : 'border-slate-200 hover:border-slate-300 dark:border-slate-700',
                )}
              >
                <p className="text-sm font-medium">{m.title}</p>
                <p className="text-xs text-muted">{m.hint}</p>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
            <div className="w-64">
              <label className="label">When a row matches someone already here</label>
              <Select
                value={duplicateHandling}
                onChange={setDuplicateHandling}
                options={[
                  { value: 'review', label: 'Let me decide at the end' },
                  { value: 'skip', label: 'Skip duplicates' },
                  { value: 'create', label: 'Create anyway' },
                ]}
                className="py-1.5 text-sm"
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 pb-1.5">
              <input
                type="checkbox"
                checked={runWorkflows}
                onChange={(e) => setRunWorkflows(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="text-sm">Run automations (greeting queue, scoring, tasks)</span>
            </label>

            <label className="flex cursor-pointer items-center gap-2 pb-1.5">
              <input
                type="checkbox"
                checked={createOptions}
                onChange={(e) => setCreateOptions(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              {/* On, because the alternative is values that import and are then
                  invisible to every filter, view and report — a dropdown value
                  is a plain string on the record, not a link to the list. */}
              <span className="text-sm" title="A locality or status in the file that the CRM does not have yet is added to that dropdown. Options somebody deliberately deleted are never brought back.">
                Add new dropdown options found in the file
              </span>
            </label>
          </div>

          {duplicateHandling === 'review' && (
            <p className="mx-4 mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
              Rows that match a record already here — same mobile or email — are set aside rather than
              imported or thrown away. When the file finishes you get them side by side and choose,
              row by row, which values to keep.
            </p>
          )}

          <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
            <button onClick={() => setStep('columns')} className="btn-secondary">
              <ArrowLeft className="h-4 w-4" /> Back to columns
            </button>
            <button onClick={() => void check()} disabled={busy} className="btn-primary ml-auto">
              {busy ? <Spinner /> : <Check className="h-4 w-4" />}
              Show me what this will do
            </button>
          </div>
        </div>
      )}

      {step === 'check' && (
        <div className="card mb-4 overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <div>
              <p className="text-sm font-medium">What will happen</p>
              <p className="text-xs text-muted">
                {dryRun
                  ? `The first ${dryRun.shown} of ${dryRun.totalRows} rows, exactly as they would be saved. Nothing has been written.`
                  : 'Working it out…'}
              </p>
            </div>
            {dryRun && (
              <div className="ml-auto flex gap-3 text-xs">
                {(['created', 'updated', 'skipped', 'failed'] as const).map((o) => {
                  const n = dryRun.rows.filter((r) => r.outcome === o).length;
                  return n > 0 ? (
                    <span key={o} className="capitalize">
                      <span className={cn('tnum font-semibold',
                        o === 'failed' ? 'text-negative' : o === 'skipped' ? 'text-muted' : 'text-positive')}>{n}</span>{' '}
                      {o}
                    </span>
                  ) : null;
                })}
              </div>
            )}
          </div>

          {busy || !dryRun ? (
            <div className="p-8 text-center"><Spinner /></div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      {['Row', 'Will', 'Values'].map((h) => <th key={h} className="list-head">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {dryRun.rows.map((r) => (
                      <tr key={r.row}>
                        <td className="list-cell tnum text-muted">{r.row}</td>
                        <td className="list-cell whitespace-nowrap">
                          <Badge color={
                            r.outcome === 'failed' ? '#ef4444'
                              : r.outcome === 'skipped' ? '#94a3b8'
                                : r.outcome === 'updated' ? '#0ea5e9' : '#22c55e'
                          }>
                            {r.outcome === 'updated' ? 'update' : r.outcome === 'created' ? 'add' : r.outcome}
                          </Badge>
                          {r.matched && <span className="ml-1.5 text-2xs text-muted">{r.matched}</span>}
                        </td>
                        <td className="list-cell">
                          {r.problems.length > 0 ? (
                            <span className="text-xs text-negative">{r.problems.join(' · ')}</span>
                          ) : (
                            <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                              {Object.entries(r.values).map(([name, value]) => (
                                <span key={name}>
                                  <span className="text-muted">
                                    {preview?.fields.find((f) => f.name === name)?.label ?? name}
                                  </span>{' '}
                                  {shown(value, preview?.fields.find((f) => f.name === name)?.uitype)}
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(dryRun.optionsAdded.length > 0 || dryRun.optionsSkipped.length > 0) && (
                <div className="border-t border-slate-100 px-4 py-3 text-xs dark:border-slate-800">
                  {dryRun.optionsAdded.length > 0 && (
                    <p>
                      <span className="font-medium">New dropdown options this file adds:</span>{' '}
                      {dryRun.optionsAdded.join(', ')}
                    </p>
                  )}
                  {/* Named rather than counted: a value somebody deleted on
                      purpose is not coming back, and the rows carrying it are
                      about to be saved with a value no list offers. */}
                  {dryRun.optionsSkipped.length > 0 && (
                    <p className="mt-1 text-amber-700 dark:text-amber-400">
                      <span className="font-medium">Left out, because they were deleted on purpose:</span>{' '}
                      {dryRun.optionsSkipped.join(', ')}
                    </p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
                <button onClick={() => setStep('rules')} className="btn-secondary">
                  <ArrowLeft className="h-4 w-4" /> Change the rules
                </button>
                <button onClick={() => void run()} disabled={busy} className="btn-primary ml-auto">
                  {busy ? <Spinner /> : <Upload className="h-4 w-4" />}
                  Import {dryRun.totalRows} {dryRun.totalRows === 1 ? 'row' : 'rows'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
          <Database className="h-4 w-4 text-slate-400" />
          <p className="text-sm font-medium">Recent imports</p>
          <p className="ml-auto text-2xs text-muted">Click a number to see the rows behind it</p>
        </div>
        {!jobs?.length ? (
          <EmptyState title="No imports yet" />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                {['File', 'Module', 'Status', 'Created', 'Skipped', 'Failed', 'Duplicates', 'When', ''].map((h) => (
                  <th key={h} className="list-head">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:border-slate-800 dark:divide-slate-800">
              {(jobs as unknown as JobRow[]).map((job) => {
                const running = job.status === 'running';
                return (
                  <tr key={job.id}>
                    <td className="list-cell max-w-[14rem] truncate font-medium">{job.file_name}</td>
                    <td className="list-cell text-slate-500">{job.module_label ?? job.module}</td>
                    <td className="list-cell">
                      <Badge color={
                        job.status === 'completed' ? '#22c55e'
                          : job.status === 'cancelled' ? '#f59e0b'
                          : job.status === 'running' || job.status === 'cancelling' ? '#0ea5e9' : '#94a3b8'
                      }>
                        {job.status}
                      </Badge>
                      {running && (
                        <span className="ml-1.5 text-2xs text-muted tnum">
                          {job.processed_rows}/{job.total_rows}
                        </span>
                      )}
                    </td>
                    <td className="list-cell">
                      <CountButton count={job.created_rows} onClick={() => setOpenJob(job)} tone="positive" />
                    </td>
                    <td className="list-cell">
                      <CountButton count={job.skipped_rows} onClick={() => setOpenJob(job)} tone="muted" />
                    </td>
                    <td className="list-cell">
                      <CountButton count={job.failed_rows} onClick={() => setOpenJob(job)} tone={job.failed_rows > 0 ? 'negative' : 'muted'} />
                    </td>
                    <td className="list-cell">
                      {job.pending_rows > 0 ? (
                        <button
                          onClick={() => setReviewJob(job)}
                          className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-2xs font-semibold text-amber-900 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900"
                          title="Look at each one beside the record it matched, and decide"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          {job.pending_rows} to review
                        </button>
                      ) : job.duplicate_rows > 0 ? (
                        <span className="text-2xs text-muted tnum" title="All reviewed">
                          {job.duplicate_rows} reviewed
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="list-cell text-2xs text-muted">{relativeTime(job.created_at)}</td>
                    <td className="list-cell text-right">
                      {running ? (
                        <button onClick={() => void cancel(job.id)} className="btn-secondary btn-sm">
                          Cancel
                        </button>
                      ) : (
                        <ResultDownload job={job} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {openJob && <JobDetailsModal job={openJob} onClose={() => setOpenJob(null)} />}
      {reviewJob && (
        <ImportDuplicateReview
          jobId={reviewJob.id}
          fileName={reviewJob.file_name}
          onClose={() => setReviewJob(null)}
        />
      )}
    </div>
  );
}

/**
 * The value as it will be stored, written the way it is read.
 *
 * 35000000 is the number in the database and nobody checks it by counting
 * zeros — which is exactly what this screen is for.
 */
function shown(value: unknown, uitype?: string): string {
  if (value === null || value === undefined) return '';
  if ((uitype === 'currency' || uitype === 'decimal') && Number.isFinite(Number(value))) {
    return formatIndianPrice(Number(value));
  }
  return String(value);
}

/**
 * One value for the whole file, in the field's own vocabulary.
 *
 * A dropdown gets its list. Typing "new" free-hand into a status writes a
 * value that is stored, offered by nothing, and matched by no view — the same
 * orphaning a renamed option causes, arrived at from the other end.
 */
function FixedValueInput({ field, value, onChange }: {
  field?: { uitype: string; options: { value: string; label: string }[] };
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const list = field?.options ?? [];
  if (list.length > 0) {
    return (
      <Select
        value={value}
        onChange={onChange}
        placeholder="— Choose —"
        options={list.map((o) => ({ value: o.value, label: o.label }))}
        className="max-w-xs py-1.5 text-sm"
      />
    );
  }
  return (
    <input
      className="input max-w-xs py-1.5 text-sm"
      type={field?.uitype === 'date' ? 'date' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * The finished import, as sheets you can open in Excel.
 *
 * One file per outcome, not one file with three tabs: CSV has no tabs, and a
 * single file pretending to hold three is either three headers glued together
 * (which Excel reads as one broken table) or a lie about the format. "Everything"
 * is the fourth option — every row with its outcome in a column, which is the
 * one to filter and pivot.
 *
 * The failed sheet is the useful one: it carries the original line number and
 * the mapped values, so the fix is edit, save, re-import that file alone.
 */
function ResultDownload({ job }: { job: JobRow }): JSX.Element | null {
  const base = job.file_name.replace(/\.csv$/i, '') || 'import';
  const sections: { key: ImportSection; label: string; count: number }[] = [
    { key: 'all', label: 'Everything', count: job.total_rows },
    { key: 'created', label: 'Created', count: job.created_rows },
    { key: 'updated', label: 'Merged into existing', count: job.updated_rows ?? 0 },
    { key: 'skipped', label: 'Skipped', count: job.skipped_rows },
    { key: 'failed', label: 'Failed', count: job.failed_rows },
    { key: 'duplicates', label: 'Duplicates', count: job.duplicate_rows ?? 0 },
  ];

  return (
    <Dropdown
      trigger={
        <button className="btn-secondary btn-sm" title="Download this import's result as CSV">
          <Download className="h-3.5 w-3.5" />
          Result
        </button>
      }
    >
      {(close) => (
        <>
          {sections.map(({ key, label, count }) => (
            <a
              key={key}
              href={api.importResultUrl(job.id, key, base)}
              download
              onClick={close}
              // A section with nothing in it still downloads — an empty sheet
              // with the right headers is a truthful answer, and hiding the
              // row makes the menu jump around between jobs.
              className={cn(count === 0 && 'opacity-50')}
            >
              <DropdownItem icon={<Download className="h-3.5 w-3.5" />}>
                {label} <span className="ml-1 text-2xs text-muted tnum">({count})</span>
              </DropdownItem>
            </a>
          ))}
        </>
      )}
    </Dropdown>
  );
}

function CountButton({ count, onClick, tone }: {
  count: number; onClick: () => void; tone: 'positive' | 'negative' | 'muted';
}): JSX.Element {
  const colour = tone === 'positive' ? 'text-positive'
    : tone === 'negative' ? 'text-negative'
    : 'text-slate-600 dark:text-slate-300';
  return (
    <button
      onClick={onClick}
      disabled={count === 0}
      className={cn('tnum tabular-nums', colour, count > 0 && 'cursor-pointer underline decoration-dotted underline-offset-2 hover:opacity-80')}
      title="Show the rows"
    >
      {count || '—'}
    </button>
  );
}

function JobDetailsModal({ job, onClose }: { job: JobRow; onClose: () => void }): JSX.Element {
  const [section, setSection] = useState<'created' | 'skipped' | 'failed' | 'options'>(
    job.failed_rows > 0 ? 'failed' : job.skipped_rows > 0 ? 'skipped' : 'created',
  );
  // What the file taught the CRM: dropdown options it did not have, and the
  // ones it deliberately does not want back. Worth showing rather than only
  // counting — a typo in a spreadsheet becomes a permanent option otherwise,
  // and this is where somebody spots it.
  const optionsAdded = job.details?.optionsAdded ?? [];
  const optionsSkipped = job.details?.optionsSkipped ?? [];
  const lists = {
    created: job.details?.created ?? [],
    skipped: job.details?.skipped ?? [],
    failed: (job.errors ?? []).map((e) => (e.row ? `row ${e.row} — ${e.error}` : e.error)),
    options: [
      ...optionsAdded.map((o) => `Added  ${o}`),
      ...optionsSkipped.map((o) => `Left out (deleted on purpose)  ${o}`),
    ],
  };
  const CAP = 300;
  const items = lists[section];
  const total = section === 'created' ? job.created_rows
    : section === 'skipped' ? job.skipped_rows
      : section === 'failed' ? job.failed_rows : lists.options.length;

  return (
    <Modal open title={`Import — ${job.file_name}`} onClose={onClose} size="lg">
      <div className="mb-3 flex gap-1.5">
        {(['created', 'skipped', 'failed', ...(lists.options.length ? ['options' as const] : [])] as const).map((key) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors',
              section === key ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
            )}
          >
            {key === 'options' ? 'new options' : key}{' '}
            ({key === 'created' ? job.created_rows
              : key === 'skipped' ? job.skipped_rows
                : key === 'failed' ? job.failed_rows : lists.options.length})
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState title={`Nothing ${section} yet`} />
      ) : (
        <>
          {total > CAP && (
            <p className="mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-2xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              Showing the first {CAP} of {total}.
            </p>
          )}
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {items.map((line, i) => (
              <li key={i} className="px-1 py-1.5 text-sm">{line}</li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
