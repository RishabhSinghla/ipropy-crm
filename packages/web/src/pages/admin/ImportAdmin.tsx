import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@ipropy/shared';
import { Database, FileUp, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, EmptyState, Select, Skeleton, Spinner } from '../../components/ui';

interface Preview {
  headers: string[];
  sample: Record<string, string>[];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  fields: { name: string; label: string; uitype: string; mandatory: boolean }[];
}

export default function ImportAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  const { modules } = useApp();
  const [searchParams] = useSearchParams();
  const [moduleName, setModuleName] = useState(searchParams.get('module') ?? 'leads');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [duplicateHandling, setDuplicateHandling] = useState('skip');
  const [busy, setBusy] = useState(false);

  const { data: jobs } = useQuery({
    queryKey: ['import-jobs'],
    queryFn: () => api.importJobs(),
    refetchInterval: 5000,
  });

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
      const result = await api.runImport(moduleName, file, mapping, duplicateHandling);
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
          Bring existing leads, contacts or inventory in from a CSV. Columns are matched to fields automatically.
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
            {file ? file.name : 'Choose CSV file'}
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void analyse(f); e.target.value = ''; }}
            />
          </label>

          {preview && (
            <div className="w-52">
              <label className="label">Duplicate handling</label>
              <Select
                value={duplicateHandling}
                onChange={setDuplicateHandling}
                options={[
                  { value: 'skip', label: 'Skip duplicates' },
                  { value: 'create', label: 'Create anyway' },
                ]}
              />
            </div>
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
        </div>
        {!jobs?.length ? (
          <EmptyState title="No imports yet" />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                {['File', 'Module', 'Status', 'Created', 'Skipped', 'Failed', 'When'].map((h) => (
                  <th key={h} className="table-head">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(jobs as { id: string; file_name: string; module: string; status: string; total_rows: number; processed_rows: number; created_rows: number; skipped_rows: number; failed_rows: number; created_at: string }[])
                .map((job) => (
                  <tr key={job.id}>
                    <td className="table-cell max-w-[14rem] truncate font-medium">{job.file_name}</td>
                    <td className="table-cell capitalize text-slate-500">{job.module}</td>
                    <td className="table-cell">
                      <Badge color={
                        job.status === 'completed' ? '#22c55e'
                          : job.status === 'running' ? '#0ea5e9' : '#94a3b8'
                      }>
                        {job.status}
                      </Badge>
                      {job.status === 'running' && (
                        <span className="ml-1.5 text-2xs text-muted tnum">
                          {job.processed_rows}/{job.total_rows}
                        </span>
                      )}
                    </td>
                    <td className="table-cell tnum text-positive">{job.created_rows}</td>
                    <td className="table-cell tnum text-slate-500">{job.skipped_rows}</td>
                    <td className="table-cell tnum">
                      {job.failed_rows > 0 ? <span className="text-negative">{job.failed_rows}</span> : '—'}
                    </td>
                    <td className="table-cell text-2xs text-muted">{relativeTime(job.created_at)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
