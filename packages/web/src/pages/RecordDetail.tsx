import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FieldMeta, ModuleMeta, RecordEnvelope, TimelineEntry } from '@ipropy/shared';
import { CALL_DISPOSITIONS, formatIndianPrice, relativeTime } from '@ipropy/shared';
import {
  Activity, Check, ChevronDown, Eye, FileQuestion, ChevronLeft, ChevronRight, Download, Edit3, FileText, LayoutDashboard,
  Link2, MessageCircle, MoreHorizontal, Paperclip, Phone, Plus, RefreshCw, Search, Send, Sparkles,
  Star, Trash2, UserCheck, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { useWatchRecord } from '../lib/realtime';
import { invalidateRecordQueries } from '../lib/invalidate';
import { loadListNav } from '../lib/listNav';
import { cn, renderMarkdown, restrictionForField } from '../lib/utils';
import { resolveIcon } from '../lib/icons';
import { FieldValue } from '../components/FieldRenderer';
import { EditableField, isInlineEditable } from '../components/EditableField';
import {
  Avatar, Badge, ConfirmDialog, Dropdown, DropdownItem, EmptyState, Modal,
  ScoreChip, Skeleton, Spinner, Tabs,
} from '../components/ui';
import { ModuleIcon } from '../components/Layout';
import ConvertLeadModal from '../components/ConvertLeadModal';
import DocumentViewer, { isPreviewable, type ViewableFile } from '../components/DocumentViewer';
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

  const { data: record, isLoading, error, refetch } = useQuery({
    queryKey: ['record', moduleName, id],
    queryFn: () => api.record(moduleName!, id!),
    enabled: Boolean(moduleName && id),
  });

  // Join this record's realtime room so workflow/AI writes that land after the
  // response (lead scoring, lifecycle promotion) appear without a refresh.
  useWatchRecord(id);

  // Prev/next through whatever list the user last viewed for this module —
  // populated by ListView, read here so opening a record doesn't need to
  // carry that list through router state.
  const navIds = useMemo(() => (moduleName ? loadListNav(moduleName) : []), [moduleName]);
  const navIndex = id ? navIds.indexOf(id) : -1;
  const prevId = navIndex > 0 ? navIds[navIndex - 1] : null;
  const nextId = navIndex >= 0 && navIndex < navIds.length - 1 ? navIds[navIndex + 1] : null;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Don't hijack arrow keys while the user is typing, in a select, or a
      // modal (edit form, compose, convert) is open above this page.
      const target = e.target as HTMLElement | null;
      const isEditable = target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
        || target.isContentEditable
      );
      if (isEditable || document.querySelector('[role="dialog"]')) return;

      if (e.key === 'ArrowLeft' && prevId) navigate(`/${moduleName}/${prevId}`);
      else if (e.key === 'ArrowRight' && nextId) navigate(`/${moduleName}/${nextId}`);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moduleName, prevId, nextId, navigate]);

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

  // A failed load has to be distinguishable from a slow one. Previously this
  // condition swallowed both: on a 404/403 the query settles with no data, so
  // `isLoading` goes false while `record` stays undefined and the page sat on
  // loading skeletons forever, telling the user nothing and offering no way
  // back. Deleted records are a normal way to reach this — someone follows a
  // stale link from a notification or a colleague's message.
  if (error) {
    const status = (error as { status?: number }).status;
    return (
      <div className="p-4 sm:p-6">
        <EmptyState
          icon={<FileQuestion className="h-10 w-10" />}
          title={status === 404 ? 'This record no longer exists' : 'Could not open this record'}
          body={status === 404
            ? 'It may have been deleted, or the link may be out of date.'
            : status === 403
              ? 'You do not have permission to view this record.'
              : 'Something went wrong loading it. Please try again.'}
          action={(
            <div className="flex gap-2">
              <button className="btn-secondary btn-sm" onClick={() => navigate(`/${moduleName}`)}>
                Back to {meta?.label ?? 'list'}
              </button>
              {status !== 404 && status !== 403 && (
                <button className="btn-primary btn-sm" onClick={() => void refetch()}>Try again</button>
              )}
            </div>
          )}
        />
      </div>
    );
  }

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
    { key: 'overview', label: 'Overview', icon: <LayoutDashboard className="h-3.5 w-3.5" /> },
    { key: 'timeline', label: 'Timeline', icon: <Activity className="h-3.5 w-3.5" /> },
    ...(meta.relations.length ? [{ key: 'related', label: 'Related', icon: <Link2 className="h-3.5 w-3.5" /> }] : []),
    { key: 'files', label: 'Files', icon: <Paperclip className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="mx-auto max-w-[1600px] p-4 sm:p-6">
      {/* Header */}
      <div className="card mb-4 overflow-hidden">
        {/* Mobile-first: navigation, identity and actions are three stacked
            rows that each own the full width, collapsing to one row from `sm`.
            The old single flex row could not shrink below the width of the
            action buttons, so a narrow viewport scrolled sideways. */}
        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2">
            <button onClick={() => navigate(`/${moduleName}`)} className="btn-ghost -ml-2 shrink-0 p-1.5" title="Back">
              <ChevronLeft className="h-4 w-4" />
            </button>

            {navIds.length > 0 && (
              <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
                <button
                  onClick={() => prevId && navigate(`/${moduleName}/${prevId}`)}
                  disabled={!prevId}
                  className="btn-ghost p-1 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Previous (←)"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                {navIndex >= 0 && (
                  <span className="px-1 text-2xs tnum text-muted">{navIndex + 1} / {navIds.length}</span>
                )}
                <button
                  onClick={() => nextId && navigate(`/${moduleName}/${nextId}`)}
                  disabled={!nextId}
                  className="btn-ghost p-1 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Next (→)"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Avatar name={record.label} size={48} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="min-w-0 max-w-full truncate text-lg font-semibold tracking-tight sm:text-xl">{record.label}</h1>
                  {record.recordNumber && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-2xs text-muted dark:bg-slate-800">
                      {record.recordNumber}
                    </span>
                  )}
                  {meta.pipelineField && record.values[meta.pipelineField] != null && (
                    record.can?.edit && isInlineEditable(fieldMap.get(meta.pipelineField)!) ? (
                      <EditableField
                        module={moduleName!}
                        recordId={record.id}
                        field={fieldMap.get(meta.pipelineField)!}
                        value={record.values[meta.pipelineField]}
                        restrictTo={restrictionForField(meta.picklistDependencies, record.values, meta.pipelineField)}
                        onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void refetch(); }}
                      />
                    ) : (
                      <FieldValue
                        field={fieldMap.get(meta.pipelineField)!}
                        value={record.values[meta.pipelineField]}
                      />
                    )
                  )}
                  {fieldMap.get('rating') && (
                    record.can?.edit && isInlineEditable(fieldMap.get('rating')!) ? (
                      <EditableField
                        module={moduleName!}
                        recordId={record.id}
                        field={fieldMap.get('rating')!}
                        value={record.values.rating}
                        display={record.display?.rating}
                        onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void refetch(); }}
                      />
                    ) : (
                      <FieldValue field={fieldMap.get('rating')!} value={record.values.rating} display={record.display?.rating} />
                    )
                  )}
                  {typeof record.values.ai_score === 'number' && (
                    <span className="inline-flex items-center gap-1">
                      <Sparkles className="h-3 w-3 text-brand-500" />
                      <ScoreChip score={record.values.ai_score as number} />
                    </span>
                  )}
                  {typeof record.values.ai_risk_score === 'number' && (
                    <span className="inline-flex items-center gap-1 text-2xs text-muted">
                      Risk <ScoreChip score={record.values.ai_risk_score as number} invert />
                    </span>
                  )}
                </div>

                {/* Header summary chips. Every chip caps its own width and
                    truncates: header fields carry free text (a last name imported
                    as "Phone-1786183963173-290" is real data here), and one long
                    value used to widen the whole card past the viewport. */}
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
                  {(layoutConfig.headerFields ?? []).slice(0, 5).map((name) => {
                    const field = fieldMap.get(name);
                    if (!field || record.values[name] == null || record.values[name] === '') return null;
                    if (name === meta.pipelineField) return null;
                    return (
                      <span key={name} className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate">
                        <span className="shrink-0 text-muted">{field.label}:</span>
                        {record.can?.edit && isInlineEditable(field) ? (
                          <EditableField
                            module={moduleName!}
                            recordId={record.id}
                            field={field}
                            value={record.values[name]}
                            display={record.display?.[name]}
                            compact
                            restrictTo={restrictionForField(meta.picklistDependencies, record.values, field.name)}
                            onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void refetch(); }}
                          />
                        ) : (
                          <FieldValue field={field} value={record.values[name]} display={record.display?.[name]} compact />
                        )}
                      </span>
                    );
                  })}
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-muted">Owner:</span>
                    {fieldMap.get('owner_id') && record.can?.edit ? (
                      <EditableField
                        module={moduleName!}
                        recordId={record.id}
                        field={fieldMap.get('owner_id')!}
                        value={record.values.owner_id}
                        display={record.display?.owner_id}
                        compact
                        onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void refetch(); }}
                      />
                    ) : record.display?.owner_id ? (
                      <span className="inline-flex items-center gap-1"><Avatar name={record.display.owner_id} size={16} />{record.display.owner_id}</span>
                    ) : (
                      <span className="text-muted">Unassigned</span>
                    )}
                  </span>
                  <span className="shrink-0 text-muted">Updated {relativeTime(record.updatedAt)}</span>
                </div>
              </div>
            </div>

            {/* Actions. Full width and wrapping below the identity block on a
                phone; a right-aligned row from `sm` up. */}
            <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
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
                    <MessageCircle className="h-3.5 w-3.5 text-positive" />
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

              <Dropdown trigger={<button className="btn-ghost p-2" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></button>}>
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
          </div>

        <Tabs tabs={tabs} active={tab} onChange={setTab} className="px-4 sm:px-5" />
      </div>

      {/* Body */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {tab === 'overview' && (
            <OverviewTab
              meta={meta}
              record={record}
              layoutConfig={layoutConfig}
              module={moduleName!}
              onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void refetch(); }}
            />
          )}
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
  meta, record, layoutConfig, module, onSaved,
}: {
  meta: ModuleMeta & { picklistDependencies: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[] };
  record: RecordEnvelope;
  layoutConfig: { blocks?: { key: string; label: string; columns: number; collapsed?: boolean; fields: string[] }[] };
  module: string;
  onSaved: () => void;
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
                    <dt className="text-2xs font-medium uppercase tracking-wide text-muted">{field.label}</dt>
                    <dd className="mt-0.5 text-sm">
                      {record.can?.edit && isInlineEditable(field) ? (
                        <EditableField
                          module={module}
                          recordId={record.id}
                          field={field}
                          value={record.values[field.name]}
                          display={record.display?.[field.name]}
                          restrictTo={restrictionForField(meta.picklistDependencies, record.values, field.name)}
                          linkTo={field.uitype === 'reference' ? record.display?.[`${field.name}__module`] : undefined}
                          onSaved={onSaved}
                        />
                      ) : (
                        <FieldValue
                          field={field}
                          value={record.values[field.name]}
                          display={record.display?.[field.name]}
                          linkTo={field.uitype === 'reference' ? record.display?.[`${field.name}__module`] : undefined}
                        />
                      )}
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
  const Icon = resolveIcon(entry.icon);

  const tone: Record<string, string> = {
    call: 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400',
    message: 'bg-emerald-100 text-positive dark:bg-emerald-950 dark:text-emerald-400',
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
        tone[entry.type] ?? 'bg-slate-100 text-muted dark:bg-slate-800',
      )}>
        <Icon className="h-3 w-3" />
      </span>

      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{entry.title}</p>
        <span className="text-2xs text-muted">
          {entry.actorName} · {relativeTime(entry.at)}
        </span>
      </div>

      {entry.body && (
        <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted">{entry.body}</p>
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
  const queryClient = useQueryClient();
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

  const [showSelect, setShowSelect] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<{ id: string; label: string; recordNumber: string | null }[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!showSelect || !relation?.targetModule) return;
    setSearching(true);
    const timer = setTimeout(() => {
      void api.lookup(relation.targetModule, search)
        .then((r) => setResults(r))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [showSelect, search, relation?.targetModule]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['related', module, id, active] });
    void queryClient.invalidateQueries({ queryKey: ['record', module, id] });
  };

  const linkMutation = useMutation({
    mutationFn: (targetId: string) => api.linkRelated(module, id, active, targetId),
    onSuccess: () => { setShowSelect(false); setSearch(''); refresh(); },
    onError: (e) => toast.error(e.message),
  });

  const unlinkMutation = useMutation({
    mutationFn: (targetId: string) => api.unlinkRelated(module, id, active, targetId),
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });

  if (!meta.relations.length) {
    return <div className="card"><EmptyState title="No related lists configured" /></div>;
  }

  const columns = relation?.columns?.length
    ? relation.columns
    : (targetMeta?.fields ?? []).filter((f) => f.isActive && f.displayType !== 'hidden').slice(0, 5).map((f) => f.name);
  const fieldMap = new Map((targetMeta?.fields ?? []).map((f) => [f.name, f]));
  const linkedIds = new Set((data?.rows ?? []).map((r) => r.id));

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 p-2 dark:border-slate-800">
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

        {relation && (
          <div className="ml-auto flex items-center gap-1">
            {relation.actions.includes('select') && (
              <button onClick={() => setShowSelect(true)} className="btn-ghost btn-sm">
                <Link2 className="h-3.5 w-3.5" /> Select existing
              </button>
            )}
            {relation.actions.includes('add') && (
              <Link
                to={`/${relation.targetModule}/new?${relation.foreignField}=${id}`}
                className="btn-secondary btn-sm"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </Link>
            )}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : !data?.rows.length ? (
        <EmptyState
          title={`No ${relation?.label.toLowerCase()} yet`}
          action={
            relation && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                {relation.actions.includes('select') && (
                  <button onClick={() => setShowSelect(true)} className="btn-secondary btn-sm">
                    <Link2 className="h-3.5 w-3.5" /> Select existing
                  </button>
                )}
                {relation.actions.includes('add') && (
                  <Link
                    to={`/${relation.targetModule}/new?${relation.foreignField}=${id}`}
                    className="btn-secondary btn-sm"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Link>
                )}
              </div>
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
                {relation?.actions.includes('remove') && <th className="table-head w-10" />}
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
                  {relation?.actions.includes('remove') && (
                    <td className="table-cell w-10">
                      <button
                        onClick={() => unlinkMutation.mutate(row.id)}
                        disabled={unlinkMutation.isPending && unlinkMutation.variables === row.id}
                        className="btn-ghost p-1 text-slate-400 hover:text-red-500 disabled:opacity-40"
                        title={`Unlink ${row.label}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={showSelect} onClose={() => setShowSelect(false)} title={`Link existing ${relation?.label.toLowerCase()}`}>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${relation?.targetModule}…`}
              className="input pl-9"
            />
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {searching ? (
              <div className="flex justify-center py-6"><Spinner /></div>
            ) : results.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No matches</p>
            ) : (
              results.map((r) => {
                const alreadyLinked = linkedIds.has(r.id);
                return (
                  <button
                    key={r.id}
                    disabled={alreadyLinked || linkMutation.isPending}
                    onClick={() => linkMutation.mutate(r.id)}
                    className="flex w-full items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-left text-sm transition-colors hover:border-brand-300 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-800 dark:hover:border-brand-700 dark:hover:bg-brand-950/40"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
                    {r.recordNumber && <span className="font-mono text-2xs text-muted">{r.recordNumber}</span>}
                    {alreadyLinked
                      ? <Check className="h-3.5 w-3.5 text-brand-500" />
                      : <Plus className="h-3.5 w-3.5 text-slate-400" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </Modal>
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
  const [preview, setPreview] = useState<ViewableFile | null>(null);

  // The API returns snake_case rows; the viewer takes a narrow shape. Both are
  // needed here — the list still shows uploader and date, which the viewer
  // has no use for.
  const raw = useMemo(
    () => new Map((data ?? []).map((f) => {
      const row = f as { id: string; size: number; created_at: string; uploaded_by_name: string | null };
      return [row.id, row];
    })),
    [data],
  );
  const viewables: ViewableFile[] = useMemo(
    () => (data ?? []).map((f) => {
      const row = f as { id: string; file_name: string; size: number; mime_type: string };
      return { id: row.id, fileName: row.file_name, mimeType: row.mime_type, fileSize: row.size };
    }),
    [data],
  );

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
          {viewables.map((file) => {
            const meta = raw.get(file.id)!;
            const previewable = isPreviewable(file);
            return (
              <li key={file.id} className="flex items-center gap-3 p-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800">
                  <FileText className="h-4 w-4 text-slate-500" />
                </div>
                <button
                  type="button"
                  onClick={() => setPreview(file)}
                  className="min-w-0 flex-1 text-left"
                  title={previewable ? 'Open preview' : 'No in-browser preview — opens with the reason'}
                >
                  <p className="truncate text-sm font-medium hover:text-brand-600 dark:hover:text-brand-400">
                    {file.fileName}
                  </p>
                  <p className="text-2xs text-muted">
                    {(meta.size / 1024).toFixed(0)} KB · {meta.uploaded_by_name ?? 'Unknown'} · {relativeTime(meta.created_at)}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setPreview(file)}
                  className="btn-ghost btn-sm"
                  aria-label={`Preview ${file.fileName}`}
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
                <a href={`/api/files/${file.id}?download=1`} className="btn-ghost btn-sm" aria-label={`Download ${file.fileName}`}>
                  <Download className="h-3.5 w-3.5" />
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {preview && (
        <DocumentViewer
          file={preview}
          files={viewables}
          onNavigate={setPreview}
          onClose={() => setPreview(null)}
        />
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
          <button onClick={() => void rescore()} disabled={busy} aria-label="Refresh AI insights" className="btn-ghost btn-sm ml-auto">
            {busy ? <Spinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
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
                  <X className="h-3 w-3" />
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
            <p className="text-xs text-muted">
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
                      <p className="mt-0.5 text-2xs font-semibold tnum text-muted">
                        {formatIndianPrice(m.price)}
                      </p>
                    )}
                    {m.reasons[0] && <p className="mt-1 text-2xs text-muted">{m.reasons[0]}</p>}
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
          <span className="text-2xs text-muted">⌘↵ to post</span>
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
                  <span className="text-2xs text-muted">{relativeTime(c.created_at)}</span>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted">{c.body}</p>
              </div>
            </div>
          );
        })}
        {(!data || data.length === 0) && (
          <p className="px-4 py-6 text-center text-xs text-muted">No notes yet</p>
        )}
      </div>
    </div>
  );
}

function CallButton({ to, recordId, module }: { to: string; recordId: string; module: string }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(1);
  const [disposition, setDisposition] = useState('Call Back Later');
  const [notes, setNotes] = useState('');
  const { telephonyAvailable } = useApp();

  useEffect(() => {
    if (!startedAt) return;
    const offerLog = (): void => {
      if (document.visibilityState !== 'visible') return;
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
      setDurationMinutes(elapsed);
      setLogOpen(true);
    };
    const timer = window.setTimeout(offerLog, 1500);
    window.addEventListener('focus', offerLog);
    document.addEventListener('visibilitychange', offerLog);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', offerLog);
      document.removeEventListener('visibilitychange', offerLog);
    };
  }, [startedAt]);

  const call = async (): Promise<void> => {
    if (!telephonyAvailable) {
      setStartedAt(Date.now());
      window.location.href = `tel:${to.replace(/[^\d+]/g, '')}`;
      return;
    }
    setBusy(true);
    try {
      await api.call(to, recordId, module);
      toast.success('Calling…', `Your phone will ring first, then we connect ${to}`);
    } catch (err) {
      toast.error('Could not place the call', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveManual = async (): Promise<void> => {
    setBusy(true);
    try {
      const connected = !['No Answer', 'Busy', 'Switched Off', 'Not Reachable'].includes(disposition);
      await api.logCall({
        to, recordId, module, direction: 'outbound',
        durationSeconds: connected ? Math.max(1, durationMinutes) * 60 : 0,
        disposition,
        notes: notes || undefined,
      });
      toast.success('Call logged');
      setLogOpen(false);
      setStartedAt(null);
      setNotes('');
    } catch (err) {
      toast.error('Could not log the call', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="btn-secondary btn-sm"
        disabled={busy}
        title={telephonyAvailable ? `Call ${to}` : `Call ${to} using this phone`}
        onClick={() => void call()}
      >
        {busy ? <Spinner className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5 text-blue-600" />}
        <span className="hidden sm:inline">Call</span>
      </button>

      <Modal
        open={logOpen}
        onClose={() => { setLogOpen(false); setStartedAt(null); }}
        title={`Log call with ${to}`}
        size="sm"
        footer={(
          <>
            <button className="btn-secondary" onClick={() => { setLogOpen(false); setStartedAt(null); }}>Did not call</button>
            <button className="btn-primary" disabled={busy} onClick={() => void saveManual()}>
              {busy && <Spinner className="h-3.5 w-3.5" />} Save call
            </button>
          </>
        )}
      >
        <div className="space-y-3">
          <div>
            <label className="label">Outcome</label>
            <select className="input" value={disposition} onChange={(e) => setDisposition(e.target.value)}>
              {CALL_DISPOSITIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Approximate duration (minutes)</label>
            <input
              className="input tnum"
              type="number"
              min={0}
              max={600}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <div>
            <label className="label">Notes (optional)</label>
            <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <p className="text-2xs text-muted">The Android companion fills the number, time and duration automatically when paired.</p>
        </div>
      </Modal>
    </>
  );
}
