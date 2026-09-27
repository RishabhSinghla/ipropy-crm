import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { recordStrength, type FieldMeta, type RecordEnvelope } from '@ipropy/shared';
import {
  ArrowRightLeft, ArrowUpDown, Check, ChevronLeft, ChevronRight, FileText, Link2,
  MessageCircle, MoreHorizontal, Phone, Sparkles, Star, Trash2, Users,
} from 'lucide-react';
import { FieldValue } from './FieldRenderer';
import { CallButton, CallDispositionProvider } from './CallDisposition';
import { WhatsAppComposerProvider } from './WhatsAppComposer';
import { MatchingTab } from './MatchingTab';
import { WhatsAppTab } from './WhatsAppTab';
import { WhatsAppButton } from './WhatsAppButton';
import { TagButton, TagChips } from './TagButton';
import { CallsTab, FilesTab, RecordCollaboratorsPanel, TimelineTab } from '../pages/RecordDetail';
import { EditableField, isInlineEditable } from './EditableField';
import { FieldBlock, HeaderFieldStrip, NotesPanel } from './RecordBlocks';
import { HeaderPills } from './HeaderPills';
import { CallDeckPanel, useCallIsOn } from './CallDeckPanel';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import { cardArea, cardPrice, queueCardFields, unitDescription, type CardFields } from '../lib/queueCard';
import { badgeVars } from '../lib/color';
import { followUpChip } from '../lib/followUpDates';
import { invalidateRecordQueries } from '../lib/invalidate';
import { ModuleIcon } from './Layout';
import { Avatar, ConfirmDialog, Dropdown, DropdownItem, Modal, Spinner } from './ui';
import { ACTION_CIRCLE } from '../lib/actionCircle';
import { RecordAvatar } from './RecordAvatar';
import { api } from '../lib/api';
import { FollowUpBadge } from './FollowUpChip';
import { activeSortOption, sortOptions } from '../lib/listSort';
import { cn, restrictionForField } from '../lib/utils';
import { toast } from '../lib/store';
import { queueRecordUrl } from '../lib/saveNextUrl';

type DeskTabKey = 'overview' | 'timeline' | 'matching' | 'files' | 'calls' | 'whatsapp';

/**
 * The module as the list itself has it: fields, the layout an admin arranged,
 * and the two things writing needs — what this profile may do, and which
 * picklist narrows which.
 */
/*
  Where the divider sits, remembered in the browser.

  The same reasoning as which view a list opens in: it is a personal
  preference somebody adjusts several times a day, it is nobody else's
  business, and a per-user setting needing a round trip to say how wide you
  like your queue is slow at exactly the wrong moment.

  One divider, not two. The owner's instruction on 19 September: "we work only
  in two split panes in future" — the notes moved beside Basic Information,
  where a note is written about what is on screen rather than in a third
  column competing with it for width.
*/
const SPLIT_KEY = 'ipropy.split';
const QUEUE_LIMITS = [240, 620] as const;

function loadSplit(fallback: number): number {
  const [min, max] = QUEUE_LIMITS;
  try {
    const raw = Number(localStorage.getItem(`${SPLIT_KEY}.queue`));
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.min(max, Math.max(min, raw));
  } catch {
    // A private window and blocked site data both throw here, and a divider
    // that cannot be remembered is not a reason for a blank screen.
    return fallback;
  }
}

/**
 * The grip between the queue and the record.
 *
 * Pointer events rather than mouse events, so the same handler answers a
 * finger on a tablet — which is where this view gets used, standing in a site
 * office. The pointer is captured on the handle, so a fast drag that outruns
 * the cursor does not let go halfway across the screen.
 *
 * Arrow keys move it too. A divider that only answers a mouse is one that
 * somebody working from the keyboard cannot move at all.
 */
function SplitHandle({ label, width, onDrag }: { label: string; width: number; onDrag: (deltaX: number) => void }): JSX.Element {
  const from = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      // A separator you can focus is a control, and a control says where it
      // is: without these a screen reader announces a divider it cannot place.
      aria-valuenow={width}
      aria-valuemin={QUEUE_LIMITS[0]}
      aria-valuemax={QUEUE_LIMITS[1]}
      tabIndex={0}
      className="group relative hidden w-1.5 shrink-0 cursor-col-resize touch-none bg-slate-200 transition-colors hover:bg-brand-400 focus:bg-brand-400 focus:outline-none dark:bg-slate-800 xl:block"
      onPointerDown={(event) => {
        from.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const delta = event.clientX - from.current;
        from.current = event.clientX;
        onDrag(delta);
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); onDrag(-24); }
        if (event.key === 'ArrowRight') { event.preventDefault(); onDrag(24); }
      }}
    >
      <span className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-slate-400 opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}


/**
 * The split view: the queue on the left, the whole record beside it — and
 * **nothing that sends you anywhere else**.
 *
 * That is the owner's instruction on 19 September, and it is the shape of the
 * job: a rep works a list, and every trip to another page is a trip back. So
 * there is no Edit button, no "open the full record" button and no dialog.
 * Everything the record page shows is here, and every value is typed in where
 * it stands.
 *
 * Two things it needs that a list row cannot give:
 *
 *  * **the whole record.** A list row carries only the values the *list* asked
 *    for, so a field that is not a column read back blank — which is exactly
 *    why Contact Type was missing from the header. The open record is fetched
 *    by id, on the key the record page already uses.
 *  * **who owns it.** `ownerName` is filled in by nothing except the phone
 *    app's caller lookup, so this header said "Unassigned" on every record
 *    however it was assigned. The assignment field is drawn the way the record
 *    page draws it — found by uitype, shown by its display value, edited in
 *    place, and sitting between the name and when it was last touched.
 */
