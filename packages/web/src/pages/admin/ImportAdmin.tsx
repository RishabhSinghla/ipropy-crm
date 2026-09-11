import { type JSX, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatIndianPrice, relativeTime, UITYPES, type UIType } from '@ipropy/shared';
import {
  AlertTriangle, ArrowLeft, Check, Database, Download, FileUp, Save, Undo2, Upload, X,
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

interface ValueColumn {
  field: string;
  label: string;
  header: string;
  multi: boolean;
  options: { value: string; label: string }[];
  values: { raw: string; count: number; match: string | null }[];
}

interface MatchedTemplate {
  id: string;
  name: string;
  mapping: Record<string, string>;
  missing: string[];
  staticValues: Record<string, string>;
  settings: {
    importMode?: string; duplicateHandling?: string; dateOrder?: string; createOptions?: boolean;
    rowFilters?: { header: string; op: string; value: string }[];
  };
}

interface Preview {
  headers: string[];
  sample: Record<string, string>[];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  suggestions: Suggestion[];
  template: MatchedTemplate | null;
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
  filtered: number;
  filteredBecause: string;
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

/**
 * The kinds a column can be, taken from the one vocabulary.
 *
 * Written out by hand it drifts: "checkbox" was offered here and the API
 * rejected it, because the type is called `boolean`. Narrowed to what a
 * spreadsheet column can actually hold — a formula, a rollup or a file is not
 * something a CSV carries.
 */
const NEW_FIELD_TYPES: UIType[] = [
  'string', 'textarea', 'picklist', 'multipicklist', 'currency', 'decimal',
  'integer', 'percent', 'area', 'date', 'datetime', 'phone', 'email', 'url', 'boolean',
];

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
  const [template, setTemplate] = useState<MatchedTemplate | null>(null);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [valueColumns, setValueColumns] = useState<ValueColumn[]>([]);
  /** field → file value → the CRM's value, or '' for "leave this cell empty". */
  const [valueMap, setValueMap] = useState<Record<string, Record<string, string>>>({});
  const [openValues, setOpenValues] = useState<string | null>(null);
  /** The column somebody is making a field for. */
  const [newField, setNewField] = useState<{ header: string; label: string; uitype: string } | null>(null);
  /** Which rows of the file are wanted. Read the file's own columns, not the CRM's fields. */
  const [rowFilters, setRowFilters] = useState<{ header: string; op: string; value: string }[]>([]);
  const [openJob, setOpenJob] = useState<JobRow | null>(null);
  const [reviewJob, setReviewJob] = useState<JobRow | null>(null);
  const [undoJob, setUndoJob] = useState<JobRow | null>(null);

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
        mapping, importMode, staticValues, dateOrder, createOptions, valueMap, rowFilters,
      }) as unknown as DryRun);
    } catch (err) {
      toast.error('Could not work out what the file would do', (err as Error).message);
      setStep('rules');
    } finally {
      setBusy(false);
    }
  };

  const undo = async (job: JobRow): Promise<void> => {
    setUndoJob(null);
    try {
      const r = await api.rollbackImport(job.id);
      const kept = r.keptUpdates > 0
        ? ` ${r.keptUpdates} row${r.keptUpdates === 1 ? '' : 's'} updated a record that was already here — those changes stay.`
        : '';
      // Nothing removed and nothing left to remove are the same number and
      // not the same sentence. Saying "in the recycle bin" after removing
      // none of them is how a person concludes the button is broken.
      if (r.deleted === 0 && r.gone > 0) {
        toast.success('Already undone', `Those ${r.gone} records had gone already.${kept}`);
      } else {
        toast.success(
          `${r.deleted} record${r.deleted === 1 ? '' : 's'} removed`,
          `They are in the recycle bin, so nothing is destroyed.${kept}`,
        );
      }
      if (r.failed > 0) {
        toast.error(
          `${r.failed} could not be removed`,
          r.failures[0] ?? 'Open the record and delete it by hand.',
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    } catch (err) {
      toast.error('Could not undo the import', (err as Error).message);
    }
  };

  /*
    A column the CRM has no home for.

    The alternative is leaving the wizard, finding Modules & Fields, creating
    the field, coming back and starting the import again — at which point the
    column gets ignored instead, and the information in it is lost for good.
  */
  const createFieldFor = async (): Promise<void> => {
    if (!newField) return;
    try {
      const meta = await api.module(moduleName, { includeInactive: true }) as unknown as
        { blocks: { id: string }[] };
      const created = await api.createField(moduleName, {
        // The machine name, which the API asks for and no admin should have to
        // think about — it is the label with the punctuation taken out.
        name: newField.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '') || `column_${Date.now().toString(36)}`,
        label: newField.label.trim(),
        uitype: newField.uitype,
        blockId: meta.blocks[0]?.id,
        config: {},
      }) as unknown as { name: string; label: string; uitype: string };
      setPreview((p) => (p ? {
        ...p,
        fields: [...p.fields, {
          name: created.name, label: created.label, uitype: created.uitype,
          mandatory: false, options: [],
        }],
      } : p));
      setMapping((m) => ({ ...m, [newField.header]: created.name }));
      setNewField(null);
      toast.success('Field created', `“${created.label}” is on this module now, and the column maps to it.`);
    } catch (err) {
      toast.error('Could not create the field', (err as Error).message);
    }
  };

  const saveTemplate = async (): Promise<void> => {
    if (!saveAs?.trim() || !preview) return;
    try {
      const saved = await api.saveImportTemplate(moduleName, {
        name: saveAs.trim(),
        headers: preview.headers,
        mapping,
        staticValues,
        settings: { importMode, duplicateHandling, dateOrder, createOptions, rowFilters },
      });
      setTemplate({ id: saved.id, name: saved.name, mapping, missing: [], staticValues, settings: {} });
      setSaveAs(null);
      toast.success('Saved', `A file shaped like this one will use “${saved.name}” from now on.`);
    } catch (err) {
      toast.error('Could not save it', (err as Error).message);
    }
  };

  const reset = (): void => { setFile(null); setPreview(null); setMapping({}); setStaticValues({}); setDryRun(null); setTemplate(null); setValueMap({}); setRowFilters([]); setStep('file'); };

  const analyse = async (selected: File): Promise<void> => {
    setBusy(true);
    setFile(selected);
    try {
      const result = await api.importPreview(moduleName, selected) as unknown as Preview;
      setPreview(result);
      setMapping(result.suggestedMapping);
      setDateOrder(result.dateOrder?.detected ?? 'dmy');
      /*
        A file the CRM has been taught before arrives with its answers already
        filled in — mapping, the values set for the whole file, and the rules.
        The person still walks the same three screens, because a template is a
        starting point somebody chose once, not a decision made for them
        forever.
      */
      setTemplate(result.template);
      if (result.template) {
        setStaticValues(result.template.staticValues ?? {});
        const st = result.template.settings ?? {};
        if (st.importMode) setImportMode(st.importMode);
        if (st.duplicateHandling) setDuplicateHandling(st.duplicateHandling);
        if (st.dateOrder) setDateOrder(st.dateOrder);
        if (typeof st.createOptions === 'boolean') setCreateOptions(st.createOptions);
        if (Array.isArray(st.rowFilters)) setRowFilters(st.rowFilters);
      }
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
        templateId: template?.id, valueMap, rowFilters,
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

  /*
    What is actually in the dropdown columns.

    Asked of the whole file rather than the five-row sample, because the value
    that matters is usually the one that appears twice in four thousand rows.
    Re-asked when the mapping changes, keyed on the dropdown columns alone so
    that mapping a name or a phone number does not re-read the file.
  */
  const listedColumns = useMemo(() => JSON.stringify(
    Object.entries(mapping)
      .filter(([, name]) => {
        const f = preview?.fields.find((x) => x.name === name);
        return f && (f.options?.length ?? 0) > 0;
      })
      .sort(),
  ), [mapping, preview]);

  useEffect(() => {
    if (!file || !preview) { setValueColumns([]); return; }
    let alive = true;
    void api.importValues(moduleName, file, mapping)
      .then((r) => { if (alive) setValueColumns(r.columns as ValueColumn[]); })
      .catch(() => { if (alive) setValueColumns([]); });
    return () => { alive = false; };
    // `listedColumns` is the dependency that matters; mapping and file are read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedColumns, file, moduleName]);

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

      {/* The chips wrap rather than clip: on a phone the fourth step fell off
          the right edge, which reads as a three-step wizard ending at Rules. */}
      {preview && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
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
                {mappedCount} of {preview.headers.length} matched ·{' '}
                {preview.totalRows} {preview.totalRows === 1 ? 'row' : 'rows'} in {file?.name}
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

          {template && (
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs dark:border-slate-800 dark:bg-slate-800/50">
              <Check className="h-3.5 w-3.5 text-positive" />
              <span>
                This is the same shape as <span className="font-medium">{template.name}</span> — its
                mapping and rules are filled in.
              </span>
              {/* A column the template used to fill and can no longer: the
                  field was deleted since it was saved. Named, because the
                  alternative is a column that silently stops importing. */}
              {template.missing.length > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {template.missing.join(', ')} — that field no longer exists, so the column is ignored.
                </span>
              )}
              <button onClick={() => { setTemplate(null); setMapping(preview.suggestedMapping); }}
                className="ml-auto underline decoration-dotted underline-offset-2 text-muted hover:opacity-80">
                Ignore it
              </button>
            </div>
          )}

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {preview.headers.map((header) => {
              const hint = byHeader[header];
              const chosen = mapping[header] ?? '';
              const column = valueColumns.find((c) => c.header === header);
              // "New" means: the CRM has no such option and nobody has said
              // what it should be — so it is about to become one.
              const newHere = column
                ? column.values.filter((v) => !v.match && valueMap[column.field]?.[v.raw] === undefined).length
                : 0;
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
                    onChange={(v) => {
                      if (v === '__create') {
                        setNewField({ header, label: header, uitype: guessType(preview.sample.map((r) => r[header])) });
                        return;
                      }
                      setMapping({ ...mapping, [header]: v });
                    }}
                    placeholder="— Ignore this column —"
                    options={[
                      ...preview.fields.map((f) => ({
                        value: f.name,
                        label: `${f.label}${f.mandatory ? ' *' : ''}`,
                      })),
                      { value: '__create', label: '+ Create a field for this column' },
                    ]}
                    className="max-w-xs py-1.5 text-sm"
                  />
                  {column && (
                    <button
                      onClick={() => setOpenValues(openValues === header ? null : header)}
                      className="text-2xs underline decoration-dotted underline-offset-2 text-muted hover:opacity-80"
                      title="Say what each value in this column means"
                    >
                      {column.values.length} value{column.values.length === 1 ? '' : 's'}
                      {newHere > 0 && <span className="text-amber-600"> · {newHere} new</span>}
                    </button>
                  )}
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
                  {column && openValues === header && (
                    <div className="w-full rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                      <p className="mb-2 text-2xs text-muted">
                        What each value in <span className="font-medium">{header}</span> means. Anything
                        left as “Add it to the list” becomes a new option in {column.label}.
                      </p>
                      <div className="space-y-1.5">
                        {column.values.map((v) => (
                          <div key={v.raw} className="flex items-center gap-2">
                            <span className="w-44 shrink-0 truncate text-sm">
                              {v.raw}
                              <span className="ml-1 text-2xs text-muted tnum">×{v.count}</span>
                            </span>
                            <span className="text-slate-300">→</span>
                            <Select
                              value={valueMap[column.field]?.[v.raw] ?? (v.match ?? '__new')}
                              onChange={(chosenValue) => {
                                const forField = { ...(valueMap[column.field] ?? {}) };
                                // "Add it to the list" is the absence of a
                                // decision, not a decision to add — it leaves
                                // the importer's own growth in charge, which is
                                // what the Add new options switch governs.
                                if (chosenValue === '__new') delete forField[v.raw];
                                else forField[v.raw] = chosenValue;
                                setValueMap({ ...valueMap, [column.field]: forField });
                              }}
                              options={[
                                { value: '__new', label: v.match ? `Keep “${v.match}”` : 'Add it to the list' },
                                { value: '', label: 'Leave this cell empty' },
                                ...column.options.map((o) => ({ value: o.value, label: o.label })),
                              ]}
                              className="max-w-xs py-1 text-sm"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
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
            {/* A file the CRM already knows needs no second opinion on its
                rules — they came with the template. One click to the
                rehearsal, which is the screen worth keeping either way. */}
            {template && (
              <button
                onClick={() => void check()}
                disabled={mappedCount === 0 || unmappedMandatory.length > 0 || busy}
                className="btn-secondary ml-auto"
              >
                {busy ? <Spinner /> : <Check className="h-4 w-4" />}
                Straight to what will happen
              </button>
            )}
            <button
              onClick={() => setStep('rules')}
              disabled={mappedCount === 0 || unmappedMandatory.length > 0}
              className={cn('btn-primary', !template && 'ml-auto')}
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

          <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
            <p className="text-sm font-medium">Only import some of the rows</p>
            <p className="mb-2 text-xs text-muted">
              A portal export holds everything the portal has. Leave this empty to import all
              {preview.totalRows > 0 && ` ${preview.totalRows}`} of them.
            </p>
            <div className="space-y-2">
              {rowFilters.map((f, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select
                    value={f.header}
                    onChange={(v) => setRowFilters(rowFilters.map((x, j) => (j === i ? { ...x, header: v } : x)))}
                    placeholder="— Column —"
                    options={preview.headers.map((h) => ({ value: h, label: h }))}
                    className="max-w-[14rem] py-1.5 text-sm"
                  />
                  <Select
                    value={f.op}
                    onChange={(v) => setRowFilters(rowFilters.map((x, j) => (j === i ? { ...x, op: v } : x)))}
                    options={[
                      { value: 'is', label: 'is' },
                      { value: 'is_not', label: 'is not' },
                      { value: 'contains', label: 'contains' },
                      { value: 'does_not_contain', label: 'does not contain' },
                      { value: 'is_empty', label: 'is empty' },
                      { value: 'is_not_empty', label: 'is not empty' },
                    ]}
                    className="max-w-[11rem] py-1.5 text-sm"
                  />
                  {/* An empty-or-not test has nothing to compare against, and a
                      box there invites somebody to type into it and wonder why
                      it changes nothing. */}
                  {f.op !== 'is_empty' && f.op !== 'is_not_empty' && (
                    <input
                      className="input max-w-[12rem] py-1.5 text-sm"
                      value={f.value}
                      placeholder="Residential"
                      onChange={(e) => setRowFilters(rowFilters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    />
                  )}
                  <button
                    onClick={() => setRowFilters(rowFilters.filter((_, j) => j !== i))}
                    className="text-slate-400 hover:text-negative"
                    title="Remove"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setRowFilters([...rowFilters, { header: preview.headers[0] ?? '', op: 'is', value: '' }])}
                className="btn-secondary btn-sm"
              >
                + Add a condition
              </button>
            </div>
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
                    + (dryRun.filtered > 0
                      ? ` ${dryRun.filtered} row${dryRun.filtered === 1 ? '' : 's'} left out by your conditions — the first because ${dryRun.filteredBecause}.`
                      : '')
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
                {/* Offered here rather than at the start: what is worth saving
                    is the mapping that turned out to be right, and you only
                    know that once you have seen what it does. */}
                <button onClick={() => setSaveAs(template?.name ?? file?.name.replace(/\.(csv|xlsx)$/i, '') ?? '')}
                  className="btn-secondary">
                  <Save className="h-4 w-4" /> {template ? 'Update this template' : 'Save this mapping'}
                </button>
                <button onClick={() => void run()} disabled={busy} className="btn-primary ml-auto">
                  {busy ? <Spinner /> : <Upload className="h-4 w-4" />}
                  {/* What it will do, not how big the file is. A button
                      offering to import 3 rows next to a screen saying one of
                      them is left out is the wizard contradicting itself. */}
                  Import {dryRun.totalRows - dryRun.filtered}{' '}
                  {dryRun.totalRows - dryRun.filtered === 1 ? 'row' : 'rows'}
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
                        <span className="flex items-center justify-end gap-1.5">
                          <ResultDownload job={job} />
                          {job.created_rows > 0 && (
                            <button
                              onClick={() => setUndoJob(job)}
                              className="btn-secondary btn-sm"
                              title="Remove the records this file added"
                            >
                              <Undo2 className="h-3.5 w-3.5" /> Undo
                            </button>
                          )}
                        </span>
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
      {newField && (
        <Modal open title="Create a field for this column" onClose={() => setNewField(null)} size="sm">
          <label className="label">Call it</label>
          <input
            className="input"
            autoFocus
            value={newField.label}
            onChange={(e) => setNewField({ ...newField, label: e.target.value })}
          />
          <label className="label mt-3">What kind of value is it</label>
          <Select
            value={newField.uitype}
            onChange={(v) => setNewField({ ...newField, uitype: v })}
            options={NEW_FIELD_TYPES.map((t) => ({ value: t, label: UITYPES[t].label }))}
          />
          <p className="mt-2 text-2xs text-muted">
            Guessed from what is in the column — {preview?.sample[0]?.[newField.header] || 'no sample'}.
            It goes on this module straight away, so it is there for every record, not only this file.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setNewField(null)} className="btn-secondary">Cancel</button>
            <button onClick={() => void createFieldFor()} disabled={!newField.label.trim()} className="btn-primary">
              Create it
            </button>
          </div>
        </Modal>
      )}
      {saveAs !== null && preview && (
        <Modal open title="Save this mapping" onClose={() => setSaveAs(null)} size="sm">
          <p className="mb-3 text-sm text-muted">
            The next file with these same column headings will arrive with all of this filled in.
          </p>
          <label className="label">Call it</label>
          <input
            className="input"
            autoFocus
            value={saveAs}
            onChange={(e) => setSaveAs(e.target.value)}
            placeholder="99acres export"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setSaveAs(null)} className="btn-secondary">Cancel</button>
            <button
              onClick={() => void saveTemplate()}
              disabled={!saveAs.trim()}
              className="btn-primary"
            >
              <Save className="h-4 w-4" /> Save
            </button>
          </div>
        </Modal>
      )}
      {undoJob && (
        <Modal open title="Undo this import?" onClose={() => setUndoJob(null)} size="sm">
          <p className="text-sm">
            This removes the {undoJob.created_rows} record{undoJob.created_rows === 1 ? '' : 's'}{' '}
            <span className="font-medium">{undoJob.file_name}</span> added. They go to the recycle
            bin, so nothing is destroyed.
          </p>
          {/* Said before the click, not discovered after it. An update
              overwrote values that were never kept anywhere, so there is
              nothing to put back — and a button that says Undo and quietly
              leaves half the change is worse than no button. */}
          {undoJob.updated_rows > 0 && (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              {undoJob.updated_rows} row{undoJob.updated_rows === 1 ? '' : 's'} in this file updated a
              record that already existed. Those changes cannot be undone — the old values were not
              kept anywhere.
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setUndoJob(null)} className="btn-secondary">Keep them</button>
            <button onClick={() => void undo(undoJob)} className="btn-primary">
              <Undo2 className="h-4 w-4" /> Remove {undoJob.created_rows}
            </button>
          </div>
        </Modal>
      )}
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
 * What kind of value a column holds, from the few rows we have.
 *
 * A guess in a box somebody can change, not a decision: the only cost of
 * getting it wrong is one click, and the cost of asking with no default is
 * that everybody picks Text and loses the arithmetic.
 */
function guessType(samples: (string | undefined)[]): string {
  const seen = samples.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (!seen.length) return 'string';
  const every = (test: (v: string) => boolean): boolean => seen.every(test);
  if (every((v) => /@/.test(v))) return 'email';
  if (every((v) => /^[+\d][\d\s()-]{6,}$/.test(v))) return 'phone';
  if (every((v) => /^(https?:\/\/|www\.)/i.test(v))) return 'url';
  if (every((v) => /(cr|crore|lac|lakh|₹)/i.test(v) || /^[\d,]+(\.\d+)?$/.test(v))) {
    return every((v) => /(cr|crore|lac|lakh|₹)/i.test(v)) ? 'currency' : 'decimal';
  }
  if (every((v) => /^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/.test(v))) return 'date';
  if (every((v) => /^(yes|no|true|false|y|n)$/i.test(v))) return 'boolean';
  // A short vocabulary repeated down the column is a dropdown, not free text.
  if (seen.length > 2 && new Set(seen.map((v) => v.toLowerCase())).size <= Math.max(2, seen.length / 2)) {
    return 'picklist';
  }
  return 'string';
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
    /*
      A value the list does not have is shown, not hidden.

      A saved template can carry one — the option was renamed, or deleted, or
      the template named something this CRM never offered. A <select> given a
      value outside its options renders the placeholder, so the screen said
      "nothing chosen" while the import was still going to write "Portal".
    */
    const known = list.some((o) => o.value === value);
    const options = known || !value
      ? list.map((o) => ({ value: o.value, label: o.label }))
      : [{ value, label: `${value} — not in this list yet` }, ...list.map((o) => ({ value: o.value, label: o.label }))];
    return (
      <Select
        value={value}
        onChange={onChange}
        placeholder="— Choose —"
        options={options}
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
