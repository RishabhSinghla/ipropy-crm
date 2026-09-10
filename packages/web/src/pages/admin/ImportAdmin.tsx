import { type JSX, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import { AlertTriangle, Database, Download, FileUp, Upload } from 'lucide-react';
import { api, authedFileUrl, type ImportSection } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, Dropdown, DropdownItem, EmptyState, Modal, Select, Spinner } from '../../components/ui';
import { ImportDuplicateReview } from '../../components/ImportDuplicateReview';

interface Preview {
  headers: string[];
  sample: Record<string, string>[];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  fields: { name: string; label: string; uitype: string; mandatory: boolean }[];
}

interface JobRow {
  id: string; file_name: string; module: string; module_label: string; status: string;
  total_rows: number; processed_rows: number; created_rows: number;
  skipped_rows: number; failed_rows: number; created_at: string;
  duplicate_rows: number; pending_rows: number; updated_rows: number;
  errors: { row: number; error: string }[];
  details: { created: string[]; skipped: string[]; optionsAdded?: string[]; optionsSkipped?: string[] };
}

export default function ImportAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { modules } = useApp();
  const [searchParams] = useSearchParams();
  const [moduleName, setModuleName] = useState(searchParams.get('module') ?? 'leads');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // Review by default. The other two answer a per-row question with a
  // file-wide rule, and both are wrong often enough to lose real data —
  // "skip" throws away the corrected spelling and the new budget, "create"
  // leaves the desk with two of the same person.
  const [duplicateHandling, setDuplicateHandling] = useState('review');
  // Off on purpose: an import that queues five hundred WhatsApp greetings is
  // the failure this checkbox exists to prevent. Automations stay one tick
  // away for the day they are wanted.
  const [runWorkflows, setRunWorkflows] = useState(false);
  // On by default — see the tooltip beside it, and core/import/picklistGrowth.ts.
  const [createOptions, setCreateOptions] = useState(true);
  const [busy, setBusy] = useState(false);
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

  const analyse = async (selected: File): Promise<void> => {
    setBusy(true);
    setFile(selected);
    try {
      const result = await api.importPreview(moduleName, selected);
      setPreview(result as unknown as Preview);
      setMapping(result.suggestedMapping);
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
      const result = await api.runImport(moduleName, file, mapping, duplicateHandling, runWorkflows, createOptions);
      toast.success('Import started', `${result.totalRows} rows queued — progress appears below.`);
      setFile(null);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    } catch (err) {
      toast.error('Import failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const unmappedMandatory = (preview?.fields ?? [])
    .filter((f) => f.mandatory && !Object.values(mapping).includes(f.name));

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight">Import Data</h1>
        <p className="text-sm text-muted">
          Bring existing contacts or inventory in from Excel or a CSV. Columns are matched to fields
          automatically, and any dropdown value the file has and the CRM does not is added for you.
        </p>
      </div>

      <div className="card mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <label className="label">Import into</label>
            <Select
              value={moduleName}
              onChange={(v) => { setModuleName(v); setPreview(null); setFile(null); }}
              options={modules.filter((m) => m.isEntity && m.permissions.import)
                .map((m) => ({ value: m.name, label: m.label }))}
            />
          </div>

          <label className="btn-secondary cursor-pointer">
            {busy && !preview ? <Spinner /> : <FileUp className="h-4 w-4" />}
            {file ? file.name : 'Choose Excel or CSV file'}
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void analyse(f); e.target.value = ''; }}
            />
          </label>

          <a
            className="btn-secondary btn-sm"
            href={authedFileUrl(`/api/import/${moduleName}/template`)}
            download
            title="A ready-made sheet with the right columns and one example row. Opens in Excel."
          >
            <Download className="h-4 w-4" /> Template
          </a>

          {preview && (
            <div className="w-52">
              <label className="label">Duplicate handling</label>
              <Select
                value={duplicateHandling}
                onChange={setDuplicateHandling}
                options={[
                  { value: 'review', label: 'Let me decide at the end' },
                  { value: 'skip', label: 'Skip duplicates' },
                  { value: 'create', label: 'Create anyway' },
                ]}
              />
            </div>
          )}

          {preview && (
            <label className="flex cursor-pointer items-center gap-2 pb-0.5">
              <input
                type="checkbox"
                checked={runWorkflows}
                onChange={(e) => setRunWorkflows(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              <span className="text-sm">Run automations (greeting queue, scoring, tasks)</span>
            </label>
          )}

          {preview && (
            <label className="flex cursor-pointer items-center gap-2 pb-0.5">
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
          )}

          {preview && (
            <button
              onClick={() => void run()}
              disabled={busy || mappedCount === 0 || unmappedMandatory.length > 0}
              className="btn-primary ml-auto"
            >
              {busy ? <Spinner /> : <Upload className="h-4 w-4" />}
              Import {preview.totalRows} rows
            </button>
          )}
        </div>

        {duplicateHandling === 'review' && preview && (
          <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
            Rows that match a record already here — same mobile or email — are set aside rather than
            imported or thrown away. When the file finishes you get them side by side and choose,
            row by row, which values to keep.
          </p>
        )}

        {unmappedMandatory.length > 0 && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            Map a column to these required fields first: {unmappedMandatory.map((f) => f.label).join(', ')}
          </p>
        )}
      </div>

      {preview && (
        <div className="card mb-4 overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <p className="text-sm font-medium">Column mapping</p>
            <p className="text-xs text-muted">
              {mappedCount} of {preview.headers.length} columns mapped. Unmapped columns are ignored.
            </p>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {preview.headers.map((header) => (
              <div key={header} className="flex items-center gap-3 px-4 py-2">
                <div className="w-52 shrink-0">
                  <p className="truncate text-sm font-medium">{header}</p>
                  <p className="truncate text-2xs text-muted">
                    e.g. {preview.sample[0]?.[header] || '(empty)'}
                  </p>
                </div>
                <span className="text-slate-300">→</span>
                <Select
                  value={mapping[header] ?? ''}
                  onChange={(v) => setMapping({ ...mapping, [header]: v })}
                  placeholder="— Ignore this column —"
                  options={preview.fields.map((f) => ({
                    value: f.name,
                    label: `${f.label}${f.mandatory ? ' *' : ''}`,
                  }))}
                  className="max-w-xs py-1.5 text-sm"
                />
              </div>
            ))}
          </div>
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