export function IpropyWorkspace({
  module, rows, selected, attentionIds, onToggleSelect, onToggleAll, onDelete,
  openId, sortBy, sortDir, neighbourContext, callQueueUrl, onSort,
}: {
  module: DescribedModule; rows: RecordEnvelope[];
  selected: Set<string>; attentionIds: Set<string>; onToggleSelect: (id: string, checked: boolean) => void;
  /** Tick every row on this page, for the bulk-edit bar the list already has. */
  onToggleAll?: (checked: boolean) => void;
  /** Absent when this profile may not delete — the button is not offered at all. */
  onDelete?: (row: RecordEnvelope) => void;
  /**
   * A record to open straight away, named in the address as `?open=`.
   *
   * It may not be in the queue at all — global search reaches all 22,981
   * contacts and the queue is one page of fifty — so the pane fetches it by id
   * rather than looking for it among the rows.
   */
  openId?: string | null;
  /** The list's own ordering, so the queue's menu drives the same query the table does. */
  sortBy?: string; sortDir?: 'asc' | 'desc';
  /** The active list's filters, so record navigation follows the queue in view. */
  neighbourContext?: { view?: string; search?: string; filter?: string };
  /** Snapshot of the effective queue, including unsaved quick-filter choices. */
  callQueueUrl: string;
  onSort?: (by: string | undefined, dir: 'asc' | 'desc') => void;
}): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(openId ?? rows[0]?.id ?? null);
  const [tab, setTab] = useState<DeskTabKey>('overview');
  const [queueWidth, setQueueWidth] = useState(() => loadSplit(360));
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  /*
    How tall the two panes are, measured rather than guessed.

    It used to be `calc(100vh - 13rem)`, a stand-in for whatever the toolbar
    above happens to be — and it was about a hundred pixels out, which is the
    white gap under the queue the owner reported. Reading the shell's own
    distance from the top of the page is exact, and it stays exact when the
    toolbar above grows a row.
  */
  const shell = useRef<HTMLDivElement>(null);

  /*
    The header's field strip is **one row, always**, and says so when it cannot
    fit: *"Please set all in one row, so that we can see narrow header and wide
    Timeline… if more then line should make it in dash … so that we can choose
    only option from master."*

    Wrapping was the old behaviour, and a header that grows to two or three
    rows eats the screen the work happens on. Clipping alone would hide fields
    silently, so the row is measured and a `…` appears when something is out of
    sight — the cue to arrange fewer of them in the Layout Designer. That
    measuring lives in `HeaderFieldStrip` now, shared with the Chats header.
  */
  const [paneTop, setPaneTop] = useState(0);
  useEffect(() => {
    const measure = (): void => {
      const box = shell.current?.getBoundingClientRect();
      if (box) setPaneTop(Math.round(box.top + window.scrollY));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);


  const star = useMutation({
    mutationFn: (row: RecordEnvelope) => api.star(module.name, row.id, !row.starred),
    /*
      **With the record's id.** Without it `invalidateRecordQueries` refreshes
      the lists and leaves `['record', module, id]` alone — and this header
      reads the *fetched record*, not the list row. So the star saved, the
      queue knew, and the button somebody had just pressed stayed exactly as it
      was until something else happened to refetch. That is the whole of
      "favourite does not work properly in split view".
    */
    onSuccess: (_result, row) => invalidateRecordQueries(queryClient, module.name, row.id),
    onError: (error: Error) => toast.error('Could not change that', error.message),
  });
  // Somebody arriving on a link that names a record: open that one.
  useEffect(() => { if (openId) setActiveId(openId); }, [openId]);
  /*
    Keep the open record when the queue changes under it — **including one that
    is not in the queue at all.** A record reached from global search or from a
    chat is almost never on the fifty rows showing, and without that second
    condition the pane snapped back to the first row the moment the list
    refreshed.
  */
  useEffect(() => setActiveId((current) => (
    current && (current === openId || rows.some((row) => row.id === current))
      ? current
      : (rows[0]?.id ?? null)
  )), [rows, openId]);

  const listRow = rows.find((row) => row.id === activeId) ?? (activeId ? null : rows[0] ?? null);

  const { data: fetched, isError: notThere } = useQuery({
    queryKey: ['record', module.name, activeId],
    queryFn: () => api.record(module.name, activeId!),
    enabled: Boolean(activeId),
    retry: false,
  });
  /*
    A link naming a record that is gone, or never existed — a stale bookmark, a
    deleted lead, a mistyped address. Without this the pane sat empty with a
    queue full of records beside it, which reads as the screen being broken
    rather than as one link being wrong.
  */
  useEffect(() => {
    if (notThere) setActiveId(rows[0]?.id ?? null);
  }, [notThere, rows]);
  // The row stands in while the record loads, so the pane never blanks between
  // two selections. Its values are right, there are simply fewer of them.
  const active = fetched && fetched.id === activeId ? fetched : listRow;

  const { data: neighbours } = useQuery({
    queryKey: ['record-neighbours', module.name, activeId, neighbourContext, sortBy, sortDir],
    queryFn: () => api.neighbours(module.name, activeId!, {
      ...neighbourContext,
      ...(sortBy ? { sort: sortBy } : {}),
      ...(sortDir ? { dir: sortDir } : {}),
    }),
    enabled: Boolean(activeId),
    staleTime: 15_000,
  });
  const openRecord = useCallback((id: string) => {
    setActiveId(id);
    const next = new URLSearchParams(window.location.search);
    next.set('open', id);
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);
  const openNeighbour = useCallback((id: string, estimatedPosition: number) => {
    if (rows.some((row) => row.id === id)) {
      openRecord(id);
      return;
    }
    // Crossing a page boundary needs both a new page and a new open record.
    // Re-read the destination's ordinal because another rep may have edited
    // the queue since the current record's neighbours were fetched.
    void api.neighbours(module.name, id, {
      ...neighbourContext,
      ...(sortBy ? { sort: sortBy } : {}),
      ...(sortDir ? { dir: sortDir } : {}),
    }).then(({ position }) => {
      window.location.assign(queueRecordUrl(callQueueUrl, module.name, id, position ?? estimatedPosition));
    }).catch(() => {
      window.location.assign(queueRecordUrl(callQueueUrl, module.name, id, estimatedPosition));
    });
  }, [rows, openRecord, module.name, neighbourContext, sortBy, sortDir, callQueueUrl]);

  const resize = useCallback((delta: number) => {
    const [min, max] = QUEUE_LIMITS;
    setQueueWidth((current) => {
      const next = Math.min(max, Math.max(min, current + delta));
      try { localStorage.setItem(`${SPLIT_KEY}.queue`, String(Math.round(next))); } catch { /* see loadSplit */ }
      return next;
    });
  }, []);

  /*
    Which fields this module's panes show — the Layout Designer's
    arrangement, then the Layout Designer's, then the module's own flags.

    One hook, because the WhatsApp Chats screen shows the same record beside a
    conversation and must reach the same answer. A second copy of this
    reasoning is the mistake this repo keeps finding months later.
  */
  const { headerFields, blocks, assignedField, statusField, followUpField, phoneField } = useRecordPanes(module);
  const { data: assignableUsers = [] } = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.users(false, false, true),
    enabled: Boolean(assignedField),
    staleTime: 5 * 60_000,
  });
  const assignedUserId = assignedField ? String(active?.values[assignedField.name] ?? '') : '';
  const assignedName = assignedField
    ? String(active?.display?.[assignedField.name]
      || assignableUsers.find((candidate) => candidate.id === assignedUserId)?.fullName
      || '')
    : '';
  const cardFields = useMemo(() => queueCardFields(module.fields), [module.fields]);
  const phoneValue = active && phoneField ? displayOf(active, phoneField) : '';
  const { data: matchingCount } = useQuery({
    queryKey: ['workspace-matching-count', module.name, active?.id],
    enabled: Boolean(active?.id),
    staleTime: 60_000,
    queryFn: async (): Promise<number> => {
      if (!active) return 0;
      if (module.name === 'leads') return (await api.matchProperties(module.name, active.id, false, 50)).matches?.length ?? 0;
      return (await api.buyersForProperty(active.id, false, 50)).buyers?.length ?? 0;
    },
  });

  /*
    What the queue's one menu can do — eight questions and a direction, the
    same eight in both modules, none of them named in this file.

    It used to be built out of the module's own fields: the name A–Z, then one
    row per subtitle field, then the stage. The owner asked for those to go on
    27 September 2026 and for these in their place, with *nothing* chosen by
    default so that a filtered list holds still while it is worked.
  */
  const choices = useMemo(() => sortOptions(followUpField?.name), [followUpField?.name]);
  const chosen = activeSortOption(choices, sortBy);
  // A column heading clicked in the table view is not one of the eight, so the
  // button says which field it is rather than claiming one of them.
  const sortedByColumn = chosen ? null : module.fields.find((field) => field.name === sortBy);

  /*
    The three dots, brought across from the record page on the owner's ask.

    Not a link to that page — he asked for the split view to be somewhere you
    never leave — so the same four actions are done here, against whichever
    record the queue has open. The dialogs are the record page's own
    components rather than copies: one Share-with-team panel, one confirm.
  */
  const [summarising, setSummarising] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [sharingWithTeam, setSharingWithTeam] = useState(false);
  const [moveTarget, setMoveTarget] = useState<'leads' | 'properties' | null>(null);

  const move = useMutation({
    mutationFn: (target: 'leads' | 'properties') => api.move(module.name, active!.id, target),
    onSuccess: (moved, target) => {
      toast.success(`Moved to ${target === 'properties' ? 'Inventories' : 'Leads'}`, moved.label);
      invalidateRecordQueries(queryClient, module.name, active?.id);
      void queryClient.invalidateQueries({ queryKey: ['records', target] });
      // The record has left this module, so the queue must forget it rather
      // than keep a pane open on something that is no longer here.
      void queryClient.invalidateQueries({ queryKey: ['records', module.name] });
      setActiveId(null);
    },
    onError: (err: Error) => toast.error('Could not move it', err.message),
  });

  // A list row carries no `can`, so the module's own permission stands in
  // until the record itself arrives and answers for this row.
  const canEdit = active?.can?.edit ?? module.permissions.edit;
  // While a call is up on the open record, the deck takes the notes box's place.
  const onCall = useCallIsOn(module.name, active?.id ?? '');
  const allChecked = rows.length > 0 && rows.every((row) => selected.has(row.id));

  /*
    One provider around the whole view, **not keyed on the open record**.
    Keyed, every click in the list rebuilt the entire split view — list
    included — so the list jumped back to the top and the record just clicked
    scrolled out of sight (26 September 2026, the owner). A call belongs to the
    record it was started from through `useLiveCall` now, and the WhatsApp
    composer closes itself when the record changes, so neither needs the key.
  */
  return <CallDispositionProvider recordId={active?.id ?? ''} module={module.name} queue={{
    nextId: neighbours?.nextId ?? null,
    position: neighbours?.position ?? null,
    total: neighbours?.total ?? null,
    url: callQueueUrl,
  }}>
    <WhatsAppComposerProvider recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
    <section data-testid="ipropy-workspace" className="bg-[var(--app-bg)] dark:bg-slate-950">
    {/*
      A fixed-height row with one draggable divider, not a min-height one.

      Height rather than min-height is what closes the white gap under the
      queue the owner reported: with `min-h` the two panes are as tall as the
      taller of them, the queue stops at its last row, and the page keeps
      scrolling past it. Fixed to the viewport, each pane scrolls inside
      itself, so the queue shows as many records as the screen can hold and
      ends exactly at the bottom of it.

      Below `xl` the panes stack and the width is ignored entirely — the handle
      is `xl:block`, because a divider you cannot see is not one you can drag.
    */}
    <div
      ref={shell}
      className="flex min-h-[calc(100vh-13rem)] flex-col gap-2 p-2 xl:h-[var(--pane-h)] xl:min-h-0 xl:flex-row"
      style={{
        ['--queue-w' as string]: `${queueWidth}px`,
        ['--pane-h' as string]: paneTop ? `calc(100vh - ${paneTop}px)` : 'calc(100vh - 13rem)',
      }}
    >
      {/* ---------------------------------------------------------------- */}
      {/* Pane 1 — the queue.                                              */}
      {/* ---------------------------------------------------------------- */}
      <aside className="flex w-full shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900 xl:w-[var(--queue-w)]">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
          <span className="flex min-w-0 items-center gap-1.5">
            {/* Beside the module's own name, because that is what it selects:
                everything on this page, for the bulk-edit bar the list already
                carries. */}
            {onToggleAll && (
              <input
                type="checkbox"
                aria-label={`Select all ${module.label.toLowerCase()} shown`}
                checked={allChecked}
                onChange={(event) => onToggleAll(event.target.checked)}
                className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-slate-300"
              />
            )}
            <span className="flex min-w-0 items-center gap-1 truncate text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
              <ModuleIcon name={module.icon} className="h-3 w-3 shrink-0 text-slate-400" />
              <span className="truncate">{module.label}</span>
              <span className="shrink-0 font-normal text-muted">({rows.length})</span>
            </span>
          </span>
          {onSort && (
            <Dropdown
              align="right"
              trigger={(
                <button
                  type="button"
                  className="flex max-w-[10rem] shrink-0 items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300"
                  aria-label="Sort this list"
                >
                  <ArrowUpDown className="h-3 w-3 shrink-0 text-slate-400" />
                  <span className="truncate">
                    {chosen?.label ?? `Sorted by ${sortedByColumn?.label ?? 'a column'}`}
                  </span>
                </button>
              )}
            >
              {(close) => (
                <div className="py-1" data-testid="queue-sort-menu">
                  {/*
                    One direction control for the whole menu rather than a
                    second row per option — "Minimal Drop down, Specially
                    Sorting by Z-A / A-Z" (27 September 2026). It is dead
                    while nothing is sorted, because there is no direction
                    for an order nobody has asked for.
                  */}
                  <div className="flex items-center gap-1 px-3 pb-1.5 pt-1.5">
                    <p className="mr-auto text-2xs font-bold uppercase tracking-wide text-muted">Sort by</p>
                    {(['asc', 'desc'] as const).map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        disabled={!chosen?.by && !sortBy}
                        title={dir === 'asc' ? (chosen?.ascHint ?? 'A–Z') : (chosen?.descHint ?? 'Z–A')}
                        onClick={() => onSort(sortBy, dir)}
                        className={cn(
                          'rounded px-1.5 py-0.5 text-2xs font-bold transition-colors',
                          sortDir === dir && (chosen?.by || sortBy)
                            ? 'bg-brand-700 text-white'
                            : 'text-slate-500 hover:bg-[var(--surface-muted)] disabled:opacity-40 dark:text-slate-400',
                        )}
                      >
                        {dir === 'asc' ? 'A–Z' : 'Z–A'}
                      </button>
                    ))}
                  </div>
                  {choices.map((option) => (
                    <DropdownItem
                      key={option.key}
                      icon={<Check className={cn('h-3.5 w-3.5', chosen?.key === option.key ? 'text-brand-600' : 'invisible')} />}
                      onClick={() => { onSort(option.by, sortDir ?? 'desc'); close(); }}
                    >
                      {option.label}
                    </DropdownItem>
                  ))}
                </div>
              )}
            </Dropdown>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
          {rows.map((row) => (
            <QueueCard
              key={row.id}
              row={row}
              active={row.id === active?.id}
              checked={selected.has(row.id)}
              attention={attentionIds.has(row.id)}
              card={cardFields}
              followUpField={followUpField ?? cardFields.followUp}
              statusField={statusField}
              onSelect={() => openRecord(row.id)}
              onToggle={(checked) => onToggleSelect(row.id, checked)}
            />
          ))}
        </div>
      </aside>

      <SplitHandle label="Resize the list" width={queueWidth} onDrag={resize} />

      {/* ---------------------------------------------------------------- */}
      {/* Pane 2 — the record.                                             */}
      {/* ---------------------------------------------------------------- */}
      {active && <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
        {/*
          The hero, as the owner drew it on 27 September 2026: where this
          record sits in the queue and who owns it on one line, the face in the
          middle of its own completeness ring, the controls either side of it,
          and the facts a rep changes on a call along the bottom.
        */}
        <header className="shrink-0 border-b border-slate-200/80 bg-gradient-to-b from-sage-50/70 via-cream-50 to-white p-3.5 dark:border-slate-800 dark:from-slate-800/60 dark:via-slate-900 dark:to-slate-900">
          <div className="mb-2 flex w-full items-center justify-between gap-2">
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200/60 bg-white/80 px-2 py-0.5 text-xs font-medium text-slate-500 shadow-2xs dark:border-slate-700 dark:bg-slate-800/80" aria-label="Record navigation">
              <button type="button" aria-label="Previous record" title="Previous record" disabled={!neighbours?.prevId} onClick={() => neighbours?.prevId && openNeighbour(neighbours.prevId, Math.max(1, (neighbours.position ?? 2) - 1))} className="rounded p-0.5 transition hover:bg-slate-100 hover:text-brand-700 disabled:opacity-30 dark:hover:bg-slate-700">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-1 text-[11px] font-semibold tabular-nums text-slate-700 dark:text-slate-200" aria-live="polite">
                {neighbours?.position && neighbours.total ? `${neighbours.position} / ${neighbours.total.toLocaleString('en-IN')}` : '—'}
              </span>
              <button type="button" aria-label="Next record" title="Next record" disabled={!neighbours?.nextId} onClick={() => neighbours?.nextId && openNeighbour(neighbours.nextId, (neighbours.position ?? 0) + 1)} className="rounded p-0.5 transition hover:bg-slate-100 hover:text-brand-700 disabled:opacity-30 dark:hover:bg-slate-700">
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <TagChips module={module.name} tags={active.tags} className="max-w-[10rem]" />
              {assignedField && (
                /*
                  27 September 2026, the owner: *"in the Assigned to and Name n
                  Only Agent name and Avtar show there in Small Font."* The word
                  "Assigned:" and the pill around it were two-thirds of what
                  that corner said; the face and the name are the fact.
                */
                <span className="inline-flex min-w-0 shrink-0 items-center gap-1.5 text-[11px]" title="Assigned to">
                  {assignedName && <Avatar name={assignedName} size={16} />}
                  {canEdit && isInlineEditable(assignedField) ? (
                    <EditableField
                      module={module.name}
                      recordId={active.id}
                      field={assignedField}
                      value={active.values[assignedField.name]}
                      display={assignedName}
                      compact
                      siblings={active.values}
                      restrictTo={restrictionForField(module.picklistDependencies, active.values, assignedField.name)}
                      onSaved={() => invalidateRecordQueries(queryClient, module.name, active.id)}
                    />
                  ) : (
                    <FieldValue field={assignedField} value={active.values[assignedField.name]} display={assignedName} compact />
                  )}
                </span>
              )}
            </span>
          </div>

          {/*
            The face in the middle, everything you do to the record on the
            right — 27 September 2026: *"The Call and whatsapp icon move to
            adjoining of Tag and Star icon."* A three-column grid rather than
            `justify-between`, so the face stays in the middle of the panel
            however many controls sit beside it.
          */}
          <div className="relative mb-1.5 grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2 px-2">
            <span aria-hidden />

            {/* The face, ringed by how complete the record is. */}
            <span className="flex min-w-0 flex-col items-center justify-center text-center">
              <RecordAvatar
                module={module.name}
                recordId={active.id}
                name={active.label}
                percent={recordStrength(module.fields, active.values).percent}
                canEdit={canEdit}
                size={112}
              />
              {/*
                The name, then the number, divided by a hairline — *"Move
                Mobile Number after Name with line seprator."* The number is
                dropped from the chip strip below so it is not said twice.
              */}
              <span className="mt-2 flex min-w-0 max-w-full items-center justify-center gap-2.5">
                <h2 className="min-w-0 truncate text-lg font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
                  {active.label}
                </h2>
                {phoneField && phoneValue && (
                  <>
                    <span className="h-4 w-px shrink-0 bg-slate-300 dark:bg-slate-600" aria-hidden />
                    <span className="shrink-0 text-sm font-semibold text-slate-600 dark:text-slate-300">
                      {canEdit && isInlineEditable(phoneField) ? (
                        <EditableField
                          module={module.name}
                          recordId={active.id}
                          field={phoneField}
                          value={active.values[phoneField.name]}
                          display={active.display?.[phoneField.name]}
                          compact
                          siblings={active.values}
                          onSaved={() => invalidateRecordQueries(queryClient, module.name, active.id)}
                        />
                      ) : (
                        <FieldValue field={phoneField} value={active.values[phoneField.name]} display={active.display?.[phoneField.name]} compact />
                      )}
                    </span>
                  </>
                )}
              </span>
            </span>

            {/* Right: everything you do to the record, in one group. */}
            <span className="z-10 flex shrink-0 items-center justify-end gap-2">
              {phoneValue && <WhatsAppButton to={phoneValue} iconOnly round />}
              {phoneValue && <CallButton to={phoneValue} iconOnly round active={onCall} />}
              <TagButton
                module={module.name}
                recordId={active.id}
                tags={active.tags}
                canEdit={canEdit}
                className={cn(
                  ACTION_CIRCLE,
                  active.tags?.length && 'border-brand-300 bg-brand-100 text-brand-800 dark:border-brand-700 dark:bg-brand-950/60 dark:text-brand-200',
                )}
              />
              <button
                aria-label={active.starred ? 'Remove from starred' : 'Star this record'}
                title={active.starred ? 'Remove from starred' : 'Star this record'}
                onClick={() => star.mutate(active)}
                className={cn(
                  ACTION_CIRCLE,
                  'hover:bg-amber-500',
                  active.starred && 'border-amber-300 bg-amber-50 text-amber-500',
                )}
              >
                <Star className={cn('h-4 w-4', active.starred && 'fill-amber-500')} />
              </button>
              <Dropdown
                align="right"
                className="min-w-[15rem]"
                trigger={(
                  <button className={ACTION_CIRCLE} aria-label="More actions" title="More actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <DropdownItem
                      icon={summarising ? <Spinner className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                      onClick={() => {
                        close();
                        setSummarising(true);
                        void api.summarise(module.name, active.id)
                          .then((result) => setSummary(result.summary))
                          .catch((err: Error) => toast.error('Summary failed', err.message))
                          .finally(() => setSummarising(false));
                      }}
                    >
                      {summarising ? 'Summarising…' : 'Summarise with AI'}
                    </DropdownItem>
                    {canEdit && (
                      <DropdownItem icon={<Users className="h-3.5 w-3.5" />} onClick={() => { setSharingWithTeam(true); close(); }}>
                        Share with team
                      </DropdownItem>
                    )}
                    {canEdit && onDelete && (
                      <DropdownItem
                        icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
                        onClick={() => { close(); setMoveTarget(module.name === 'leads' ? 'properties' : 'leads'); }}
                      >
                        Move to {module.name === 'leads' ? 'Inventories' : 'Leads'}
                      </DropdownItem>
                    )}
                    {onDelete && (
                      <DropdownItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={() => { close(); onDelete(active); }}>
                        Delete record
                      </DropdownItem>
                    )}
                  </>
                )}
              </Dropdown>
            </span>
          </div>

          {/*
            The facts a call changes, as chips — the stage, the chase date and
            whatever else the Layout Designer puts in this module's header,
            each typed in where it stands. One measuring rule with the ledger
            strip the WhatsApp header shows; only the clothes differ.
          */}
          {/*
            The facts a call changes, as chips — *"editable Beautiful solid
            multi colour rounded chips"*. Which fields those are stays the
            Layout Designer's decision; what this file decides is that they are
            chips and that the chase date wears the queue's own Today /
            Tomorrow / Pending / Overdue colours.

            No rule above it: *"A separator line below Name not necessary and
            the Status etc Button space should be compact."*
          */}
          <div className="flex items-center gap-2">
            <HeaderFieldStrip
              module={module}
              row={active}
              /*
                Without the number: it moved on to the name line above, and
                saying it twice two inches apart is what the strip was already
                being trimmed of elsewhere.
              */
              fields={headerFields.filter((field) => field.name !== phoneField?.name)}
              canEdit={canEdit}
              variant="chips"
              followUpField={followUpField?.name}
              className="min-w-0 flex-1"
            />
            <HeaderPills module={module} row={active} canEdit={canEdit} />
          </div>
        </header>

        {/*
          27 September 2026: *"Overview and Timeline Menu should be Compact,
          so the Left to right scroller now Showing."* Tighter type and less
          air between them, so six tabs fit the middle pane at the width it
          actually gets — the scroller stays as the honest answer on a phone
          rather than as the everyday state.
        */}
        <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-900" aria-label="Record workspace sections">
          <DeskTab active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</DeskTab>
          <DeskTab active={tab === 'timeline'} onClick={() => setTab('timeline')}>Timeline</DeskTab>
          <DeskTab active={tab === 'matching'} onClick={() => setTab('matching')}><Link2 className="h-3.5 w-3.5" />Matching {module.name === 'leads' ? 'inventory' : 'leads'} {matchingCount ? <span className="rounded-full bg-slate-100 px-1 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{matchingCount}</span> : null}</DeskTab>
          <DeskTab active={tab === 'files'} onClick={() => setTab('files')}><FileText className="h-3.5 w-3.5" />Files</DeskTab>
          <DeskTab active={tab === 'calls'} onClick={() => setTab('calls')}><Phone className="h-3.5 w-3.5" />Calls</DeskTab>
          <DeskTab active={tab === 'whatsapp'} onClick={() => setTab('whatsapp')}><MessageCircle className="h-3.5 w-3.5" />WhatsApp</DeskTab>
        </nav>

        {/*
          **One scroll area, never two stacked.** The WhatsApp tab has its own
          scrolling message list; with this pane scrolling too, the wheel went
          to whichever happened to be under the mouse — 25 September 2026, the
          owner: *"only bringing mouse to a certain place scroll is working."*
        */}
        <div className={cn(
          'min-w-0 flex-1 bg-[#fafbfa] dark:bg-slate-950/40',
          tab === 'whatsapp' ? 'flex min-h-0 flex-col overflow-hidden' : 'space-y-5 overflow-y-auto p-5',
        )}>
          {tab === 'overview' && blocks.map((block) => (
            <FieldBlock
              key={block.key}
              module={module}
              title={block.label}
              columns={block.columns}
              fields={block.fields}
              row={active}
              canEdit={canEdit}
            />
          ))}
          {tab === 'timeline' && <TimelineTab module={module.name} id={active.id} />}
          {tab === 'matching' && <MatchingTab module={module.name} id={active.id} returnQuery="" recordLabel={active.label} />}
          {tab === 'files' && <FilesTab module={module.name} id={active.id} canEdit={canEdit} />}
          {tab === 'calls' && <CallsTab recordId={active.id} />}
          {tab === 'whatsapp' && <WhatsAppTab module={module.name} recordId={active.id} mobile={phoneValue || null} />}
        </div>
      </section>}

      {/* ---------------------------------------------------------------- */}
      {/* Pane 3 — the call, and what was said.                            */}
      {/* ---------------------------------------------------------------- */}
      {active && (
        <aside
          data-testid="activity-pane"
          className="flex w-full shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200/90 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900 xl:w-96"
        >
          {/*
            The deck and the notes are one pane now — 27 September 2026, the
            owner: *"call deck merge in to Note/Comment pane/Box"*. The deck
            only exists while a call is up on this very record; the notes and
            the activity below it are always there, which is the half that was
            being taken away every time somebody pressed Call.
          */}
          {onCall && <CallDeckPanel module={module.name} recordId={active.id} />}
          <NotesPanel module={module.name} record={active} flush />
        </aside>
      )}
    </div>

    {/*
      What the three-dots menu opens. Mounted once for the pane rather than
      per row, and keyed on nothing — each reads `active` at the moment it is
      opened, and each closes itself when it is done.
    */}
    <Modal
      open={sharingWithTeam && Boolean(active)}
      onClose={() => setSharingWithTeam(false)}
      title={`Share ${module.singularLabel ?? module.label} with team`}
    >
      {active && <RecordCollaboratorsPanel module={module.name} recordId={active.id} />}
    </Modal>

    <Modal
      open={Boolean(summary)}
      onClose={() => setSummary(null)}
      title={`Summary of ${active?.label ?? ''}`}
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-brand-100 bg-brand-50/60 p-4 text-sm leading-6 text-slate-700 dark:border-brand-900 dark:bg-brand-950/30 dark:text-slate-200">
          {summary}
        </div>
        <p className="text-xs text-muted">
          Built only from the CRM fields and activity you are allowed to see; missing facts are not invented.
        </p>
      </div>
    </Modal>

    <ConfirmDialog
      open={moveTarget !== null}
      onClose={() => setMoveTarget(null)}
      onConfirm={async () => {
        if (moveTarget) await move.mutateAsync(moveTarget);
        setMoveTarget(null);
      }}
      title={`Move to ${moveTarget === 'properties' ? 'Inventories' : 'Leads'}?`}
      body="Matching values, files, and call history move to the new record. The original record is removed from its current module."
      confirmLabel={move.isPending ? 'Moving…' : 'Move record'}
    />
    </section>
    </WhatsAppComposerProvider>
  </CallDispositionProvider>;
}

/**
 * One record in the queue, as a card.
 *
 * **26 September 2026, the owner**, from a mock-up, in the colours he chose:
 *
 *   Name  [TYPE]                                         [ CONTACTED ]
 *   Single, 4 BHK Builder Floor, Greenfields Colony
 *   ₹1.85 Cr  2,100 sq.ft                                     [TODAY]
 *
 * The open record carries a violet bar down its left edge and a lifted ring,
 * so which one is open reads at a glance. The middle line is cut short with
 * "…" rather than wrapping, so every card is the same height.
 *
 * Which fields that line shows is the Field Manager's `config.listSubtitle`
 * flag and nothing else — Admin → Split View used to outrank it and was
 * removed on 27 September 2026.
 *
 * **27 September 2026, the owner:** *"Replace the Star icon with Lead/Inventory
 * Status."* So the corner that carried a favourite now carries the stage the
 * record is at, which is the fact a rep scans a queue for. Favouriting is
 * still on the record's own header, a click away.
 *
 * The card and its tick box are separate buttons laid over one another rather
 * than one button holding another. A button inside a button is not allowed in
 * HTML, and a screen reader cannot reach the inner one.
 */
function QueueCard({ row, active, checked, attention, card, followUpField, statusField, onSelect, onToggle }: {
  row: RecordEnvelope;
  active: boolean;
  checked: boolean;
  attention: boolean;
  card: CardFields;
  followUpField?: FieldMeta;
  /** The module's own stage field, whatever it is called here. */
  statusField?: FieldMeta;
  onSelect: () => void;
  onToggle: (checked: boolean) => void;
}): JSX.Element {
  const read = (field: FieldMeta): string => displayOf(row, field);
  const type = card.type ? read(card.type) : '';
  const unit = card.unit ? read(card.unit) : '';
  const description = unitDescription(card, read);
  const price = card.price ? cardPrice(row.values[card.price.name]) : '';
  const areaUnitField = card.area?.config.unitField;
  const area = card.area
    ? cardArea(row.values[card.area.name], typeof areaUnitField === 'string' ? row.values[areaUnitField] : undefined)
    : '';
  const followUp = followUpField ? row.values[followUpField.name] : null;
  const due = followUpChip(followUp);
  const stage = statusField ? String(row.values[statusField.name] ?? '') : '';
  // The admin's own colour for that stage, never a hue written here.
  const stageOption = statusField?.options?.find((option) => option.value === stage);
  const stageLabel = stageOption?.label ?? stage;

  /*
    The open record is brought into view when it was opened from somewhere
    else — global search, a link, Save & Next — and left exactly where it is
    when it was clicked, because `nearest` does nothing to a card already on
    screen.
  */
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) self.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div ref={self} data-testid="queue-card" className="group relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'relative block w-full cursor-pointer rounded-lg p-2.5 text-left transition',
          /*
            The open card, as the owner drew it on 27 September 2026: a ringed
            violet card with a bar running down its left edge, rather than the
            tinted row it was. The bar is an element and not a border, which is
            the rule this repo keeps: two `border-*` utilities on one element
            let Tailwind's own stylesheet order pick the colour, and the marker
            came out slate on slate once.
          */
          active
            ? 'border-2 border-brand-600 bg-brand-50/80 shadow-md ring-2 ring-brand-500/20 dark:border-brand-500 dark:bg-brand-950/40'
            : 'border border-transparent hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-700 dark:hover:bg-slate-800',
        )}
      >
        {active && (
          <span
            className="absolute -left-1 bottom-2 top-2 w-1.5 rounded-r-md bg-brand-700 shadow-xs dark:bg-brand-400"
            aria-hidden
          />
        )}

        {/* 1. Who, and what kind of contact. */}
        <span className={cn('flex min-w-0 items-center gap-1.5 pr-16', active && 'pl-1.5')}>
          <span className={cn(
            'truncate text-xs',
            active ? 'font-extrabold tracking-tight text-brand-900 dark:text-brand-100' : 'font-bold text-slate-900 dark:text-slate-100',
          )}>
            {row.label}
          </span>
          {type && <TypeFlag label={type} strong={active} />}
          {attention && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Needs attention" />}
        </span>

        {/* 2. Which unit, cut short with "…" rather than wrapped. */}
        <span className={cn(
          'mt-1 block min-w-0 truncate text-[11px]',
          active ? 'font-semibold text-slate-700 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400',
          active && 'pl-1.5',
        )}>
          {[unit, description].filter(Boolean).join(', ') || '—'}
        </span>

        {/* 3. The money and the size, under a hairline. */}
        <span className={cn(
          'mt-2 flex items-center justify-between gap-2 border-t pt-1 text-xs',
          active ? 'border-brand-200 pl-1.5 dark:border-brand-800' : 'border-slate-100/60 dark:border-slate-800',
        )}>
          <span className="flex min-w-0 items-center gap-1.5">
            {price && (
              <span className={cn(
                'shrink-0 whitespace-nowrap font-extrabold tabular-nums',
                active ? 'text-brand-900 dark:text-brand-100' : 'text-slate-900 dark:text-slate-100',
              )}>
                {price}
              </span>
            )}
            {/* `text-muted` and not a slate step: this is 11px copy on white,
                and slate-400 there is 2.56:1 — the scan catches it, which is
                what the token exists for. */}
            {area && <span className="truncate text-[11px] font-normal text-muted">• {area}</span>}
          </span>
          {/*
            The stage keeps the corner it was given on 27 September 2026 —
            *"Replace the Star icon with Lead/Inventory Status"* — in the slot
            the prototype leaves open at the end of this row. Its colour is the
            admin's own, off the picklist option, never a hue written here.
          */}
          {stageLabel && (
            stageOption?.meta?.plainText === true ? (
              <span
                title={`${statusField?.label ?? 'Status'}: ${stageLabel}`}
                className="max-w-[7rem] shrink-0 truncate text-[11px] font-semibold text-slate-600 dark:text-slate-300"
              >
                {stageLabel}
              </span>
            ) : (
              <span
                style={badgeVars(stageOption?.color)}
                title={`${statusField?.label ?? 'Status'}: ${stageLabel}`}
                className={cn(
                  'max-w-[7rem] shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-bold',
                  stageOption?.color ? 'badge-solid' : 'bg-brand-700 text-white',
                )}
              >
                {stageLabel}
              </span>
            )
          )}
        </span>
      </button>

      {/*
        The tick box and the task chip sit over the card's top-right corner.
        The tick box only shows on hover or once ticked, so the card reads like
        the prototype until somebody reaches for a bulk action.
      */}
      <span className="absolute right-2.5 top-2.5 flex items-center gap-1">
        <input
          aria-label={`Select ${row.label}`}
          type="checkbox"
          checked={checked}
          onChange={(event) => onToggle(event.target.checked)}
          className={cn(
            'h-3.5 w-3.5 rounded border-slate-300 transition-opacity',
            checked ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100',
          )}
        />
        {due && <FollowUpBadge due={due} date={followUp} />}
      </span>
    </div>
  );
}

