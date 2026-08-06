import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FieldMeta, ModuleMeta, RecordEnvelope, TimelineEntry } from '@ipropy/shared';
import { formatIndianPrice, relativeTime } from '@ipropy/shared';
import * as Icons from 'lucide-react';
import {
  Activity, ChevronDown, ChevronLeft, Edit3, Link2, MessageCircle, MoreHorizontal,
  Paperclip, Phone, Send, Sparkles, Star, Trash2, UserCheck,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { useWatchRecord } from '../lib/realtime';
import { invalidateRecordQueries } from '../lib/invalidate';
import { cn, renderMarkdown } from '../lib/utils';
import { FieldValue } from '../components/FieldRenderer';
import {
  Avatar, Badge, ConfirmDialog, Dropdown, DropdownItem, EmptyState, Modal,
  ScoreChip, Skeleton, Spinner, Tabs,
} from '../components/ui';
import { ModuleIcon } from '../components/Layout';
import ConvertLeadModal from '../components/ConvertLeadModal';
import ComposeModal from '../components/ComposeModal';

export default function RecordDetail(): JSX.Element {
  const { module: moduleName, id } = useParams<{ module: string; id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, aiAvailable } = useApp();

  const [tab, setTab] = useState('overview');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showConvert, setShowConvert] = useState(false);
  const [compose, setCompose] = useState<'whatsapp' | 'email' | null>(null);

  const { data: meta } = useQuery({
    queryKey: ['module', moduleName],
    queryFn: () => api.module(moduleName!),
    enabled: Boolean(moduleName),
  });

  const { data: record, isLoading, refetch } = useQuery({
    queryKey: ['record', moduleName, id],
    queryFn: () => api.record(moduleName!, id!),
    enabled: Boolean(moduleName && id),
  });

  // Join this record's realtime room so workflow/AI writes that land after the
  // response (lead scoring, lifecycle promotion) appear without a refresh.
  useWatchRecord(id);

  const deleteMutation = useMutation({
    mutationFn: () => api.remove(moduleName!, id!),
    onSuccess: () => {
      toast.success('Record deleted');
      invalidateRecordQueries(queryClient, moduleName, id);
      navigate(`/${moduleName}`);
    },
  });

  const starMutation = useMutation({
    mutationFn: (starred: boolean) => api.star(moduleName!, id!, starred),
    onSuccess: () => void refetch(),
  });

  if (isLoading || !meta || !record) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-96 lg:col-span-2" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  const layoutConfig = (meta.layouts?.find((l) => l.type === 'detail' && l.is_default)?.config ?? {}) as {
    blocks?: { key: string; label: string; columns: number; collapsed?: boolean; fields: string[] }[];
    headerFields?: string[];
    relatedLists?: string[];
  };

  const fieldMap = new Map(meta.fields.map((f) => [f.name, f]));
  const phone = String(record.values.mobile ?? record.values.phone ?? record.values.whatsapp_number ?? '');
  const email = String(record.values.email ?? '');

  const tabs = [
    { key: 'overview', label: 'Overview', icon: <Icons.LayoutDashboard className="h-3.5 w-3.5" /> },
    { key: 'timeline', label: 'Timeline', icon: <Activity className="h-3.5 w-3.5" /> },
    ...(meta.relations.length ? [{ key: 'related', label: 'Related', icon: <Link2 className="h-3.5 w-3.5" /> }] : []),
    { key: 'files', label: 'Files', icon: <Paperclip className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="mx-auto max-w-[1600px] p-4 sm:p-6">
      {/* Header */}
      <div className="card mb-4 overflow-hidden">
        <div className="flex flex-wrap items-start gap-4 p-4 sm:p-5">
          <button onClick={() => navigate(`/${moduleName}`)} className="btn-ghost -ml-2 p-1.5" title="Back">
            <ChevronLeft className="h-4 w-4" />
          </button>

          <Avatar name={record.label} size={48} />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{record.label}</h1>
              {record.recordNumber && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-2xs text-slate-500 dark:bg-slate-800">
                  {record.recordNumber}
                </span>
              )}
              {meta.pipelineField && record.values[meta.pipelineField] != null && (
                <FieldValue
                  field={fieldMap.get(meta.pipelineField)!}
                  value={record.values[meta.pipelineField]}
                />
              )}
              {typeof record.values.ai_score === 'number' && (
                <span className="inline-flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-brand-500" />
                  <ScoreChip score={record.values.ai_score as number} />
                </span>
              )}
              {typeof record.values.ai_risk_score === 'number' && (
                <span className="inline-flex items-center gap-1 text-2xs text-slate-500">
                  Risk <ScoreChip score={record.values.ai_risk_score as number} invert />
                </span>
              )}
            </div>

            {/* Header summary chips */}
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-slate-600 dark:text-slate-400">
              {(layoutConfig.headerFields ?? []).slice(0, 5).map((name) => {
                const field = fieldMap.get(name);
                if (!field || record.values[name] == null || record.values[name] === '') return null;
                if (name === meta.pipelineField) return null;
                return (
                  <span key={name} className="inline-flex items-center gap-1.5">
                    <span className="text-slate-400">{field.label}:</span>
                    <FieldValue field={field} value={record.values[name]} display={record.display?.[name]} compact />
                  </span>
                );
              })}
              <span className="inline-flex items-center gap-1.5">
                <span className="text-slate-400">Owner:</span>
                {record.display?.owner_id
                  ? <span className="inline-flex items-center gap-1"><Avatar name={record.display.owner_id} size={16} />{record.display.owner_id}</span>
                  : <span className="text-slate-400">Unassigned</span>}
              </span>
              <span className="text-slate-400">Updated {relativeTime(record.updatedAt)}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => starMutation.mutate(!record.starred)}
              className="btn-ghost p-2"
              title={record.starred ? 'Remove from starred' : 'Star this record'}
            >
              <Star className={cn('h-4 w-4', record.starred && 'fill-amber-400 text-amber-400')} />
            </button>

            {phone && (
              <>
                <CallButton to={phone} recordId={record.id} module={moduleName!} />
                <button onClick={() => setCompose('whatsapp')} className="btn-secondary btn-sm" title="WhatsApp">
                  <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="hidden sm:inline">WhatsApp</span>
                </button>
              </>
            )}
            {email && (
              <button onClick={() => setCompose('email')} className="btn-secondary btn-sm" title="Email">
                <Send className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Email</span>
              </button>
            )}

            {meta.supportsConversion && !record.values.is_converted && (
              <button onClick={() => setShowConvert(true)} className="btn-primary btn-sm">
                <UserCheck className="h-3.5 w-3.5" /> Convert
              </button>
            )}

            {record.can?.edit && (
              <Link to={`/${moduleName}/${id}/edit`} className="btn-secondary btn-sm">
                <Edit3 className="h-3.5 w-3.5" /> Edit
              </Link>
            )}

            <Dropdown trigger={<button className="btn-ghost p-2"><MoreHorizontal className="h-4 w-4" /></button>}>
              {(close) => (
                <>
                  {aiAvailable && (
                    <DropdownItem
                      icon={<Sparkles className="h-3.5 w-3.5" />}
                      onClick={() => {
                        close();
                        void api.summarise(moduleName!, id!)
                          .then((r) => toast.info('AI summary', r.summary))
                          .catch((e: Error) => toast.error('Summary failed', e.message));
                      }}
                    >
                      Summarise with AI
                    </DropdownItem>
                  )}
                  {record.can?.delete && (
                    <DropdownItem
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      danger
                      onClick={() => { setConfirmDelete(true); close(); }}
                    >
                      Delete record
                    </DropdownItem>
                  )}
                </>
              )}
            </Dropdown>
          </div>
        </div>

        <Tabs tabs={tabs} active={tab} onChange={setTab} className="px-4 sm:px-5" />
      </div>

      {/* Body */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {tab === 'overview' && <OverviewTab meta={meta} record={record} layoutConfig={layoutConfig} />}
          {tab === 'timeline' && <TimelineTab module={moduleName!} id={id!} />}
          {tab === 'related' && <RelatedTab meta={meta} module={moduleName!} id={id!} />}
          {tab === 'files' && <FilesTab module={moduleName!} id={id!} />}
        </div>

        <div className="space-y-4">
          <AiPanel module={moduleName!} record={record} meta={meta} />
          <CommentsPanel module={moduleName!} id={id!} currentUser={user?.fullName ?? ''} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => deleteMutation.mutateAsync()}
        title={`Delete ${record.label}?`}
        body="The record moves to the recycle bin and can be restored by an administrator."
        confirmLabel="Delete"
        danger
      />

      {showConvert && (
        <ConvertLeadModal
          record={record}
          onClose={() => setShowConvert(false)}
          onConverted={(result) => {
            setShowConvert(false);
            toast.success('Lead converted');
            void refetch();
            if (result.dealId) navigate(`/deals/${result.dealId}`);
          }}
        />
      )}

      {compose && (
        <ComposeModal
          channel={compose}
          module={moduleName!}
          record={record}
          onClose={() => setCompose(null)}
          onSent={() => { setCompose(null); void refetch(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function OverviewTab({
  meta, record, layoutConfig,
}: {
  meta: ModuleMeta;
  record: RecordEnvelope;
  layoutConfig: { blocks?: { key: string; label: string; columns: number; collapsed?: boolean; fields: string[] }[] };
}): JSX.Element {
  const fieldMap = new Map(meta.fields.map((f) => [f.name, f]));
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set((layoutConfig.blocks ?? []).filter((b) => b.collapsed).map((b) => b.key)),
  );

  const blocks = layoutConfig.blocks?.length
    ? layoutConfig.blocks
    : meta.blocks.map((b) => ({
        key: b.name, label: b.label, columns: b.columns,
        collapsed: b.isCollapsed, fields: b.fields.map((f) => f.name),
      }));

  return (
    <>
      {blocks.map((block) => {
        const isCollapsed = collapsed.has(block.key);
        const fields = block.fields
          .map((n) => fieldMap.get(n))
          .filter((f): f is FieldMeta => Boolean(f))
          .filter((f) => f.isActive && f.displayType !== 'hidden')
          .filter((f) => {
            const v = record.values[f.name];
            // Hide empties in collapsed-by-default blocks to reduce noise.
            if (!block.collapsed) return true;
            return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
          });

        if (!fields.length) return null;

        return (
          <div key={block.key} className="card overflow-hidden">
            <button
              onClick={() => {
                const next = new Set(collapsed);
                if (isCollapsed) next.delete(block.key); else next.add(block.key);
                setCollapsed(next);
              }}
              className="flex w-full items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 text-left dark:border-slate-800 dark:bg-slate-800/40"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 transition-transform', isCollapsed && '-rotate-90')} />
              <span className="text-sm font-medium">{block.label}</span>
            </button>

            {!isCollapsed && (
              <dl className={cn(
                'grid gap-x-6 gap-y-3 p-4',
                block.columns === 1 ? 'grid-cols-1' : block.columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
              )}>
                {fields.map((field) => (
                  <div key={field.name} className={cn(field.config.fullWidth && 'sm:col-span-2')}>
                    <dt className="text-2xs font-medium uppercase tracking-wide text-slate-400">{field.label}</dt>
                    <dd className="mt-0.5 text-sm">
                      <FieldValue
                        field={field}
                        value={record.values[field.name]}
                        display={record.display?.[field.name]}
                        linkTo={field.uitype === 'reference' ? record.display?.[`${field.name}__module`] : undefined}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        );
      })}
    </>
  );
}

function TimelineTab({ module, id }: { module: string; id: string }): JSX.Element {
  const [filter, setFilter] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['timeline', module, id, filter],
    queryFn: () => api.timeline(module, id, filter ? [filter] : undefined),
  });

  const filters = [
    { key: null, label: 'All' },
    { key: 'call', label: 'Calls' },
    { key: 'message', label: 'Messages' },
    { key: 'comment', label: 'Notes' },
    { key: 'task', label: 'Tasks' },
    { key: 'audit', label: 'Changes' },
  ];

  return (
    <div className="card">
      <div className="flex flex-wrap gap-1 border-b border-slate-100 p-2 dark:border-slate-800">
        {filters.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.key)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              filter === f.key
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : !data?.length ? (
        <EmptyState icon={<Activity className="h-8 w-8" />} title="No activity yet" body="Calls, messages and changes will appear here." />
      ) : (
        <div className="p-4">
          <ol className="relative space-y-4 border-l border-slate-200 pl-6 dark:border-slate-800">
            {data.map((entry) => <TimelineItem key={entry.id} entry={entry} />)}
          </ol>
        </div>
      )}
    </div>
  );
}

function TimelineItem({ entry }: { entry: TimelineEntry }): JSX.Element {
  const pascal = entry.icon.split('-').map((p) => p[0]?.toUpperCase() + p.slice(1)).join('');
  const Icon = (Icons as unknown as Record<string, React.FC<{ className?: string }>>)[pascal] ?? Icons.Circle;

  const tone: Record<string, string> = {
    call: 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400',
    message: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400',
    email: 'bg-sky-100 text-sky-600 dark:bg-sky-950 dark:text-sky-400',
    comment: 'bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400',
    ai: 'bg-brand-100 text-brand-600 dark:bg-brand-950 dark:text-brand-400',
    site_visit: 'bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400',
    payment: 'bg-teal-100 text-teal-600 dark:bg-teal-950 dark:text-teal-400',
    task: 'bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400',
  };

  const recordingUrl = entry.meta?.recordingUrl as string | undefined;

  return (
    <li className="relative">
      <span className={cn(
        'absolute -left-[2.1rem] flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-white dark:ring-slate-900',
        tone[entry.type] ?? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
      )}>
        <Icon className="h-3 w-3" />
      </span>

      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{entry.title}</p>
        <span className="text-2xs text-slate-400">
          {entry.actorName} · {relativeTime(entry.at)}
        </span>
      </div>

      {entry.body && (
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-400">{entry.body}</p>
      )}

      {entry.meta?.sentiment != null && (
        <Badge
          className="mt-1"
          color={entry.meta.sentiment === 'positive' ? '#22c55e' : entry.meta.sentiment === 'negative' ? '#ef4444' : '#94a3b8'}
        >
          {String(entry.meta.sentiment)}
        </Badge>
      )}

      {recordingUrl && (
        <audio controls src={recordingUrl} className="mt-2 h-8 w-full max-w-sm" />
      )}
    </li>
  );
}

function RelatedTab({ meta, module, id }: { meta: ModuleMeta; module: string; id: string }): JSX.Element {
  const [active, setActive] = useState(meta.relations[0]?.name ?? '');
  const relation = meta.relations.find((r) => r.name === active);

  const { data, isLoading } = useQuery({
    queryKey: ['related', module, id, active],
    queryFn: () => api.related(module, id, active),
    enabled: Boolean(active),
  });

  const { data: targetMeta } = useQuery({
    queryKey: ['module', relation?.targetModule],
    queryFn: () => api.module(relation!.targetModule),
    enabled: Boolean(relation?.targetModule),
  });

  if (!meta.relations.length) {
    return <div className="card"><EmptyState title="No related lists configured" /></div>;
  }

  const columns = relation?.columns?.length
    ? relation.columns
    : (targetMeta?.fields ?? []).filter((f) => f.isActive && f.displayType !== 'hidden').slice(0, 5).map((f) => f.name);
  const fieldMap = new Map((targetMeta?.fields ?? []).map((f) => [f.name, f]));

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap gap-1 border-b border-slate-100 p-2 dark:border-slate-800">
        {meta.relations.map((r) => (
          <button
            key={r.name}
            onClick={() => setActive(r.name)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              active === r.name
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : !data?.rows.length ? (
        <EmptyState
          title={`No ${relation?.label.toLowerCase()} yet`}
          action={
            relation && (
              <Link
                to={`/${relation.targetModule}/new?${relation.foreignField}=${id}`}
                className="btn-secondary btn-sm"
              >
                <Icons.Plus className="h-3.5 w-3.5" /> Add
              </Link>
            )
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} className="table-head">{fieldMap.get(c)?.label ?? c}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  {columns.map((c, i) => {
                    const field = fieldMap.get(c);
                    return (
                      <td key={c} className="table-cell">
                        {i === 0 ? (
                          <Link to={`/${relation!.targetModule}/${row.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                            {field ? <FieldValue field={field} value={row.values[c]} display={row.display?.[c]} compact /> : row.label}
                          </Link>
                        ) : field ? (
                          <FieldValue field={field} value={row.values[c]} display={row.display?.[c]} compact />
                        ) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilesTab({ module, id }: { module: string; id: string }): JSX.Element {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['files', id],
    queryFn: () => api.files(id),
  });
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    try {
      await api.uploadFile(file, id, module);
      toast.success('File uploaded', file.name);
      void queryClient.invalidateQueries({ queryKey: ['files', id] });
      void queryClient.invalidateQueries({ queryKey: ['timeline', module, id] });
    } catch (err) {
      toast.error('Upload failed', (err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card">
      <div className="border-b border-slate-100 p-3 dark:border-slate-800">
        <label className="btn-secondary btn-sm cursor-pointer">
          {uploading ? <Spinner /> : <Paperclip className="h-3.5 w-3.5" />}
          Upload file
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
          />
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : !data?.length ? (
        <EmptyState icon={<Paperclip className="h-8 w-8" />} title="No files" body="Attach brochures, KYC documents or agreements." />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.map((f) => {
            const file = f as { id: string; file_name: string; size: number; mime_type: string; created_at: string; uploaded_by_name: string | null };
            return (
              <li key={file.id} className="flex items-center gap-3 p-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800">
                  <Icons.FileText className="h-4 w-4 text-slate-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.file_name}</p>
                  <p className="text-2xs text-slate-500">
                    {(file.size / 1024).toFixed(0)} KB · {file.uploaded_by_name ?? 'Unknown'} · {relativeTime(file.created_at)}
                  </p>
                </div>
                <a href={`/api/files/${file.id}`} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">
                  <Icons.Download className="h-3.5 w-3.5" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar panels
// ---------------------------------------------------------------------------

function AiPanel({
  module, record, meta,
}: { module: string; record: RecordEnvelope; meta: ModuleMeta }): JSX.Element {
  const queryClient = useQueryClient();
  const { aiAvailable } = useApp();
  const [busy, setBusy] = useState(false);

  const { data: insights } = useQuery({
    queryKey: ['insights', record.id],
    queryFn: () => api.insights(record.id),
  });

  const { data: matches } = useQuery({
    queryKey: ['matches', module, record.id],
    queryFn: () => api.matchProperties(module, record.id, false),
    enabled: ['leads', 'contacts'].includes(module),
  });

  const rescore = async (): Promise<void> => {
    setBusy(true);
    try {
      if (module === 'leads') await api.scoreLead(record.id);
      else if (module === 'deals') await api.analyseDeal(record.id);
      toast.success('Analysis refreshed');
      void queryClient.invalidateQueries({ queryKey: ['insights', record.id] });
      void queryClient.invalidateQueries({ queryKey: ['record', module, record.id] });
    } catch (err) {
      toast.error('Analysis failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canAnalyse = module === 'leads' || module === 'deals';

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <Sparkles className="h-4 w-4 text-brand-500" />
        <span className="text-sm font-medium">AI Insights</span>
        {canAnalyse && (
          <button onClick={() => void rescore()} disabled={busy} className="btn-ghost btn-sm ml-auto">
            {busy ? <Spinner className="h-3 w-3" /> : <Icons.RefreshCw className="h-3 w-3" />}
          </button>
        )}
      </div>

      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {(insights ?? []).slice(0, 3).map((raw) => {
          const insight = raw as { id: string; title: string; body: string; score: number | null; kind: string; created_at: string };
          return (
            <div key={insight.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium">{insight.title}</p>
                <button
                  onClick={() => {
                    void api.dismissInsight(insight.id)
                      .then(() => queryClient.invalidateQueries({ queryKey: ['insights', record.id] }));
                  }}
                  className="shrink-0 text-slate-300 hover:text-slate-500"
                  title="Dismiss"
                >
                  <Icons.X className="h-3 w-3" />
                </button>
              </div>
              <div
                className="prose-ai mt-1.5"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(insight.body) }}
              />
            </div>
          );
        })}

        {(!insights || insights.length === 0) && (
          <div className="px-4 py-6 text-center">
            <p className="text-xs text-slate-500">
              {aiAvailable ? 'No insights yet.' : 'AI insights use rule-based scoring until an API key is configured.'}
            </p>
            {canAnalyse && (
              <button onClick={() => void rescore()} disabled={busy} className="btn-secondary btn-sm mt-2">
                {busy && <Spinner className="h-3 w-3" />}
                {module === 'leads' ? 'Score this lead' : 'Analyse this deal'}
              </button>
            )}
          </div>
        )}

        {matches && matches.matches.length > 0 && (
          <div className="p-4">
            <p className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
              Matching inventory
            </p>
            <ul className="space-y-2">
              {matches.matches.slice(0, 4).map((raw) => {
                const m = raw as unknown as { propertyId: string; propertyLabel: string; score: number; price?: number; reasons: string[] };
                return (
                  <li key={m.propertyId} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
                    <div className="flex items-start justify-between gap-2">
                      <Link to={`/properties/${m.propertyId}`} className="truncate text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
                        {m.propertyLabel}
                      </Link>
                      <ScoreChip score={m.score} />
                    </div>
                    {m.price && (
                      <p className="mt-0.5 text-2xs font-semibold text-slate-600 tnum dark:text-slate-400">
                        {formatIndianPrice(m.price)}
                      </p>
                    )}
                    {m.reasons[0] && <p className="mt-1 text-2xs text-slate-500">{m.reasons[0]}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentsPanel({
  module, id, currentUser,
}: { module: string; id: string; currentUser: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);

  const { data } = useQuery({
    queryKey: ['comments', module, id],
    queryFn: () => api.comments(module, id),
  });

  const post = async (): Promise<void> => {
    if (!body.trim()) return;
    setPosting(true);
    try {
      await api.addComment(module, id, body.trim());
      setBody('');
      void queryClient.invalidateQueries({ queryKey: ['comments', module, id] });
      void queryClient.invalidateQueries({ queryKey: ['timeline', module, id] });
    } catch (err) {
      toast.error('Could not post the note', (err as Error).message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <span className="text-sm font-medium">Notes</span>
      </div>

      <div className="p-3">
        <textarea
          className="input text-sm"
          rows={2}
          placeholder="Add a note for the team…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void post();
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-2xs text-slate-400">⌘↵ to post</span>
          <button onClick={() => void post()} disabled={!body.trim() || posting} className="btn-primary btn-sm">
            {posting && <Spinner className="h-3 w-3" />} Post
          </button>
        </div>
      </div>

      <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
        {(data ?? []).map((raw) => {
          const c = raw as { id: string; body: string; user_name: string; created_at: string };
          return (
            <div key={c.id} className="flex gap-2.5 p-3">
              <Avatar name={c.user_name} size={26} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium">{c.user_name}</span>
                  <span className="text-2xs text-slate-400">{relativeTime(c.created_at)}</span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-400">{c.body}</p>
              </div>
            </div>
          );
        })}
        {(!data || data.length === 0) && (
          <p className="px-4 py-6 text-center text-xs text-slate-400">No notes yet</p>
        )}
      </div>
    </div>
  );
}

function CallButton({ to, recordId, module }: { to: string; recordId: string; module: string }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const { telephonyAvailable } = useApp();

  return (
    <button
      className="btn-secondary btn-sm"
      disabled={busy}
      title={telephonyAvailable ? `Call ${to}` : 'Configure a telephony provider to enable click-to-call'}
      onClick={async () => {
        setBusy(true);
        try {
          await api.call(to, recordId, module);
          toast.success('Calling…', `Your phone will ring first, then we connect ${to}`);
        } catch (err) {
          toast.error('Could not place the call', (err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5 text-blue-600" />}
      <span className="hidden sm:inline">Call</span>
    </button>
  );
}
