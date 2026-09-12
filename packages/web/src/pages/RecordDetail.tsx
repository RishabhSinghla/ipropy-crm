import { type JSX, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type BuyerMatch, type FieldMeta, formatIndianPrice, type ModuleMeta, type PropertyMatch, type RecordEnvelope, relativeTime, type TimelineEntry } from '@ipropy/shared';
import {
  Activity, ArrowRightLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Edit3, ExternalLink, Eye, FileQuestion, FileText, FolderOpen, Images, LayoutDashboard, Link2, MessageCircle, Mic, MoreHorizontal, Paperclip, Pencil, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Plus, RefreshCw, Search, Send, Sparkles, Star, Tags, Trash2, Upload, Users, X,
} from 'lucide-react';
import { api, authedFileUrl } from '../lib/api';
import { compressImage, formatBytes } from '../lib/compressImage';
import { toast, useApp } from '../lib/store';
import { useWatchRecord } from '../lib/realtime';
import { invalidateRecordQueries } from '../lib/invalidate';
import { useCallDispositions } from '../lib/callDispositions';
import { useVoiceCapture } from '../lib/useVoiceCapture';
import { loadListNav } from '../lib/listNav';
import { cn, renderMarkdown, restrictionForField } from '../lib/utils';
import { resolveIcon } from '../lib/icons';
import { FieldValue } from '../components/FieldRenderer';
import { EditableField, isInlineEditable } from '../components/EditableField';
import { assignmentField } from '../lib/fields';
import { ShareLinksPanel } from '../components/ShareLinks';
import {
  Avatar, Badge, ConfirmDialog, Dropdown, DropdownItem, EmptyState, Modal,
  ScoreChip, Skeleton, Spinner, Tabs,
} from '../components/ui';
import {} from '../components/Layout';
import DocumentViewer, { isPreviewable, type ViewableFile } from '../components/DocumentViewer';
import ComposeModal from '../components/ComposeModal';
import { PeekLink } from '../components/PeekLink';
import { CallButton, CallDispositionProvider } from '../components/CallDisposition';
import { isNative } from '../lib/native';
import { downloadFromUrl } from '../lib/nativeActions';
import { canShareRecords } from '../lib/sharing';