/**
 * The kind of record, as the prototype's notched flag.
 *
 * A clip-path rather than a rounded chip, which is what tells the two apart at
 * a glance down a queue: the stage chip at the other end of the card is round,
 * this one is a tag. The point is cut off the *left* edge, so the flag reads
 * as pinned to the name it follows.
 */
function TypeFlag({ label, strong }: { label: string; strong: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center py-0.5 pl-2.5 pr-1.5 text-[9px] uppercase tracking-wider text-sky-900',
        strong ? 'bg-blue-100 font-bold dark:bg-sky-900/70 dark:text-sky-100' : 'bg-sky-100 font-semibold dark:bg-sky-950 dark:text-sky-200',
      )}
      style={{ clipPath: 'polygon(6px 0%, 100% 0%, 100% 100%, 6px 100%, 0% 50%)' }}
    >
      {label}
    </span>
  );
}

/**
 * One block of the record's fields, editable where they stand.
 *
 * `surface` is deliberately the default — `record`, not `list`. The "editing
 * from a list" setting exists because turning a value into an edit box under
 * a cursor on a *list* is how a live mobile number gets changed by somebody
 * who only meant to read it. This pane is not that: you picked this record out
 * of the queue on purpose, and it is the record, shown beside the list rather
 * than on its own page. Gating it on that setting is what put an Edit button
 * here, which is the thing the owner asked to be rid of.
 */
function DeskTab({ active = false, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element { return <button onClick={onClick} className={cn('flex shrink-0 items-center gap-1 border-b-2 px-2 py-2 text-xs font-semibold transition-colors', active ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>{children}</button>; }
function displayOf(row: RecordEnvelope, field: FieldMeta): string { const display = row.display?.[field.name]; if (display) return display; const value = row.values[field.name]; return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value); }