export default function RecordDetail(): JSX.Element {
  const { module: moduleName, id } = useParams<{ module: string; id: string }>();
  const navigate = useNavigate();
  const [detailParams] = useSearchParams();
  /**
   * Where Back goes.
   *
   * The list hands over its own URL — filter, sort, search and page included —
   * so returning lands on exactly the screen the user left. Falls back to the
   * bare module for links that arrive from elsewhere (a notification, a search
   * result, a pasted URL).
   */
  const returnTo = detailParams.get('return') ?? `/${moduleName}`;
  const returnQuery = detailParams.get('return')
    ? `?return=${encodeURIComponent(detailParams.get('return')!)}`
    : '';
  const queryClient = useQueryClient();
  const { user } = useApp();

  const [tab, setTab] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveTarget, setMoveTarget] = useState<'leads' | 'properties' | null>(null);
  const [sharing, setSharing] = useState(false);
  const [collaborators, setCollaborators] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [compose, setCompose] = useState<'whatsapp' | 'email' | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [summarising, setSummarising] = useState(false);

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

  /**
   * Which tab this module opens on, and which fields the header summarises.
   *
   * Both live in the module's default detail layout, so an administrator sets
   * them per module in Admin → Layouts rather than a developer hard-coding
   * "overview" here. `tab` therefore starts null and adopts the configured
   * value on first load — resolving it eagerly would flash Overview first.
   */
  const layoutConfig = useMemo(
    () => ((meta?.layouts?.find((l) => l.type === 'detail' && l.is_default)?.config ?? {}) as {
      blocks?: { key: string; label: string; columns: number; collapsed?: boolean; fields: string[] }[];
      headerFields?: string[];
      relatedLists?: string[];
      defaultTab?: string;
      headerTitleField?: string;
      tabs?: { key: string; label: string; icon?: string }[];
    }),
    [meta],
  );

  useEffect(() => {
    if (tab === null && meta) setTab(layoutConfig.defaultTab || 'overview');
  }, [tab, meta, layoutConfig.defaultTab]);

  // Prev/next through whatever list the user last viewed for this module —
  // populated by ListView, read here so opening a record doesn't need to
  // carry that list through router state.
  const navIds = useMemo(() => (moduleName ? loadListNav(moduleName) : []), [moduleName]);
  const navIndex = id ? navIds.indexOf(id) : -1;
  const sessionPrev = navIndex > 0 ? navIds[navIndex - 1] : null;
  const sessionNext = navIndex >= 0 && navIndex < navIds.length - 1 ? navIds[navIndex + 1] : null;

  // The stashed list only knows the page of rows the list last rendered. A
  // record opened from search, a notification or a pasted URL — or after the
  // tab's session ended — is in no list at all, and both arrows used to go
  // dead. The back button's own address names the view and sort the user was
  // in, so the server can answer "which records sit either side" through the
  // same engine that ordered the list.
  const listQuery = useMemo(() => {
    if (!detailParams.get('return')) return null;
    try {
      return new URL(detailParams.get('return')!, 'http://localhost').searchParams;
    } catch {
      return null;
    }
  }, [detailParams]);

  const { data: remote } = useQuery({
    queryKey: ['neighbours', moduleName, id, listQuery?.get('view'), listQuery?.get('sort'), listQuery?.get('dir')],
    queryFn: () => api.neighbours(moduleName!, id!, {
      view: listQuery?.get('view') ?? undefined,
      sort: listQuery?.get('sort') ?? undefined,
      dir: listQuery?.get('dir') ?? undefined,
    }),
    enabled: Boolean(moduleName && id) && navIndex === -1,
    staleTime: 30_000,
  });

  /*
    The match list is fetched while the record is still being read.

    Scoring the inventory is a single indexed query — tens of milliseconds —
    but it only started when somebody clicked the Matching tab, so the tab
    always opened on skeletons and always felt slow, which is how it was
    reported. Warming it on arrival costs one cheap request on a page that is
    already making several, and the tab then paints from cache. Same key and
    same default depth (10) as the tab's own query, or this would warm a cache
    entry nothing reads.
  */
  useEffect(() => {
    if (!moduleName || !id) return;
    void queryClient.prefetchQuery({
      queryKey: ['matching', moduleName, id, 10],
      queryFn: (): Promise<{ matches?: PropertyMatch[]; buyers?: BuyerMatch[] }> => (moduleName === 'leads'
        ? api.matchProperties(moduleName, id, false, 10)
        : api.buyersForProperty(id, false, 10)),
      staleTime: 60_000,
    });
  }, [moduleName, id]);

  const prevId = sessionPrev ?? (navIndex === -1 ? remote?.prevId ?? null : null);
  const nextId = sessionNext ?? (navIndex === -1 ? remote?.nextId ?? null : null);

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

  const moveMutation = useMutation({
    mutationFn: (targetModule: 'leads' | 'properties') => api.move(moduleName!, id!, targetModule),
    onSuccess: (moved, targetModule) => {
      toast.success(`Moved to ${targetModule === 'properties' ? 'Inventories' : 'Leads'}`, moved.label);
      invalidateRecordQueries(queryClient, moduleName, id);
      void queryClient.invalidateQueries({ queryKey: ['records', targetModule] });
      navigate(`/${targetModule}/${moved.id}`);
    },
  });

  const starMutation = useMutation({
    mutationFn: (starred: boolean) => api.star(moduleName!, id!, starred),
    onSuccess: () => {
      invalidateRecordQueries(queryClient, moduleName, id);
      void refetch();
    },
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

  if (isLoading || !meta || !record || tab === null) {
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

  const fieldMap = new Map(meta.fields.map((f) => [f.name, f]));
  // Resolved by what they are, not by the names they happen to carry today.
  const assignedField = assignmentField(meta.fields);
  /*
    "Updated 50 minutes ago" is part of the assignee chip, not a loose item.

    Left loose in the header strip it wrapped onto a line of its own whenever
    the fields ahead of it filled the width — there on one record, on the next
    line on the next, which is what got reported. It is rendered immediately
    after whichever chip carries the assignee, wherever that chip lands, and
    only stands alone when the module has no assignment field at all.
  */
  const updatedChip = (
    <span className="shrink-0 whitespace-nowrap text-xs font-normal text-muted">
      · Updated {relativeTime(record.updatedAt)}
    </span>
  );
  const phone = String(record.values.mobile ?? record.values.phone ?? record.values.whatsapp_number ?? '');
  const email = String(record.values.email ?? '');

  /**
   * One flat strip: whatever related lists the module declares get a tab each,
   * rather than hiding behind a "Related" tab with a second row of tabs inside
   * it. Which of these opens first is the layout's `defaultTab`.
   */
  // Calls belong to people. The companion app syncs the whole team's call log
  // against whichever lead the number matches, so this is where "did anyone
  // ring them back?" gets answered — no separate call-centre module.
  const supportsCalls = meta.fields.some((field) => field.uitype === 'phone');

  const availableTabs = [
    { key: 'overview', label: 'Overview', icon: <LayoutDashboard className="h-3.5 w-3.5" /> },
    { key: 'timeline', label: 'Timeline', icon: <Activity className="h-3.5 w-3.5" /> },
    ...(moduleName === 'leads' || moduleName === 'properties' ? [{
      key: 'matching',
      // The owner asked for these two labels by name: on a contact, the units
      // that fit; on a property, the people who fit.
      label: moduleName === 'leads' ? 'Matching inventory' : 'Matching leads',
      icon: <Link2 className="h-3.5 w-3.5" />,
    }] : []),
    ...meta.relations.map((r) => ({
      key: `rel:${r.name}`,
      label: r.label,
      icon: <Link2 className="h-3.5 w-3.5" />,
    })),
    ...(moduleName === 'leads' && supportsCalls ? [{ key: 'calls', label: 'Calls', icon: <Phone className="h-3.5 w-3.5" /> }] : []),
    { key: 'files', label: 'Files', icon: <Paperclip className="h-3.5 w-3.5" /> },
    ...(moduleName === 'properties' && supportsCalls ? [{ key: 'calls', label: 'Calls', icon: <Phone className="h-3.5 w-3.5" /> }] : []),
  ];
  const availableByKey = new Map(availableTabs.map((item) => [item.key, item]));
  const configuredTabs = layoutConfig.tabs?.flatMap((item) => {
    const available = availableByKey.get(item.key);
    if (!available) return [];
    const Icon = item.icon ? resolveIcon(item.icon) : null;
    return [{
      ...available,
      label: item.label.trim() || available.label,
      ...(Icon ? { icon: <Icon className="h-3.5 w-3.5" /> } : {}),
    }];
  });
  // Existing saved layouts predate the Inventory Calls tab. Append any newly
  // available tab so an old customised layout cannot hide new functionality.
  const configuredOrAvailableTabs = configuredTabs?.length
    ? [...configuredTabs, ...availableTabs.filter((item) => !configuredTabs.some((configured) => configured.key === item.key))]
    : availableTabs;
  // Inventory calls belong directly after Files. Repositioning also repairs
  // already-saved layouts that were created before the Calls tab existed.
  const tabs = moduleName === 'properties'
    ? (() => {
      const calls = configuredOrAvailableTabs.filter((item) => item.key === 'calls');
      const withoutCalls = configuredOrAvailableTabs.filter((item) => item.key !== 'calls');
      const filesIndex = withoutCalls.findIndex((item) => item.key === 'files');
      return filesIndex < 0 ? [...withoutCalls, ...calls] : [
        ...withoutCalls.slice(0, filesIndex + 1), ...calls, ...withoutCalls.slice(filesIndex + 1),
      ];
    })()
    : configuredOrAvailableTabs;

  // A configured default tab can outlive what it named — an admin deletes the
  // related list it pointed at and every record of the module then opens on a
  // tab that isn't in the strip, showing an empty body with nothing selected.
  const activeTab = tabs.some((t) => t.key === tab) ? tab : tabs[0]!.key;

  return (
    <CallDispositionProvider recordId={record.id} module={moduleName!} recordLabel={record.label}>
    <div className="mx-auto max-w-[1600px] p-4 sm:p-6">
      {/* Header */}
      <div className="card mb-4 overflow-hidden">
        {/* Two rows, not three.

            The nav row held nothing but a back arrow and a record counter and
            still cost a whole line, while Star / Call / WhatsApp / Email sat on
            their own line further down — a header box mostly made of air. The
            actions ride up beside the back arrow now, and the identity block
            below gets the full width for the fields somebody actually reads. */}
        <div className="p-3 sm:p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {/* Back to the list *as it was* — the filter, sort and page the
                user had set — rather than a bare module URL that resets them. */}
            <button onClick={() => navigate(returnTo)} className="btn-ghost -ml-2 shrink-0 p-1.5" title="Back">
              <ChevronLeft className="h-4 w-4" />
            </button>

            {(navIds.length > 0 || prevId || nextId) && (
              <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
                <button
                  onClick={() => prevId && navigate(`/${moduleName}/${prevId}${returnQuery}`)}
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
                  onClick={() => nextId && navigate(`/${moduleName}/${nextId}${returnQuery}`)}
                  disabled={!nextId}
                  className="btn-ghost p-1 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Next (→)"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Actions, right-aligned on the same line as the back arrow. */}
            <div className="ml-auto flex flex-wrap items-center gap-1.5 sm:justify-end">
              <button
                onClick={() => starMutation.mutate(!record.starred)}
                className="btn-ghost p-2"
                title={record.starred ? 'Remove from starred' : 'Star this record'}
              >
                <Star className={cn('h-4 w-4', record.starred && 'fill-amber-400 text-amber-400')} />
              </button>

              {phone && (
                <>
                  <CallButton to={phone} />
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

              <Dropdown trigger={<button className="btn-ghost p-2" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></button>}>
                {(close) => (
                  <>
                    <DropdownItem
                      icon={summarising ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                      onClick={() => {
                        close();
                        setSummarising(true);
                        void api.summarise(moduleName!, id!)
                          .then((result) => setAiSummary(result.summary))
                          .catch((e: Error) => toast.error('Summary failed', e.message))
                          .finally(() => setSummarising(false));
                      }}
                    >
                      {summarising ? 'Summarising…' : 'Summarise with AI'}
                    </DropdownItem>
                    {/*
                      One rule, in lib/sharing.ts, so the app and this page
                      cannot drift. `settings` is not on this page's local
                      Module type; the cast asks the same question of whatever
                      the metadata actually carries.
                    */}
                    {canShareRecords(moduleName, (module as { settings?: Record<string, unknown> } | undefined)?.settings) && (
                      <DropdownItem
                        icon={<Link2 className="h-3.5 w-3.5" />}
                        onClick={() => { setSharing(true); close(); }}
                      >
                        Send to a buyer
                      </DropdownItem>
                    )}
                    {record.can?.edit && (
                      <DropdownItem icon={<Tags className="h-3.5 w-3.5" />} onClick={() => { setTagging(true); close(); }}>
                        Manage tags
                      </DropdownItem>
                    )}
                    {(moduleName === 'leads' || moduleName === 'properties') && record.can?.edit && (
                      <DropdownItem
                        icon={<Users className="h-3.5 w-3.5" />}
                        onClick={() => { setCollaborators(true); close(); }}
                      >
                        Share with team
                      </DropdownItem>
                    )}
                    {(moduleName === 'leads' || moduleName === 'properties') && record.can?.edit && record.can?.delete && (
                      <DropdownItem
                        icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
                        onClick={() => {
                          close();
                          setMoveTarget(moduleName === 'leads' ? 'properties' : 'leads');
                        }}
                      >
                        Move to {moduleName === 'leads' ? 'Inventories' : 'Leads'}
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

            <div className="flex min-w-0 items-start gap-3">
              <Avatar name={record.label} size={44} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="min-w-0 max-w-full truncate text-lg font-semibold tracking-tight sm:text-xl">
                    {layoutConfig.headerTitleField && record.values[layoutConfig.headerTitleField] != null && record.values[layoutConfig.headerTitleField] !== ''
                      ? String(record.display?.[layoutConfig.headerTitleField] ?? record.values[layoutConfig.headerTitleField])
                      : record.label}
                  </h1>
                  {/* The header is intentionally only the record name. Status
                      remains editable in Overview and visible in lists. */}
                  {fieldMap.get('rating') && (
                    record.can?.edit && isInlineEditable(fieldMap.get('rating')!) ? (
                      <EditableField
                        module={moduleName!}
                        recordId={record.id}
                        field={fieldMap.get('rating')!}
                        value={record.values.rating}
                        display={record.display?.rating}
                        onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void queryClient.invalidateQueries({ queryKey: ['matching', moduleName, record.id] }); void refetch(); }}
                      />
                    ) : (
                      <FieldValue field={fieldMap.get('rating')!} value={record.values.rating} display={record.display?.rating} />
                    )
                  )}
                  {typeof record.values.ai_risk_score === 'number' && (
                    <span className="inline-flex items-center gap-1 text-2xs text-muted">
                      Risk <ScoreChip score={record.values.ai_risk_score as number} invert />
                    </span>
                  )}
                  {(record.tags ?? []).map((tag) => (
                    <span key={tag} className="rounded-full bg-brand-50 px-2 py-0.5 text-2xs font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                      {tag}
                    </span>
                  ))}
                </div>

                {/* Header summary chips. Every chip caps its own width and
                    truncates: header fields carry free text (a last name imported
                    as "Phone-1786183963173-290" is real data here), and one long
                    value used to widen the whole card past the viewport. */}
                {/* Bigger and darker than the rest of the secondary copy on
                    purpose. This strip carries the four things a rep checks
                    before dialling — number, next follow-up, budget, owner —
                    and at 11px muted it was being read past. The labels stay
                    quiet; the values are what got the weight. */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                  {(layoutConfig.headerFields ?? []).map((name) => {
                    const field = fieldMap.get(name);
                    // A field that no longer exists, or that a profile hides,
                    // genuinely has nothing to show.
                    if (!field || !field.isActive || field.displayType === 'hidden') return null;
                    // The pipeline field is already the status chip above.
                    if (name === meta.pipelineField) return null;
                    /*
                      An empty one still renders, as a dash.

                      It used to be skipped, which meant adding a field to the
                      header in the Layout Designer did nothing at all on any
                      record that happened to have it blank — no chip, no
                      message, and the same click removing one worked fine. That
                      reads as a broken designer, and it was reported as one.
                      An admin picking four header fields has asked for four,
                      and a dash is how a form says "nothing here yet".
                    */
                    return (
                      <span key={name} className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate">
                        <span className="shrink-0 text-xs font-normal text-muted">{field.label}:</span>
                        {record.can?.edit && isInlineEditable(field) ? (
                          <EditableField
                            module={moduleName!}
                            recordId={record.id}
                            field={field}
                            value={record.values[name]}
                            display={record.display?.[name]}
                            compact
                            siblings={record.values}
                            restrictTo={restrictionForField(meta.picklistDependencies, record.values, field.name)}
                            onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void queryClient.invalidateQueries({ queryKey: ['matching', moduleName, record.id] }); void refetch(); }}
                          />
                        ) : (
                          <FieldValue field={field} value={record.values[name]} display={record.display?.[name]} compact />
                        )}
                        {name === assignedField?.name && updatedChip}
                      </span>
                    );
                  })}
                  {/* The assignment field, under whatever name and label it
                      currently carries. Found by uitype, never by name: it is
                      called `assigned_to` today and `owner_id` is only its
                      column, so looking it up by name silently found nothing
                      and drew this chip read-only while every other header
                      field edited in place. */}
                  {assignedField && !(layoutConfig.headerFields ?? []).includes(assignedField.name) && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-xs font-normal text-muted">{assignedField.label}:</span>
                      {record.can?.edit && isInlineEditable(assignedField) ? (
                        <EditableField
                          module={moduleName!}
                          recordId={record.id}
                          field={assignedField}
                          value={record.values[assignedField.name]}
                          display={record.display?.[assignedField.name]}
                          compact
                          onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void queryClient.invalidateQueries({ queryKey: ['matching', moduleName, record.id] }); void refetch(); }}
                        />
                      ) : record.display?.[assignedField.name] ? (
                        <span className="inline-flex items-center gap-1"><Avatar name={record.display[assignedField.name]} size={16} />{record.display[assignedField.name]}</span>
                      ) : (
                        <span className="text-muted">Unassigned</span>
                      )}
                      {updatedChip}
                    </span>
                  )}
                  {/* Nothing to hang it on — a module with no assignment field. */}
                  {!assignedField && updatedChip}
                </div>
              </div>
            </div>

        </div>

        <Tabs tabs={tabs} active={activeTab} onChange={setTab} className="px-4 sm:px-5" />
      </div>

      {/* Body */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {activeTab === 'overview' && (
            <OverviewTab
              meta={meta}
              record={record}
              layoutConfig={layoutConfig}
              module={moduleName!}
              onSaved={() => { invalidateRecordQueries(queryClient, moduleName, record.id); void queryClient.invalidateQueries({ queryKey: ['matching', moduleName, record.id] }); void refetch(); }}
            />
          )}
          {activeTab === 'timeline' && <TimelineTab module={moduleName!} id={id!} />}
          {activeTab === 'matching' && <MatchingTab module={moduleName!} id={id!} returnQuery={returnQuery} />}
          {activeTab.startsWith('rel:') && (
            <RelatedTab
              meta={meta} module={moduleName!} id={id!}
              relationName={activeTab.slice(4)}
            />
          )}
          {activeTab === 'calls' && <CallsTab recordId={id!} />}
          {activeTab === 'files' && <FilesTab module={moduleName!} id={id!} canEdit={Boolean(record.can?.edit)} />}
        </div>

        {/* Notes first, on every module.

            A rep opening a record needs the last thing a colleague wrote before
            anything a model inferred or a photo shows. On a contact that was
            already true; on a property the notes box sat under the pictures and
            the duplicate panels, far enough down that people stopped writing in
            it. Same column, same order, both modules — photos come directly
            below the notes they get discussed in. */}
        <div className="space-y-4">
          <CommentsPanel module={moduleName!} id={id!} currentUser={user?.id ?? ''} />
          {moduleName === 'properties' && (
            <PropertyPhotoCarousel recordId={id!} canEdit={Boolean(record.can?.edit)} />
          )}
          <DuplicateSuggestions module={moduleName!} id={id!} label={record.label} />
          <PendingProposals module={moduleName!} recordId={id!} />
          <AiPanel module={moduleName!} record={record} meta={meta} />
        </div>
      </div>

      <Modal
        open={sharing}
        onClose={() => setSharing(false)}
        title="Send this property to a buyer"
      >
        <ShareLinksPanel module={moduleName!} recordId={id!} />
      </Modal>

      <Modal
        open={collaborators}
        onClose={() => setCollaborators(false)}
        title={`Share ${meta.singularLabel} with team`}
      >
        <RecordCollaboratorsPanel module={moduleName!} recordId={id!} />
      </Modal>

      <Modal open={tagging} onClose={() => setTagging(false)} title={`Tags for ${record.label}`}>
        <RecordTagEditor
          module={moduleName!}
          recordId={id!}
          initialTags={record.tags ?? []}
          onSaved={() => { void refetch(); setTagging(false); }}
        />
      </Modal>

      <Modal
        open={Boolean(aiSummary)}
        onClose={() => setAiSummary(null)}
        title={`Summary of ${record.label}`}
      >
        <div className="space-y-3">
          <div className="rounded-xl border border-brand-100 bg-brand-50/60 p-4 text-sm leading-6 text-slate-700 dark:border-brand-900 dark:bg-brand-950/30 dark:text-slate-200">
            {aiSummary}
          </div>
          <p className="text-xs text-muted">
            Built only from the CRM fields and activity you are allowed to see; missing facts are not invented.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => deleteMutation.mutateAsync()}
        title={`Delete ${record.label}?`}
        body="The record moves to the recycle bin and can be restored by an administrator."
        confirmLabel="Delete"
        danger
      />

      <ConfirmDialog
        open={moveTarget !== null}
        onClose={() => setMoveTarget(null)}
        onConfirm={async () => {
          if (moveTarget) await moveMutation.mutateAsync(moveTarget);
          setMoveTarget(null);
        }}
        title={`Move to ${moveTarget === 'properties' ? 'Inventories' : 'Leads'}?`}
        body="Matching values, files, and call history move to the new record. The original record is removed from its current module."
        confirmLabel={moveMutation.isPending ? 'Moving…' : 'Move record'}
      />

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
    </CallDispositionProvider>
  );
}

// ---------------------------------------------------------------------------

type RecordShare = {
  subject_type: 'user' | 'group' | 'role';
  subject_id: string;
  access: 'read' | 'read_write';
  created_at: string;
};

function RecordTagEditor({ module, recordId, initialTags, onSaved }: {
  module: string; recordId: string; initialTags: string[]; onSaved: () => void;
}): JSX.Element {
  const [tags, setTags] = useState(initialTags);
  const [text, setText] = useState('');
  const { data: known = [] } = useQuery({ queryKey: ['tags'], queryFn: () => api.tags() });
  const save = useMutation({
    mutationFn: () => api.setTags(module, recordId, tags),
    onSuccess: () => { toast.success('Tags updated'); onSaved(); },
    onError: (error: Error) => toast.error('Could not update tags', error.message),
  });
  const add = (value: string): void => {
    const tag = value.trim().toLowerCase();
    if (tag && !tags.includes(tag)) setTags((current) => [...current, tag]);
    setText('');
  };
  const suggestions = (known as { name: string }[])
    .map((tag) => tag.name).filter((tag) => !tags.includes(tag) && (!text || tag.includes(text.toLowerCase()))).slice(0, 8);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Use tags to group and find records across your CRM. Create a new tag simply by typing it.</p>
      <div className="flex flex-wrap gap-2">
        {tags.length ? tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
            {tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => setTags((current) => current.filter((value) => value !== tag))}><X className="h-3 w-3" /></button>
          </span>
        )) : <span className="text-sm text-muted">No tags yet</span>}
      </div>
      <div className="flex gap-2">
        <input className="input flex-1" value={text} placeholder="Add a tag…" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(text); } }} />
        <button type="button" className="btn-secondary" disabled={!text.trim()} onClick={() => add(text)}><Plus className="h-4 w-4" /> Add</button>
      </div>
      {suggestions.length > 0 && <div className="flex flex-wrap gap-1.5">{suggestions.map((tag) => <button key={tag} type="button" className="rounded-full border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800" onClick={() => add(tag)}>+ {tag}</button>)}</div>}
      <div className="flex justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending && <Spinner className="h-4 w-4" />} Save tags</button>
      </div>
    </div>
  );
}

function RecordCollaboratorsPanel({ module, recordId }: { module: string; recordId: string }): JSX.Element {
  const [selectedUserId, setSelectedUserId] = useState('');
  const [access, setAccess] = useState<'read' | 'read_write'>('read_write');
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.users() });
  const { data: shares = [], isLoading, refetch } = useQuery({
    queryKey: ['record-shares', module, recordId],
    queryFn: () => api.recordShares(module, recordId),
  });

  const activeUsers = users as { id: string; fullName: string }[];
  const collaborators = shares as RecordShare[];
  const userName = (id: string): string => activeUsers.find((person) => person.id === id)?.fullName ?? id;
  const save = useMutation({
    mutationFn: (next: RecordShare[]) => api.saveRecordShares(module, recordId, next.map((share) => ({
      type: share.subject_type, id: share.subject_id, access: share.access,
    }))),
    onSuccess: () => {
      void refetch();
      setSelectedUserId('');
      toast.success('Team access updated');
    },
    onError: (error: Error) => toast.error('Could not update sharing', error.message),
  });

  const add = (): void => {
    if (!selectedUserId || collaborators.some((share) => share.subject_type === 'user' && share.subject_id === selectedUserId)) return;
    save.mutate([...collaborators, {
      subject_type: 'user', subject_id: selectedUserId, access, created_at: new Date().toISOString(),
    }]);
  };

  const availableUsers = activeUsers.filter((person) => !collaborators.some(
    (share) => share.subject_type === 'user' && share.subject_id === person.id,
  ));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Add teammates who should work on this record. They keep access even though the owner stays the same.
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
        <select className="input" aria-label="Teammate" value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
          <option value="">Select a teammate</option>
          {availableUsers.map((person) => <option key={person.id} value={person.id}>{person.fullName}</option>)}
        </select>
        <select className="input" aria-label="Access level" value={access} onChange={(event) => setAccess(event.target.value as 'read' | 'read_write')}>
          <option value="read_write">Can view & edit</option>
          <option value="read">View only</option>
        </select>
        <button type="button" className="btn-primary" disabled={!selectedUserId || save.isPending} onClick={add}>
          {save.isPending ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />} Add
        </button>
      </div>
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {isLoading ? <div className="p-3"><Skeleton className="h-8 w-full" /></div> : collaborators.length === 0 ? (
          <p className="p-4 text-sm text-muted">Only the owner can access this record right now.</p>
        ) : collaborators.map((share) => (
          <div key={`${share.subject_type}-${share.subject_id}`} className="flex items-center gap-3 p-3">
            <Avatar name={share.subject_type === 'user' ? userName(share.subject_id) : share.subject_type} size={28} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{share.subject_type === 'user' ? userName(share.subject_id) : `${share.subject_type}: ${share.subject_id}`}</p>
              <p className="text-2xs text-muted">{share.access === 'read_write' ? 'Can view and edit' : 'Can view'}</p>
            </div>
            <button
              type="button"
              className="btn-ghost p-1.5 text-negative"
              aria-label="Remove access"
              disabled={save.isPending}
              onClick={() => save.mutate(collaborators.filter((candidate) => candidate !== share))}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
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
                'grid gap-x-6 gap-y-1.5 p-3',
                block.columns === 1 ? 'grid-cols-1' : block.columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
              )}>
                {fields.map((field) => (
                  <div
                    key={field.name}
                    className={cn(
                      /*
                        Label beside the value and *outside* the box, not inside it.

                        #67 put the label on the left within the same bordered
                        box, which is half the ask — his words were "keep key
                        name in left side from the box… box is too big". Boxing
                        the label with the value means the box is still as wide
                        as both, so the section is no smaller. Here the label is
                        plain text in its own column and only the value is
                        boxed: the eye runs down one list of names and one
                        column of answers, and a section of fourteen fields
                        stops being a page of scrolling.
                      */
                      'flex min-w-0 items-baseline gap-2.5',
                      field.config.fullWidth && 'sm:col-span-2',
                    )}
                    onClick={(event) => {
                      // The entire value box is the edit target. Do not
                      // re-click a nested control; it already owns the event.
                      if (!record.can?.edit || (event.target as HTMLElement).closest('button, input, select, textarea, a')) return;
                      (event.currentTarget.querySelector('dd button') as HTMLButtonElement | null)?.click();
                    }}
                  >
                    <dt className="w-[38%] max-w-[10rem] shrink-0 truncate text-2xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300" title={field.label}>{field.label}</dt>
                    <dd className={cn('min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50/70 px-2 py-1 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-100', record.can?.edit && 'cursor-pointer hover:border-brand-300 hover:bg-brand-50/30 dark:hover:border-brand-700')}>
                      {record.can?.edit && isInlineEditable(field) ? (
                        <EditableField
                          module={module}
                          recordId={record.id}
                          field={field}
                          value={record.values[field.name]}
                          display={record.display?.[field.name]}
                          siblings={record.values}
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

/**
 * Three things happen on a record and belong in its history: somebody wrote a
 * note, somebody sent a message, something about the record changed.
 *
 * Calls and Tasks came out at the owner's word — calls have their own tab
 * beside this one and were being read twice, and a task is a thing still to be
 * done rather than a thing that happened, so it belongs on a list, not in a
 * history. "All" came out too: with three filters left it was a fourth button
 * that showed what the other three showed together, and the tab opens on Notes
 * now because a note is what the desk comes here to read and to write.
 */
const TIMELINE_FILTERS = [
  { key: 'comment', label: 'Notes' },
  { key: 'message', label: 'Messages' },
  { key: 'audit', label: 'Changes' },
] as const;

function TimelineTab({ module, id }: { module: string; id: string }): JSX.Element {
  const [filter, setFilter] = useState<string>('comment');
  const { data, isLoading } = useQuery({
    queryKey: ['timeline', module, id, filter],
    queryFn: () => api.timeline(module, id, [filter]),
  });

  const filters = TIMELINE_FILTERS;

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
        <EmptyState
          icon={<Activity className="h-8 w-8" />}
          title={filter === 'comment' ? 'No notes yet' : filter === 'message' ? 'No messages yet' : 'No changes yet'}
          body={filter === 'comment'
            ? 'Notes the team writes about this record appear here.'
            : filter === 'message'
              ? 'WhatsApp, SMS and email sent to this contact appear here.'
              : 'Every edit to this record is recorded here.'}
        />
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

/**
 * Matching: the two-way bridge between Contacts and Properties.
 *
 * On a contact it lists the units from live inventory that fit the stated
 * requirement — budget with admin-configured headroom, bedrooms (adjacent
 * counts forgiven as a soft miss), preferred areas, area, possession. On a property
 * it runs the same engine in reverse and lists the contacts worth pitching.
 *
 * Both directions share one table: score, the record, the facts a rep weighs
 * before picking up the phone, and the first AI-written reason. A row click
 * opens the other record and carries `return` so Back lands on this record,
 * this tab, exactly where the user was.
 */
function MatchingTab({ module, id, returnQuery }: { module: string; id: string; returnQuery: string }): JSX.Element {
  const isContact = module === 'leads';
  const [minimumScore, setMinimumScore] = useState(0);
  const [decisionFilter, setDecisionFilter] = useState<'all' | 'unmarked' | 'shortlisted' | 'follow_up' | 'not_suitable'>('all');
  const [search, setSearch] = useState('');
  // How deep into the ranking to look. The engine's top handful is the
  // starting point, not the verdict — widening it is how a rep goes past what
  // the score suggested and picks for this customer themselves.
  const [howMany, setHowMany] = useState(10);

  const aiAvailable = useApp((st) => st.aiAvailable);

  /*
    Two requests, because they cost three orders of magnitude apart.

    Scoring the inventory is a single indexed query — tens of milliseconds.
    The pitch sentence beside each row is a model call, and asking for both in
    one request made the whole tab wait on the model: the table sat empty for
    seconds with every number in it already computed. So the scores are
    fetched on their own and painted immediately, and the narrative arrives
    after, filling in the reason column where it has something better to say.

    The narrative request is skipped entirely when no model is configured —
    the server would only degrade to the same deterministic reasons the fast
    call already returned.
  */
  const fetchMatches = (narrative: boolean) => (): Promise<{ matches?: PropertyMatch[]; buyers?: BuyerMatch[] }> => (
    isContact ? api.matchProperties(module, id, narrative, howMany) : api.buyersForProperty(id, narrative, howMany)
  );

  const { data: fast, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['matching', module, id, howMany],
    queryFn: fetchMatches(false),
    staleTime: 60_000,
  });

  const { data: narrated, refetch: refetchNarrative, isFetching: narrating } = useQuery({
    queryKey: ['matching', module, id, howMany, 'narrative'],
    queryFn: fetchMatches(true),
    // Only once the fast answer is on screen, so the two never compete for the
    // same connection on first paint.
    enabled: aiAvailable && !isLoading,
    staleTime: 5 * 60_000,
  });

  const data = narrated ?? fast;
  const { data: decisions, refetch: refetchDecisions } = useQuery({
    queryKey: ['match-feedback', module, id], queryFn: () => api.matchFeedbackList(module, id), staleTime: 30_000,
  });
  const decisionsByTarget = useMemo(() => new Map((decisions ?? []).map((d) => [d.targetId, d.decision])), [decisions]);

  const matches = useMemo<{ id: string; label: string; score: number; primary: string; secondary: string; reason: string; caveat: string; status: string | null | undefined }[]>(() => {
    if (isContact) {
      const rows = ((data as { matches?: PropertyMatch[] } | undefined)?.matches ?? []);
      return rows.map((m) => ({
        id: m.propertyId,
        label: m.propertyLabel,
        score: m.score,
        primary: m.bedrooms != null ? `${m.bedrooms} BHK` : '—',
        secondary: m.price ? formatIndianPrice(m.price) : '—',
        reason: m.reasons[0] ?? '',
        caveat: m.mismatches[0] ?? '',
        status: undefined,
      }));
    }
    const rows = ((data as { buyers?: BuyerMatch[] } | undefined)?.buyers ?? []);
    return rows.map((b) => ({
      id: b.recordId,
      label: b.label,
      score: b.score,
      primary: b.configuration?.join(', ') || '—',
      secondary: b.budget ? formatIndianPrice(b.budget) : '—',
      reason: b.revival ?? b.reasons[0] ?? '',
      caveat: b.reasons.find((r) => /above budget|smaller|outside/i.test(r)) ?? '',
      status: b.status,
    }));
  }, [data, isContact]);
  const term = search.trim().toLowerCase();
  const visibleMatches = matches.filter((match) => (
    match.score >= minimumScore
    && (!term || match.label.toLowerCase().includes(term) || match.primary.toLowerCase().includes(term) || match.secondary.toLowerCase().includes(term))
    && (decisionFilter === 'all' || (decisionFilter === 'unmarked' ? !decisionsByTarget.has(match.id) : decisionsByTarget.get(match.id) === decisionFilter))
  ));

  const feedback = async (event: MouseEvent, targetId: string, decision: 'shortlisted' | 'not_suitable' | 'follow_up'): Promise<void> => {
    event.stopPropagation();
    try {
      if (decisionsByTarget.get(targetId) === decision) {
        await api.clearMatchFeedback(module, id, targetId);
        toast.success('Match action cleared');
      } else {
        await api.matchFeedback(module, id, targetId, decision);
        toast.success(decision === 'shortlisted' ? 'Match shortlisted' : decision === 'not_suitable' ? 'Marked not suitable' : 'Follow-up marked');
      }
      await refetchDecisions();
    }
    catch (err) { toast.error('Could not save match decision', (err as Error).message); }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
        <Link2 className="h-4 w-4 text-brand-500" />
        <span className="text-sm font-medium">
          {isContact ? 'Matching inventories' : 'Matching leads'}{' '}
          {/* The count is the first question asked of this tab, so it is in
              the heading rather than under the last row. It shows what the
              filters left when they are narrowing anything. */}
          <span className="tnum text-brand-600">
            ({visibleMatches.length === matches.length ? matches.length : `${visibleMatches.length} of ${matches.length}`})
          </span>
        </span>
        {narrating && <span className="text-2xs text-muted">writing reasons…</span>}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            className="input h-8 w-40 py-0 text-xs"
            placeholder={isContact ? 'Search these units…' : 'Search these leads…'}
            aria-label={isContact ? 'Search matching inventories' : 'Search matching leads'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="flex items-center gap-1 text-xs text-muted">Show
            <select className="input h-8 w-16 py-0 text-xs" aria-label="How many matches to rank" value={howMany} onChange={(e) => setHowMany(Number(e.target.value))}>
              {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-muted">Minimum fit
            <select className="input h-8 w-[4.5rem] py-0 text-xs" value={minimumScore} onChange={(e) => setMinimumScore(Number(e.target.value))}>
              {[0, 50, 70, 85].map((score) => <option key={score} value={score}>{score}%</option>)}
            </select>
          </label>
          <select className="input h-8 w-32 py-0 text-xs" aria-label="Filter match actions" value={decisionFilter} onChange={(e) => setDecisionFilter(e.target.value as typeof decisionFilter)}>
            <option value="all">All matches</option><option value="unmarked">Not marked</option><option value="shortlisted">Shortlisted</option><option value="follow_up">Follow-up</option><option value="not_suitable">Not suitable</option>
          </select>
          {/* When the engine's shortlist isn't the answer, the whole inventory
              with the filters the team already knows is one click away —
              rather than a second, lesser filter builder living in here. */}
          <Link
            to={isContact ? '/properties' : '/leads'}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost btn-sm"
          >
            <Search className="h-3 w-3" />
            {isContact ? 'Browse all inventories' : 'Browse all leads'}
          </Link>
          <button
            onClick={() => { void refetch(); void refetchNarrative(); }}
            disabled={isFetching}
            aria-label="Refresh matches"
            className="btn-ghost btn-sm"
          >
            {isFetching ? <Spinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : !matches.length ? (
        <EmptyState
          icon={<Link2 className="h-8 w-8" />}
          title={isContact ? 'No matching inventory' : 'No matching leads'}
          body={isContact
            ? 'Nothing available fits the stated requirement right now. Add or reprice a unit, or widen the requirement.'
            : 'No open lead fits this unit yet. It sells itself when one arrives — check back after the next enquiry.'}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="list-head w-24">Fit</th>
                <th className="list-head">{isContact ? 'Inventory' : 'Lead'}</th>
                <th className="list-head hidden sm:table-cell">Bedrooms</th>
                <th className="list-head hidden sm:table-cell">{isContact ? 'Price' : 'Budget'}</th>
                {!isContact && <th className="list-head hidden md:table-cell">Status</th>}
                <th className="list-head">Why it fits</th>
                <th className="list-head w-32">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visibleMatches.map((m) => (
                <tr
                  key={m.id}
                  className="hover:bg-slate-50 dark:hover:bg-slate-800/60"
                >
                  <td className="list-cell"><ScoreChip score={m.score} /></td>
                  <td className="list-cell min-w-40 max-w-56">
                    <Link to={`/${isContact ? 'properties' : 'leads'}/${m.id}${returnQuery}`} target="_blank" rel="noopener noreferrer" className="block truncate font-medium text-brand-600 hover:underline dark:text-brand-400">
                      {m.label}
                    </Link>
                  </td>
                  <td className="list-cell hidden whitespace-nowrap tnum sm:table-cell">{m.primary}</td>
                  <td className="list-cell hidden whitespace-nowrap tnum sm:table-cell">{m.secondary}</td>
                  {!isContact && <td className="list-cell hidden md:table-cell">{m.status ?? '—'}</td>}
                  <td className="list-cell max-w-md">
                    <span className="block truncate text-xs">{m.reason}</span>
                    {m.caveat && <span className="block truncate text-2xs text-amber-600 dark:text-amber-400">{m.caveat}</span>}
                  </td>
                  <td className="list-cell whitespace-nowrap">
                    {/* Each is a toggle: clicking the one already set takes
                        it back off, so a misclick is undone the same way it
                        was made. `aria-pressed` is what says so out loud. */}
                    <button aria-pressed={decisionsByTarget.get(m.id) === 'shortlisted'} className={cn('btn-ghost btn-sm px-1.5', decisionsByTarget.get(m.id) === 'shortlisted' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300')} onClick={(e) => void feedback(e, m.id, 'shortlisted')} title={decisionsByTarget.get(m.id) === 'shortlisted' ? 'Shortlisted — click to undo' : 'Shortlist'}><Star className={cn('h-3.5 w-3.5', decisionsByTarget.get(m.id) === 'shortlisted' && 'fill-current')} /></button>
                    <button aria-pressed={decisionsByTarget.get(m.id) === 'follow_up'} className={cn('btn-ghost btn-sm px-1.5', decisionsByTarget.get(m.id) === 'follow_up' && 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300')} onClick={(e) => void feedback(e, m.id, 'follow_up')} title={decisionsByTarget.get(m.id) === 'follow_up' ? 'Follow-up marked — click to undo' : 'Follow-up'}><Check className="h-3.5 w-3.5" /></button>
                    <button aria-pressed={decisionsByTarget.get(m.id) === 'not_suitable'} className={cn('btn-ghost btn-sm px-1.5 text-red-500', decisionsByTarget.get(m.id) === 'not_suitable' && 'bg-red-100 dark:bg-red-950/50')} onClick={(e) => void feedback(e, m.id, 'not_suitable')} title={decisionsByTarget.get(m.id) === 'not_suitable' ? 'Marked not suitable — click to undo' : 'Not suitable'}><X className="h-3.5 w-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
    site_visit: 'bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400',
    payment: 'bg-teal-100 text-teal-600 dark:bg-teal-950 dark:text-teal-400',
    task: 'bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400',
  };

  const recordingUrl = entry.meta?.recordingUrl as string | undefined;
  const callId = entry.meta?.callId as string | undefined;

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

      {entry.type === 'call' && callId && recordingUrl && (
        <CallTranscript
          callId={callId}
          transcript={(entry.meta?.transcript as string | null) ?? null}
          summary={(entry.meta?.summary as string | null) ?? null}
        />
      )}
    </li>
  );
}

/**
 * Read a call, or have it read back to you, where the call happened.
 *
 * Both of these already existed on the Calls page, which is the wrong place to
 * put them: nobody opens Calls to catch up on one customer, they open the
 * customer. So the recording, its words and its summary all live on the
 * timeline entry, next to the WhatsApp messages and the site visit they belong
 * with.
 *
 * Nothing runs on its own. A recording is only transcribed when somebody asks,
 * which keeps the bill at zero for the calls nobody needs to revisit and keeps
 * the timeline from filling with walls of text.
 */
function CallTranscript({ callId, transcript, summary }: {
  callId: string; transcript: string | null; summary: string | null;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [text, setText] = useState(transcript);
  const [gist, setGist] = useState(summary);
  const [busy, setBusy] = useState<'transcribe' | 'summarise' | null>(null);
  const [open, setOpen] = useState(false);

  const transcribe = async (): Promise<void> => {
    setBusy('transcribe');
    try {
      const result = await api.transcribeCall(callId);
      setText(result.transcript);
      setOpen(true);
      toast.success('Recording transcribed');
    } catch (err) {
      toast.error('Could not transcribe this call', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const summarise = async (): Promise<void> => {
    setBusy('summarise');
    try {
      const result = await api.analyseCall(callId) as { summary?: string };
      if (result.summary) setGist(result.summary);
      void queryClient.invalidateQueries({ queryKey: ['timeline'] });
      toast.success('Call summarised');
    } catch (err) {
      toast.error('Could not summarise this call', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {!text && (
          <button
            onClick={() => void transcribe()}
            disabled={busy !== null}
            className="btn-secondary btn-sm"
          >
            {busy === 'transcribe' && <Spinner />} Transcribe
          </button>
        )}
        {text && (
          <button onClick={() => setOpen(!open)} className="btn-ghost btn-sm px-2">
            {open ? 'Hide' : 'Read'} transcript
          </button>
        )}
        {text && !gist && (
          <button
            onClick={() => void summarise()}
            disabled={busy !== null}
            className="btn-secondary btn-sm"
          >
            {busy === 'summarise' && <Spinner />} Summarise
          </button>
        )}
      </div>

      {gist && !summary && (
        <p className="mt-1.5 rounded-lg bg-slate-50 p-2 text-sm text-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          {gist}
        </p>
      )}

      {open && text && (
        <p className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 text-sm text-muted dark:bg-slate-800/60">
          {text}
        </p>
      )}
    </div>
  );
}

/**
 * One related list.
 *
 * `relationName` promotes a list to a tab of its own on the record page. The
 * old shape was a "Related" tab containing a second row of tabs — two levels of
 * navigation to reach a site visit, on a page a salesperson opens forty times a
 * day. Passing the relation in flattens that to one.
 *
 * Falls back to its own switcher when no relation is named, so any caller that
 * still wants the combined view keeps working.
 */
function RelatedTab({
  meta, module, id, relationName,
}: { meta: ModuleMeta; module: string; id: string; relationName?: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [selfActive, setSelfActive] = useState(meta.relations[0]?.name ?? '');
  const active = relationName ?? selfActive;
  const setActive = setSelfActive;
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
        {!relationName && meta.relations.map((r) => (
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
                  <th key={c} className="list-head">{fieldMap.get(c)?.label ?? c}</th>
                ))}
                {relation?.actions.includes('remove') && <th className="list-head w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  {columns.map((c, i) => {
                    const field = fieldMap.get(c);
                    return (
                      <td key={c} className="list-cell">
                        {i === 0 ? (
                          <PeekLink
                            module={relation!.targetModule}
                            id={row.id}
                            label={row.label}
                            className="font-medium text-brand-600 hover:underline [-webkit-touch-callout:none] dark:text-brand-400"
                          >
                            {field ? <FieldValue field={field} value={row.values[c]} display={row.display?.[c]} compact /> : row.label}
                          </PeekLink>
                        ) : field ? (
                          <FieldValue field={field} value={row.values[c]} display={row.display?.[c]} compact />
                        ) : '—'}
                      </td>
                    );
                  })}
                  {relation?.actions.includes('remove') && (
                    <td className="list-cell w-10">
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

/**
 * One choice of download set.
 *
 * An `<a download>` rather than a button with an onClick: the browser then
 * treats it as a file transfer from the start — progress in the downloads
 * shelf, resumable, and never held in the tab's memory.
 */
function DownloadItem(
  { recordId, set, label, hint }:
  { recordId: string; set: 'all' | 'originals' | 'branded' | 'web'; label: string; hint: string },
): JSX.Element {
  return (
    <a
      href={api.archiveUrl(recordId, set)}
      download
      className="flex w-full flex-col px-3 py-1.5 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span>{label}</span>
      <span className="text-xs text-muted">{hint}</span>
    </a>
  );
}

interface FileRow {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  category: string | null;
  created_at: string;
  uploaded_by_name: string | null;
  cull_state?: string | null;
  ai_category?: string | null;
  ai_caption?: string | null;
}

function FilesTab({ module, id, canEdit }: { module: string; id: string; canEdit: boolean }): JSX.Element {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['files', id],
    queryFn: () => api.files(id),
  });
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ViewableFile | null>(null);
  const [editing, setEditing] = useState<FileRow | null>(null);
  const [deleting, setDeleting] = useState<FileRow | null>(null);

  // The API returns snake_case rows; the viewer takes a narrow shape. Both are
  // needed here — the list still shows uploader and date, which the viewer
  // has no use for.
  const files = (data ?? []) as unknown as FileRow[];
  const raw = useMemo(
    () => new Map(files.map((row) => [row.id, row])),
    [data],
  );
  const viewables: ViewableFile[] = useMemo(
    () => files.map((row) => {
      return { id: row.id, fileName: row.file_name, mimeType: row.mime_type, fileSize: row.size };
    }),
    [data],
  );

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    try {
      // Photos are shrunk; documents and everything else pass straight through,
      // which the compressor decides for itself.
      const result = await compressImage(file);
      await api.uploadFile(result.file, id, module);
      toast.success(
        'File uploaded',
        result.compressed
          ? `${file.name} — resized from ${formatBytes(result.originalBytes)} to ${formatBytes(result.finalBytes)}.`
          : file.name,
      );
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
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
        {canEdit && <label className="btn-secondary btn-sm cursor-pointer">
          {uploading ? <Spinner /> : <Paperclip className="h-3.5 w-3.5" />}
          Upload file
          <input
            type="file"
            className="hidden"
            disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
          />
        </label>}

        {/*
          Downloading is a plain navigation, not a fetch — the zip streams and
          can be several GB, so the browser's downloader should take it rather
          than the page holding it all in memory.

          "Branded" leads because it is what you actually send someone: the
          full-size web copies, and small. Originals are offered separately and
          labelled as large, so nobody starts a multi-gigabyte download by
          reaching for the obvious button.
        */}
        {data?.length ? (
          <Dropdown
            align="left"
            trigger={(
              <span className="btn-secondary btn-sm">
                <Download className="h-3.5 w-3.5" />
                Download all
              </span>
            )}
          >
            <DownloadItem recordId={id} set="branded" label="Watermarked" hint="What you'd send a client" />
            <DownloadItem recordId={id} set="web" label="Website & WhatsApp sizes" hint="Smaller, faster to send" />
            <DownloadItem recordId={id} set="originals" label="Originals only" hint="Full quality — large" />
            <DownloadItem recordId={id} set="all" label="Everything" hint="Every folder — largest" />
          </Dropdown>
        ) : null}
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
                  {(meta.category || meta.ai_category || (meta.cull_state && meta.cull_state !== 'keep')) && (
                    <p className="mt-0.5 flex flex-wrap gap-1 text-2xs text-muted">
                      {meta.category && <Badge>{meta.category}</Badge>}
                      {meta.ai_category && <Badge color="#0ea5e9">{meta.ai_category.replaceAll('_', ' ')}</Badge>}
                      {meta.cull_state && meta.cull_state !== 'keep' && <Badge color="#f59e0b">flagged: {meta.cull_state}</Badge>}
                    </p>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setPreview(file)}
                  className="btn-ghost btn-sm"
                  aria-label={`Preview ${file.fileName}`}
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
                <a
                  href={authedFileUrl(`/api/files/${file.id}`, { download: '1' })}
                  className="btn-ghost btn-sm"
                  aria-label={`Download ${file.fileName}`}
                  onClick={(e) => {
                    // Inert inside the app, and on a phone the relative path
                    // would not even reach the server. Fetch and share instead.
                    if (isNative) {
                      e.preventDefault();
                      void downloadFromUrl(authedFileUrl(`/api/files/${file.id}`, { download: '1' }), file.fileName).catch(() => undefined);
                    }
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
                {canEdit && (
                  <Dropdown trigger={<button className="btn-ghost btn-sm" aria-label={`Manage ${file.fileName}`}><MoreHorizontal className="h-3.5 w-3.5" /></button>}>
                    {(close) => (
                      <>
                        <DropdownItem icon={<Edit3 className="h-3.5 w-3.5" />} onClick={() => { setEditing(meta); close(); }}>
                          Rename or categorise
                        </DropdownItem>
                        <DropdownItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={() => { setDeleting(meta); close(); }}>
                          Delete file
                        </DropdownItem>
                      </>
                    )}
                  </Dropdown>
                )}
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

      {editing && (
        <EditFileModal
          file={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void queryClient.invalidateQueries({ queryKey: ['files', id] });
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await api.deleteFile(deleting.id);
          toast.success('File deleted', deleting.file_name);
          setPreview((current) => current?.id === deleting.id ? null : current);
          await queryClient.invalidateQueries({ queryKey: ['files', id] });
        }}
        title={`Delete ${deleting?.file_name ?? 'file'}?`}
        body="This removes the original and every generated copy from connected storage. This cannot be undone."
        confirmLabel="Delete file"
        danger
      />
    </div>
  );
}

function EditFileModal({
  file, onClose, onSaved,
}: { file: FileRow; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [fileName, setFileName] = useState(file.file_name);
  const [category, setCategory] = useState(file.category ?? '');
  const [saving, setSaving] = useState(false);

  return (
    <Modal
      open
      onClose={onClose}
      title="File details"
      size="sm"
      footer={(
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving || !fileName.trim()}
            onClick={() => {
              setSaving(true);
              void api.updateFile(file.id, { fileName: fileName.trim(), category: category.trim() || null })
                .then(() => { toast.success('File updated'); onSaved(); })
                .catch((err: Error) => toast.error('Could not update file', err.message))
                .finally(() => setSaving(false));
            }}
          >
            {saving && <Spinner />} Save
          </button>
        </>
      )}
    >
      <div className="space-y-3">
        <label>
          <span className="label">File name</span>
          <input className="input" value={fileName} onChange={(event) => setFileName(event.target.value)} maxLength={255} />
        </label>
        <label>
          <span className="label">Category</span>
          <input
            className="input"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Photo, Brochure, KYC, Agreement…"
            maxLength={80}
          />
        </label>
        <p className="text-xs text-muted">Renaming changes the CRM label only; the untouched original bytes stay exactly as uploaded.</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sidebar panels
// ---------------------------------------------------------------------------

/*
  The "Photos and videos → open the folder → press Finish" panel was removed on
  the owner's instruction: the team does not hand pictures over from this screen,
  and a three-step instruction card sitting above the photos on every property
  was cost with no reader. The API behind it (`/properties/:id/finish`,
  `/properties/:id/storage`) is untouched, so site capture and n8n still trigger
  processing the way they always did — only this card is gone.
*/


function PropertyPhotoCarousel({
  recordId, canEdit,
}: { recordId: string; canEdit: boolean }): JSX.Element | null {
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<ViewableFile | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ViewableFile | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['files', recordId],
    queryFn: () => api.files(recordId),
  });
  const photos: ViewableFile[] = ((data ?? []) as unknown as FileRow[])
    .filter((file) => file.mime_type.startsWith('image/') && (!file.cull_state || file.cull_state === 'keep'))
    .map((file) => ({ id: file.id, fileName: file.file_name, mimeType: file.mime_type, fileSize: file.size }));

  useEffect(() => {
    if (index >= photos.length) setIndex(Math.max(0, photos.length - 1));
  }, [index, photos.length]);

  /**
   * Write the whole arrangement, not the one photo that moved.
   *
   * The server assigns positions from the list it is given, so sending the
   * full order is what makes the last save win completely instead of two
   * people's partial moves interleaving into an order neither chose.
   */
  const arrange = async (ids: string[], message: string): Promise<void> => {
    setSaving(true);
    try {
      await api.reorderFiles(recordId, ids);
      await queryClient.invalidateQueries({ queryKey: ['files', recordId] });
      toast.success(message, 'Buyers see them in this order too.');
    } catch (err) {
      toast.error('Could not save that order', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Upload straight into the panel.
   *
   * Sequential rather than parallel: a site visit's worth of 4K photos fired
   * at once saturates an office connection and the browser starts cancelling
   * its own requests, which reads as "some photos did not upload" with no
   * pattern to it. One at a time is slower to finish and far more likely to
   * finish at all, and the counter tells somebody it is still working.
   */
  const upload = async (files: FileList | File[]): Promise<void> => {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    const skipped = [...files].length - images.length;
    if (!images.length) {
      toast.error('Those are not photos', 'This panel takes images. Use the Files tab for documents.');
      return;
    }
    setUploading(images.length);
    let done = 0;
    let before = 0;
    let after = 0;
    try {
      for (const file of images) {
        // Shrunk in the browser, not on the server: a 12MB phone photo that is
        // never sent is 12MB of upload time saved on an office connection as
        // well as 12MB of storage. Declines to act on anything it cannot decode
        // or cannot meaningfully improve, and hands back the original, so a
        // photo is never lost to compression failing.
        const result = await compressImage(file);
        before += result.originalBytes;
        after += result.finalBytes;
        await api.uploadFile(result.file, recordId, 'properties');
        done += 1;
        setUploading(images.length - done);
      }
      await queryClient.invalidateQueries({ queryKey: ['files', recordId] });

      const saved = before - after;
      const note = skipped
        ? `${skipped} file${skipped === 1 ? '' : 's'} skipped — not an image.`
        : saved > 200_000
          // Said plainly, because somebody uploading from an iPhone is about to
          // wonder where the other 11MB went and should not have to guess.
          ? `Resized before upload: ${formatBytes(before)} became ${formatBytes(after)}, saving ${Math.round((saved / before) * 100)}%.`
          : 'Drag a thumbnail to change the order.';

      toast.success(done === 1 ? 'Photo added' : `${done} photos added`, note);
    } catch (err) {
      // Says how many made it, because "upload failed" after eleven of twelve
      // sends somebody back to re-add all twelve.
      toast.error(
        done ? `Stopped after ${done} of ${images.length}` : 'Could not upload',
        (err as Error).message,
      );
      await queryClient.invalidateQueries({ queryKey: ['files', recordId] });
    } finally {
      setUploading(0);
    }
  };

  const remove = async (file: ViewableFile): Promise<void> => {
    setSaving(true);
    try {
      await api.deleteFile(file.id);
      await queryClient.invalidateQueries({ queryKey: ['files', recordId] });
      toast.success('Photo deleted', 'It is gone from the share link and the website too.');
    } catch (err) {
      toast.error('Could not delete that photo', (err as Error).message);
    } finally {
      setSaving(false);
      setConfirmDelete(null);
    }
  };

  /** One drop target, used by both the empty panel and the full one. */
  const dropProps = canEdit ? {
    onDragOver: (e: React.DragEvent) => {
      // Only for files. Without this the thumbnail reorder drag also lights up
      // the whole panel as a drop zone, which is a lie about what will happen.
      if (dragFrom !== null) return;
      e.preventDefault();
      setDropping(true);
    },
    onDragLeave: () => setDropping(false),
    onDrop: (e: React.DragEvent) => {
      if (dragFrom !== null) return;
      e.preventDefault();
      setDropping(false);
      if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files);
    },
  } : {};

  const move = (from: number, to: number): void => {
    if (from === to) return;
    const next = photos.map((p) => p.id);
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setIndex(to);
    void arrange(next, to === 0 ? 'Cover photo set' : 'Photos rearranged');
  };

  // No placeholder while loading. Most properties have no photos yet, so a
  // reserved 4:3 block meant the sidebar always jumped: a big grey rectangle
  // appeared, then vanished, shoving the notes and the AI panel up with it.
  // A panel that quietly arrives when there is something in it moves the page
  // once; this moved it twice, and the second move was upwards.
  // Still nothing while loading — a reserved 4:3 block made the sidebar jump
  // twice, and the second jump was upwards. But once loaded, a property with
  // no photos gets the panel rather than nothing: "there are no photos and
  // here is where they go" is the whole point of the empty state, and hiding
  // it is what forced everybody into Edit → scroll → Media to add the first one.
  if (isLoading) return null;

  const hidden = canEdit ? (
    <input
      ref={fileInput}
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      onChange={(e) => {
        if (e.target.files?.length) void upload(e.target.files);
        // Cleared so choosing the same file twice in a row still fires.
        e.target.value = '';
      }}
    />
  ) : null;

  if (!photos.length) {
    if (!canEdit) return null;
    return (
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
          <p className="flex items-center gap-1.5 text-sm font-medium"><Images className="h-3.5 w-3.5" /> Property photos</p>
        </div>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          {...dropProps}
          className={cn(
            'flex w-full flex-col items-center gap-2 px-4 py-8 text-center transition-colors',
            dropping ? 'bg-brand-50 dark:bg-brand-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
          )}
        >
          {uploading > 0 ? (
            <>
              <Spinner />
              <p className="text-sm font-medium">Uploading… {uploading} to go</p>
            </>
          ) : (
            <>
              <Upload className={cn('h-7 w-7', dropping ? 'text-brand-500' : 'text-slate-400')} />
              <p className="text-sm font-medium">{dropping ? 'Drop them here' : 'Add photos'}</p>
              <p className="text-xs text-muted">
                Drag them in from your desktop, or click to choose. The first one becomes the cover.
              </p>
            </>
          )}
        </button>
        {hidden}
      </div>
    );
  }

  // Clamped here, during render, not only in the effect below.
  //
  // Deleting the last photo re-renders with an index that is now past the end,
  // and the effect that fixes it does not run until after this render has
  // already read `photos[index]` — so the panel crashed on `photo.fileName`
  // with the delete having succeeded. Found by deleting a photo rather than by
  // reading the code: the old panel had no delete, so nothing ever shortened
  // the list underneath the index.
  const safeIndex = Math.min(index, photos.length - 1);
  const photo = photos[safeIndex]!;
  const go = (delta: number): void => setIndex((current) => (current + delta + photos.length) % photos.length);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <p className="flex items-center gap-1.5 text-sm font-medium"><Images className="h-3.5 w-3.5" /> Property photos</p>
        <div className="flex items-center gap-2">
          <span className="text-2xs text-muted">
            {uploading > 0 ? `Uploading… ${uploading} to go` : saving ? 'Saving…' : `${safeIndex + 1} / ${photos.length}`}
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={uploading > 0}
              className="btn-ghost p-1 text-muted disabled:opacity-50"
              title="Add photos"
              aria-label="Add photos"
            >
              <Upload className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="group relative bg-slate-100 dark:bg-slate-950" {...dropProps}>
        {/* Covers the image while a file is over the panel. Without it there is
            no promise that letting go will do anything. */}
        {dropping && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-brand-500/90 text-white">
            <Upload className="h-7 w-7" />
            <p className="text-sm font-medium">Drop to add</p>
          </div>
        )}
        <button type="button" className="block w-full" onClick={() => setPreview(photo)} aria-label={`Open ${photo.fileName}`}>
          <img
            src={authedFileUrl(`/api/files/${photo.id}`, { size: 'medium' })}
            alt={photo.fileName}
            className="aspect-[4/3] w-full object-contain"
          />
        </button>
        {safeIndex === 0 && (
          <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-2xs font-medium text-white">
            Cover
          </span>
        )}
        {/* The one operation anybody actually wants from a photo list: this is
            the shot on the share link, in the zip and at the top of the set. */}
        {canEdit && photos.length > 1 && safeIndex !== 0 && (
          <button
            type="button"
            onClick={() => move(safeIndex, 0)}
            disabled={saving}
            className="absolute left-2 top-2 rounded-full bg-black/60 px-2.5 py-1 text-2xs font-medium text-white hover:bg-black/75 disabled:opacity-50"
          >
            Make cover
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => setConfirmDelete(photo)}
            disabled={saving || uploading > 0}
            className="absolute right-2 top-2 rounded-full bg-black/60 p-1.5 text-white hover:bg-red-600 disabled:opacity-50"
            title="Delete this photo"
            aria-label="Delete this photo"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {photos.length > 1 && (
          <>
            <button type="button" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white" onClick={() => go(-1)} aria-label="Previous photo">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1.5 text-white" onClick={() => go(1)} aria-label="Next photo">
              <ChevronRight className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
      {photos.length > 1 && (
        <>
          <div className="flex gap-1.5 overflow-x-auto p-2">
            {photos.map((item, itemIndex) => (
              <button
                key={item.id}
                type="button"
                draggable={canEdit && !saving}
                onDragStart={() => setDragFrom(itemIndex)}
                onDragEnd={() => setDragFrom(null)}
                onDragOver={(e) => { if (dragFrom !== null) e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) move(dragFrom, itemIndex);
                  setDragFrom(null);
                }}
                onClick={() => setIndex(itemIndex)}
                className={cn(
                  'h-14 w-14 shrink-0 overflow-hidden rounded border-2 bg-subtle transition-opacity',
                  itemIndex === safeIndex ? 'border-brand-500' : 'border-transparent',
                  canEdit && 'cursor-grab active:cursor-grabbing',
                  dragFrom === itemIndex && 'opacity-40',
                )}
                aria-label={`Show photo ${itemIndex + 1}`}
              >
                <img src={authedFileUrl(`/api/files/${item.id}`, { size: 'thumb' })} alt="" className="h-full w-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
          {canEdit && (
            <p className="px-3 pb-2 text-2xs text-muted">
              Drag a thumbnail to reorder. The first one is the cover — it leads the share
              link, the download and the website.
            </p>
          )}
        </>
      )}
      {hidden}
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete this photo?"
        // Says where else it disappears from, because a photo on a share link
        // already sent to a buyer is the thing somebody would want to know
        // before pressing this, not after.
        body="It is removed from this property, the share link, the download and the public website. This cannot be undone."
        confirmLabel="Delete"
        danger
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
      />
      {preview && (
        <DocumentViewer file={preview} files={photos} onNavigate={setPreview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

/**
 * A written reply waiting for one tap.
 *
 * An enquiry arrives at nine in the evening. The workflow drafts the answer,
 * and with no WhatsApp Business account there is nobody to send it — so it is
 * queued for a person instead. This is where that person finds it: on the lead
 * they just opened from the notification, not on a queue page they would have
 * to think to visit.
 *
 * Speed of first response is the biggest controllable factor in conversion,
 * and the gap between a four-minute reply and a four-hour one is usually just
 * whether the words were already written.
 */
/**
 * Changes the CRM is waiting on you to approve.
 *
 * Almost always this is a call that has just ended: the analysis read the
 * transcript, worked out that the buyer agreed to a site visit on Saturday, and
 * is asking whether to move them and chase on the 16th. One tap, and the record
 * is up to date without anybody typing.
 *
 * Above the notes and the insights on purpose. A decision waiting on you
 * outranks something to read, and this is the whole point of the feature —
 * buried under two other cards it becomes the thing nobody scrolls to, which is
 * exactly how the CRM went stale in the first place.
 *
 * Renders nothing at all when there is nothing pending, which is most of the
 * time. An empty "no proposals" card would be a permanent reminder of a feature
 * doing nothing.
 */
function PendingProposals({ module, recordId }: { module: string; recordId: string }): JSX.Element | null {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ['pending-actions', recordId],
    queryFn: () => api.pendingAiActions(recordId),
    staleTime: 30_000,
  });

  const settle = async (id: string, confirm: boolean): Promise<void> => {
    setBusy(id);
    try {
      if (confirm) {
        const result = await api.confirmAiAction(id);
        toast.success('Record updated', result.action.summary);
        // The record itself changed, so everything reading it is now stale.
        invalidateRecordQueries(queryClient, module, recordId);
      } else {
        await api.cancelAiAction(id);
        toast.success('Dismissed', 'Nothing was changed.');
      }
      await refetch();
    } catch (err) {
      toast.error(confirm ? 'Could not apply that' : 'Could not dismiss that', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const actions = data?.actions ?? [];
  if (!actions.length) return null;

  return (
    <div className="card overflow-hidden border-amber-200 dark:border-amber-900">
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-900 dark:bg-amber-950/40">
        <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
          {actions.length === 1 ? 'One change to review' : `${actions.length} changes to review`}
        </span>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {actions.map((action) => (
          <div key={action.id} className="p-4">
            <p className="text-sm">{action.summary}</p>
            {action.origin === 'call' && (
              <p className="mt-1 text-2xs text-muted">Suggested from your last call</p>
            )}
            <dl className="mt-2.5 space-y-1">
              {action.changes.map((change) => (
                <div key={change.field} className="flex items-baseline gap-2 text-xs">
                  <dt className="text-muted">{change.label}</dt>
                  <dd className="min-w-0 flex-1 truncate">
                    <span className="text-muted line-through">{proposalValue(change.from)}</span>
                    <span className="mx-1.5 text-slate-400">&rarr;</span>
                    <span className="font-medium">{proposalValue(change.to)}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex gap-2">
              <button
                className="btn-primary btn-sm"
                disabled={busy === action.id}
                onClick={() => void settle(action.id, true)}
              >
                {busy === action.id ? <Spinner className="h-3 w-3" /> : <Check className="h-3.5 w-3.5" />}
                Apply
              </button>
              <button
                className="btn-secondary btn-sm"
                disabled={busy === action.id}
                onClick={() => void settle(action.id, false)}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function proposalValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return String(value);
}

function AiPanel({
  module, record, meta: _meta,
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

interface Colleague { id: string; fullName: string }

/**
 * "You may already have this person."
 *
 * Two records for one buyer is the quiet kind of mess: two reps chase the same
 * man, he gets two different answers, and he concludes you are disorganised.
 * Exact matching never finds it, because "Rajesh Kumar" and "R. Kumar" from a
 * second number share almost nothing a database can compare.
 *
 * It only suggests. Merge opens the record so somebody can look before doing
 * anything, and Not the same is remembered for that pair for ever — a father
 * and a son do share a surname, a locality and often a budget, and a feature
 * that keeps insisting otherwise is one people learn to ignore.
 */
function DuplicateSuggestions({ module, id, label }: {
  module: string; id: string; label: string;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['duplicates', module, id],
    queryFn: () => api.duplicateSuggestions(module, id),
    // Nobody's answer changes in the next five minutes, and each ask is an
    // embedding call.
    staleTime: 5 * 60_000,
    retry: false,
  });

  const dismiss = async (otherId: string): Promise<void> => {
    try {
      await api.dismissDuplicate(module, id, otherId);
      void queryClient.invalidateQueries({ queryKey: ['duplicates', module, id] });
    } catch (err) {
      toast.error('Could not dismiss that', (err as Error).message);
    }
  };

  const hits = data?.duplicates ?? [];
  if (!hits.length) return null;

  return (
    <div className="card overflow-hidden border-amber-200 dark:border-amber-900">
      <div className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 dark:border-amber-950 dark:bg-amber-950/30">
        <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
          You may already have {hits.length === 1 ? 'this person' : 'these people'}
        </span>
      </div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {hits.map((hit) => (
          <div key={hit.recordId} className="p-3">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Link
                to={`/${module}/${hit.recordId}`}
                className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                {hit.label}
              </Link>
              <span className="text-2xs text-muted">{Math.round(hit.confidence * 100)}% alike</span>
            </div>
            {hit.why && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{hit.why}</p>}
            <div className="mt-2 flex gap-1.5">
              <Link to={`/${module}/${hit.recordId}`} className="btn-secondary btn-sm">
                Open {hit.label.split(/\s+/)[0]}
              </Link>
              <button onClick={() => void dismiss(hit.recordId)} className="btn-ghost btn-sm">
                Not the same as {label.split(/\s+/)[0]}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Notes, with a working @mention.
 *
 * The server has always accepted a `mentions` array on a comment and turned it
 * into a real notification — `notifyMany`, `kind: 'mention'`, straight to the
 * person's phone. Nothing ever sent one. The composer was a bare textarea, so
 * typing "@Priya can you call him back" filed a note that Priya would only
 * discover by opening the record, which is precisely the record nobody opens.
 *
 * So the @ has to actually pick somebody. Typing it opens the directory; the
 * chosen name is remembered against its id, and on post only the names still
 * present in the text are notified — delete the mention and you have
 * un-mentioned them, which is the behaviour anybody would assume.
 */
function CommentsPanel({
  module, id, currentUser,
}: { module: string; id: string; currentUser: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  /** The note being edited, and the editor's draft — null when not editing. */
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  /** Which note's history is unfolded, if any. */
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  /**
   * Speak the note instead of typing it.
   *
   * The moment a note is worth writing is the moment nobody wants to write one:
   * in the car after a site visit, one hand on the wheel. Thirty seconds of
   * Hinglish comes back as four readable lines, into the box rather than into
   * the record, so it is still somebody's decision what gets saved.
   */
  const voice = useVoiceCapture(async (audio) => {
    try {
      const { note } = await api.voiceNote(audio);
      setBody((current) => (current.trim() ? `${current.trim()}\n\n${note}` : note));
    } catch (err) {
      toast.error('Could not write that up', (err as Error).message);
    }
  });
  // Everyone picked from the @ menu while writing this note. Kept as a list
  // rather than a set of ids because resolving back to ids at post time needs
  // the exact name that was inserted.
  const [picked, setPicked] = useState<Colleague[]>([]);

  const { data } = useQuery({
    queryKey: ['comments', module, id],
    queryFn: () => api.comments(module, id),
  });

  const { data: rawUsers } = useQuery({ queryKey: ['users'], queryFn: () => api.users() });
  const colleagues = useMemo<Colleague[]>(
    () => (rawUsers ?? []).map((u) => ({
      id: String((u as { id: string }).id),
      fullName: String((u as { fullName: string }).fullName ?? ''),
    })).filter((u) => u.fullName),
    [rawUsers],
  );

  const post = async (): Promise<void> => {
    if (!body.trim()) return;
    setPosting(true);
    try {
      const text = body.trim();
      const mentions = [...new Set(
        picked.filter((p) => text.includes(`@${p.fullName}`)).map((p) => p.id),
      )];
      await api.addComment(module, id, text, mentions);
      setBody('');
      setPicked([]);
      if (mentions.length) {
        toast.success(mentions.length === 1 ? 'Note posted, 1 person notified' : `Note posted, ${mentions.length} people notified`);
      }
      void queryClient.invalidateQueries({ queryKey: ['comments', module, id] });
      void queryClient.invalidateQueries({ queryKey: ['timeline', module, id] });
    } catch (err) {
      toast.error('Could not post the note', (err as Error).message);
    } finally {
      setPosting(false);
    }
  };

  /**
   * Save the edited note. The previous text is kept by the server and becomes
   * reachable through "(edited)" — a note someone already read and acted on is
   * never silently rewritten.
   */
  const saveEdit = async (): Promise<void> => {
    if (!editing || !editing.body.trim()) return;
    setSavingEdit(true);
    try {
      const text = editing.body.trim();
      const mentions = [...new Set(
        picked.filter((p) => text.includes(`@${p.fullName}`)).map((p) => p.id),
      )];
      const result = await api.editComment(module, id, editing.id, text, mentions);
      if (result.edited) toast.success('Note updated', 'The earlier version is kept in its history.');
      setEditing(null);
      setPicked([]);
      void queryClient.invalidateQueries({ queryKey: ['comments', module, id] });
      void queryClient.invalidateQueries({ queryKey: ['timeline', module, id] });
    } catch (err) {
      toast.error('Could not update the note', (err as Error).message);
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <span className="text-sm font-medium">Notes</span>
      </div>

      <div className="p-3">
        <MentionTextarea
          value={body}
          onChange={setBody}
          onMention={(person) => setPicked((prev) => (
            prev.some((p) => p.id === person.id) ? prev : [...prev, person]
          ))}
          colleagues={colleagues}
          onSubmit={() => void post()}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-2xs text-muted">
            {voice.recording
              ? 'Listening — tap the mic again when you have finished'
              : voice.busy
                ? 'Writing that up…'
                : '@ to notify someone · ⌘↵ to post'}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {voice.supported && (
              <button
                onClick={voice.toggle}
                disabled={voice.busy || posting}
                title={voice.recording ? 'Stop and write it up' : 'Speak the note instead of typing it'}
                aria-label={voice.recording ? 'Stop recording' : 'Record a voice note'}
                className={cn(
                  'btn-secondary btn-sm px-2',
                  voice.recording && 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400',
                )}
              >
                {voice.busy ? <Spinner className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
              </button>
            )}
            <button onClick={() => void post()} disabled={!body.trim() || posting} className="btn-primary btn-sm">
              {posting && <Spinner className="h-3 w-3" />} Post
            </button>
          </div>
        </div>
      </div>

      <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
        {(data ?? []).map((raw) => {
          const c = raw as {
            id: string; body: string; user_id: string; user_name: string; created_at: string;
            updated_at: string | null; edit_history?: { body: string; at: string }[];
          };
          const isMine = Boolean(currentUser) && c.user_id === currentUser;
          const edits = c.edit_history ?? [];
          return (
            <div key={c.id} className="flex gap-2.5 p-3">
              <Avatar name={c.user_name} size={26} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium">{c.user_name}</span>
                  <span className="text-2xs text-muted">{relativeTime(c.created_at)}</span>
                  {edits.length > 0 && (
                    <button
                      className="inline-flex items-center gap-0.5 text-2xs text-muted underline underline-offset-2 hover:text-brand-600 dark:hover:text-brand-400"
                      onClick={() => setHistoryOpen(historyOpen === c.id ? null : c.id)}
                    >
                      (edited {edits.length})
                    </button>
                  )}
                  {/* The pencil belongs to the author: editing someone else's
                      note would rewrite their words in their name. */}
                  {isMine && editing?.id !== c.id && (
                    <button
                      aria-label="Edit this note"
                      title="Edit this note"
                      className="btn-ghost p-1 text-slate-400 hover:text-brand-600 dark:hover:text-brand-400"
                      onClick={() => setEditing({ id: c.id, body: c.body })}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {editing?.id === c.id ? (
                  <div className="mt-1 space-y-2">
                    <MentionTextarea
                      value={editing.body}
                      onChange={(v) => setEditing({ id: c.id, body: v })}
                      onMention={() => undefined}
                      colleagues={colleagues}
                      onSubmit={() => { void saveEdit(); }}
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        className="btn-primary btn-sm"
                        disabled={!editing.body.trim() || savingEdit}
                        onClick={() => { void saveEdit(); }}
                      >
                        {savingEdit && <Spinner className="h-3 w-3" />} Save
                      </button>
                      <button
                        className="btn-secondary btn-sm"
                        disabled={savingEdit}
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted">
                    {highlightMentions(c.body, colleagues)}
                  </p>
                )}

                {historyOpen === c.id && edits.length > 0 && (
                  <div className="mt-1.5 space-y-1.5 rounded-lg border border-slate-200 bg-slate-50/70 p-2 dark:border-slate-700 dark:bg-slate-800/40">
                    <p className="text-2xs font-medium text-muted">Earlier versions</p>
                    {edits.map((e, i) => (
                      <div key={i} className="text-2xs">
                        <span className="text-muted">{relativeTime(e.at)} — </span>
                        <span className="whitespace-pre-wrap text-slate-500 line-through dark:text-slate-400">{e.body}</span>
                      </div>
                    ))}
                  </div>
                )}
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

/** A note's text with every "@Someone" who is a real colleague picked out. */
function highlightMentions(body: string, colleagues: Colleague[]): ReactNode {
  if (!colleagues.length || !body.includes('@')) return body;

  // Longest first: "@Anita Rao" must win over "@Anita".
  const names = colleagues.map((c) => c.fullName).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join('|')})`, 'g');

  const out: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(body.slice(last, at));
    out.push(
      <span key={`${at}-${match[1]}`} className="font-medium text-brand-700 dark:text-brand-300">
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A textarea that opens the team directory when you type "@".
 *
 * The trigger deliberately stops at whitespace: matching across spaces would
 * mean every "@" followed by a sentence keeps a menu open while somebody
 * writes, and closing it then becomes a thing they have to learn.
 */
function MentionTextarea({
  value, onChange, onMention, colleagues, onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onMention: (person: Colleague) => void;
  colleagues: Colleague[];
  onSubmit: () => void;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ text: string; at: number } | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (!query) return [];
    const needle = query.text.toLowerCase();
    return colleagues
      .filter((c) => c.fullName.toLowerCase().includes(needle))
      .slice(0, 6);
  }, [query, colleagues]);

  const open = query !== null && matches.length > 0;

  const readQuery = (text: string, caret: number): void => {
    const before = text.slice(0, caret);
    const match = /@([\p{L}\d._-]*)$/u.exec(before);
    // Only at a word boundary — an email address is not a mention.
    const at = match ? caret - match[0].length : -1;
    const priorChar = at > 0 ? before[at - 1] : ' ';
    if (!match || !/\s|[([]/.test(priorChar)) { setQuery(null); return; }
    setQuery({ text: match[1], at });
    setActive(0);
  };

  const choose = (person: Colleague): void => {
    if (!query) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, query.at)}@${person.fullName} ${value.slice(caret)}`;
    onChange(next);
    onMention(person);
    setQuery(null);
    // Put the caret after the name we just inserted, not back at the start.
    const cursor = query.at + person.fullName.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        className="input text-sm"
        rows={2}
        placeholder="Add a note for the team… type @ to notify someone"
        value={value}
        onChange={(e) => { onChange(e.target.value); readQuery(e.target.value, e.target.selectionStart); }}
        onClick={(e) => readQuery(value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[active]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit();
        }}
      />

      {open && (
        <ul
          role="listbox"
          aria-label="Mention a colleague"
          className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
        >
          {matches.map((person, i) => (
            <li key={person.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(person)}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm',
                  i === active ? 'bg-slate-100 dark:bg-slate-700' : 'hover:bg-slate-50 dark:hover:bg-slate-700/60',
                )}
              >
                <Avatar name={person.fullName} size={22} />
                <span className="truncate">{person.fullName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Every call with this person, from any source.
 *
 * Cloud telephony, the companion Android app and manually logged calls all land
 * in the same table, so a rep sees one history rather than having to know which
 * system a call came through. Recording playback and the outcome sit here too,
 * because "what happened on the last call" is the question this tab exists to
 * answer.
 */
function CallsTab({ recordId }: { recordId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const currentUser = useApp((state) => state.user);
  const [editing, setEditing] = useState<CallListItem | null>(null);
  const [draftDisposition, setDraftDisposition] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  // The stored outcome stays selectable even if the admin has since removed it:
  // opening an old call to fix its notes must not quietly rewrite its outcome.
  const editDispositions = useCallDispositions(draftDisposition);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const editVoice = useVoiceCapture(async (audio) => {
    try {
      const { note } = await api.voiceNote(audio);
      setDraftNotes((current) => current.trim() ? `${current.trim()}\n${note}` : note);
    } catch (err) {
      toast.error('Could not write the call note', (err as Error).message);
    }
  });
  const { data, isLoading } = useQuery({
    queryKey: ['record-calls', recordId],
    queryFn: () => api.calls({ recordId, limit: 50 }),
  });

  if (isLoading) {
    return <div className="card space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  }

  const calls = (data ?? []) as unknown as CallListItem[];

  const openEdit = (call: CallListItem): void => {
    setEditing(call);
    setDraftDisposition(call.disposition ?? 'Call Back Later');
    setDraftNotes(call.notes ?? '');
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    setSaving(true);
    try {
      await api.updateCall(editing.id, { disposition: draftDisposition, notes: draftNotes });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['record-calls', recordId] }),
        queryClient.invalidateQueries({ queryKey: ['call-history', editing.id] }),
      ]);
      toast.success('Call note updated');
      setEditing(null);
    } catch (err) {
      toast.error('Could not update the call note', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!calls.length) {
    return (
      <div className="card">
        <EmptyState
          title="No calls yet"
          body="Calls appear here automatically once a phone is paired in Settings → Phones, or when logged from the dialer."
        />
      </div>
    );
  }

  return (
    <div className="card divide-y divide-slate-100 dark:divide-slate-800">
      {calls.map((call) => (
        <div key={call.id} className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            {call.direction === 'inbound'
              ? <PhoneIncoming className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              : call.direction === 'outbound'
                ? <PhoneOutgoing className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                : <PhoneMissed className="h-3.5 w-3.5 shrink-0 text-red-500" />}
            <span className="text-sm font-medium capitalize">{call.direction}</span>
            {call.duration_seconds > 0 && (
              <span className="text-2xs text-muted tnum">
                {Math.floor(call.duration_seconds / 60)}m {call.duration_seconds % 60}s
              </span>
            )}
            {call.disposition && <Badge color="#0891b2">{call.disposition}</Badge>}
            <span className="ml-auto text-2xs text-muted">{relativeTime(call.started_at)}</span>
            {(currentUser?.isAdmin || call.user_id === currentUser?.id) && (
              <button type="button" className="btn-ghost p-1" onClick={() => openEdit(call)} title="Edit disposition note">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {call.notes && <p className="mt-1.5 text-sm text-muted">{call.notes}</p>}

          {call.recording_url && (
            <audio
              controls
              preload="none"
              src={api.recordingUrl(call.id)}
              className="mt-2 h-8 w-full max-w-md"
            />
          )}

          <div className="mt-1 flex items-center gap-2 text-2xs text-muted">
            {call.agent_name && <span>{call.agent_name}</span>}
            <button type="button" className="hover:text-brand-600 hover:underline" onClick={() => setHistoryOpen(call.id)}>
              See edit history
            </button>
          </div>
        </div>
      ))}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="Edit call disposition"
        size="sm"
        footer={(
          <>
            <button className="btn-secondary" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
            <button className="btn-primary" onClick={() => void saveEdit()} disabled={saving}>
              {saving && <Spinner className="h-3.5 w-3.5" />} Save changes
            </button>
          </>
        )}
      >
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="call-edit-outcome">Outcome</label>
            <select id="call-edit-outcome" className="input" value={draftDisposition} onChange={(event) => setDraftDisposition(event.target.value)}>
              {editDispositions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="label mb-0" htmlFor="call-edit-notes">Disposition notes</label>
              <button
                type="button" className={cn('btn-ghost btn-sm', editVoice.recording && 'text-red-600')}
                onClick={editVoice.toggle} disabled={!editVoice.supported || editVoice.busy}
              >
                {editVoice.busy ? <Spinner className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {editVoice.recording ? 'Stop' : editVoice.busy ? 'Writing…' : 'Speak'}
              </button>
            </div>
            <textarea id="call-edit-notes" className="input" rows={5} value={draftNotes} onChange={(event) => setDraftNotes(event.target.value)} />
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(historyOpen)} onClose={() => setHistoryOpen(null)} title="Call note edit history" size="md">
        {historyOpen && <CallEditHistory callId={historyOpen} />}
      </Modal>
    </div>
  );
}

interface CallListItem {
  id: string;
  user_id: string | null;
  direction: string;
  status: string;
  duration_seconds: number;
  disposition: string | null;
  notes: string | null;
  recording_url: string | null;
  started_at: string;
  agent_name: string | null;
}

function CallEditHistory({ callId }: { callId: string }): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['call-history', callId],
    queryFn: () => api.callHistory(callId),
  });
  if (isLoading) return <div className="space-y-2">{[1, 2].map((key) => <Skeleton key={key} className="h-16" />)}</div>;
  if (!data?.length) return <EmptyState title="No edits yet" body="The original call note has not been changed." />;
  return (
    <ol className="space-y-3">
      {data.map((raw) => {
        const item = raw as {
          id: string; previous_disposition: string | null; previous_notes: string | null;
          new_disposition: string | null; new_notes: string | null; created_at: string;
          edited_by_name: string | null;
        };
        return (
          <li key={item.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>{item.edited_by_name || 'System'}</span>
              <span>·</span>
              <span>{relativeTime(item.created_at)}</span>
            </div>
            {item.previous_disposition !== item.new_disposition && (
              <p className="mt-1 text-sm">Outcome: {item.previous_disposition || '—'} → {item.new_disposition || '—'}</p>
            )}
            {item.previous_notes !== item.new_notes && (
              <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                <div><p className="text-2xs font-medium text-muted">Before</p><p className="whitespace-pre-wrap">{item.previous_notes || '—'}</p></div>
                <div><p className="text-2xs font-medium text-muted">After</p><p className="whitespace-pre-wrap">{item.new_notes || '—'}</p></div>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
