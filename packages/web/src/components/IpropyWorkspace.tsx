import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { recordStrength, type FieldMeta, type RecordEnvelope } from '@ipropy/shared';
import {
  ArrowRightLeft, ArrowUpDown, Check, ChevronLeft, ChevronRight, FileText, Filter, Link2,
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
import { FieldBlock, NotesPanel } from './RecordBlocks';
import { CallDeckPanel, useCallIsOn } from './CallDeckPanel';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import { cardArea, cardPrice, queueCardFields, unitDescription, type CardFields } from '../lib/queueCard';
import { invalidateRecordQueries } from '../lib/invalidate';
import { ModuleIcon } from './Layout';
import { Avatar, ConfirmDialog, Dropdown, DropdownItem, Modal, Spinner } from './ui';
import { ACTION_CIRCLE } from '../lib/actionCircle';
import { RecordAvatar } from './RecordAvatar';
import { HeroStatusChips } from './HeroStatusChips';
import { api } from '../lib/api';
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
  openId, sortBy, sortDir, neighbourContext, callQueueUrl, onSort, typePick, onTypePick,
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
  /**
   * The quick filter over the queue's own kind field — Contact Type.
   *
   * **27 September 2026, the owner:** *"A quick filter icon need in between
   * Lead/Inventory Record count and Sorting tab for Contact type, so that we
   * easy filter data from that icon."*
   *
   * The list owns it, not this pane: it has to reach the server with the rest
   * of the query, or the queue would filter what is on screen and the count
   * beside it would go on describing all 22,975. Which field it is is the
   * module's own first subtitle field — no screen names it.
   */
  typePick?: string[];
  onTypePick?: (values: string[]) => void;
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
  const { headerFields, queueFields, blocks, assignedField, statusField, followUpField, phoneField } = useRecordPanes(module);
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
    // Any module has neighbours — this is what Save & dial next walks, and
    // naming two modules here left a third one unable to move through its own
    // queue. The record's id is the only real condition.
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
  // Light the Call action while this record owns the permanent deck's live call.
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
          {/*
            The quick filter, between the count and the sorting menu, exactly
            where he asked for it. It is the queue's own kind field, and its
            values are that field's dropdown — never a list written here.
          */}
          {onTypePick && cardFields.type && (cardFields.type.options?.length ?? 0) > 0 && (
            <Dropdown
              /*
                Anchored to the button's *right* edge, so the panel grows back
                towards the left of the queue and stays inside it. Left-anchored
                it ran 46px past the pane (measured), which widens the pane's
                scrollable area — and an `overflow-hidden` box still scrolls
                when the browser reveals a focused item inside it, so tabbing
                through the options slid every row sideways.
              */
              align="right"
              trigger={(
                <button
                  type="button"
                  data-testid="queue-type-filter"
                  title={`Filter by ${cardFields.type.label}`}
                  aria-label={`Filter by ${cardFields.type.label}`}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold transition-colors',
                    typePick?.length
                      ? 'bg-brand-600 text-white'
                      : 'text-slate-500 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-brand-950',
                  )}
                >
                  <Filter className="h-3.5 w-3.5 shrink-0" />
                  {typePick?.length ? <span className="tabular-nums">{typePick.length}</span> : null}
                </button>
              )}
            >
              {() => (
                <div className="max-h-[20rem] overflow-y-auto py-1">
                  <QueueFilterRow
                    label={`Any ${cardFields.type!.label.toLowerCase()}`}
                    chosen={!typePick?.length}
                    onClick={() => onTypePick([])}
                  />
                  {(cardFields.type!.options ?? []).map((option) => {
                    const on = typePick?.includes(option.value) ?? false;
                    return (
                      <QueueFilterRow
                        key={option.value}
                        label={option.label || option.value}
                        chosen={on}
                        onClick={() => onTypePick(on
                          ? (typePick ?? []).filter((value) => value !== option.value)
                          : [...(typePick ?? []), option.value])}
                      />
                    );
                  })}
                </div>
              )}
            </Dropdown>
          )}
          {onSort && (
            <Dropdown
              align="right"
              trigger={(
                <button
                  type="button"
                  className="flex max-w-[10rem] shrink-0 items-center gap-1 text-[11px] font-medium text-slate-600 transition-colors hover:text-brand-700 dark:text-slate-300 dark:hover:text-brand-300"
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
        {/* Flush, because each row draws its own hairline — one separator
            between records, which is what the owner asked for. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((row) => (
            <QueueCard
              key={row.id}
              row={row}
              active={row.id === active?.id}
              checked={selected.has(row.id)}
              attention={attentionIds.has(row.id)}
              card={cardFields}
              queueFields={queueFields}
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
            {/*
              Who owns it, right beside where this record sits in the queue —
              *"Move Agent name after Page Number 1/100"*. Two facts about
              *where you are* rather than about the customer, so they read as
              one group and leave the whole right half to the name.
            */}
            {assignedField && (
              <span className="inline-flex min-w-0 shrink items-center gap-1.5 text-[11px]" title="Assigned to">
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

            {/*
              The name and the number, a size down — *"decrease Font size of
              Name and mobile number"*. Still the heading of the screen, and
              still the first thing read; it simply no longer sets how tall
              this row has to be.
            */}
            <span className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-hidden">
              <h2 className="min-w-0 truncate text-base font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
                {active.label}
              </h2>
              {phoneField && phoneValue && (
                <>
                  <span className="h-3.5 w-px shrink-0 bg-slate-300 dark:bg-slate-600" aria-hidden />
                  <span className="shrink-0 text-xs font-semibold text-slate-600 dark:text-slate-300">
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
          </div>

          {/*
            **29 September 2026:** the face starts this row; every record
            action sits at the right, and the three facts a call changes sit
            directly below those actions. This keeps the operational side of
            the header together and gives long translated labels room to wrap
            without pushing the avatar back into the middle.
          */}
          <div className="flex min-h-[5.5rem] w-full items-center gap-3 px-2" data-testid="split-hero-layout">
            <span className="shrink-0" data-testid="split-hero-avatar">
              <RecordAvatar
                module={module.name}
                recordId={active.id}
                name={active.label}
                percent={recordStrength(module.fields, active.values).percent}
                canEdit={canEdit}
                size={84}
              />
            </span>

            <div className="ml-auto flex min-w-0 flex-1 flex-col items-end gap-2" data-testid="split-hero-actions-status">
              {/* Right: everything you do to the record, in one group. */}
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              {/*
                Tags first — *"move tag from left top to beside of icons of
                whatsapp and call, The tag alignment should be Before whatsapp
                and call"*. They read as a label on the controls rather than
                as one more thing competing with the name.
              */}
              <TagChips module={module.name} tags={active.tags} className="hidden max-w-[6rem] shrink overflow-hidden lg:flex" />
              <TagButton
                module={module.name}
                recordId={active.id}
                tags={active.tags}
                canEdit={canEdit}
                className={cn(
                  ACTION_CIRCLE,
                  'hover:bg-brand-600',
                  active.tags?.length && 'border-brand-300 bg-brand-100 text-brand-800 dark:border-brand-700 dark:bg-brand-950 dark:text-brand-200',
                )}
              />
              {phoneValue && <WhatsAppButton to={phoneValue} iconOnly round />}
              {phoneValue && <CallButton to={phoneValue} iconOnly round active={onCall} />}
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
                    {canEdit && onDelete && (module.name === 'leads' || module.name === 'properties') && (
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

              {/* A hairline separates record actions from the three editable
                  call facts, while their common right edge keeps the group
                  easy to scan. */}
              <div className="flex w-full justify-end border-t border-slate-200/80 pt-2 dark:border-slate-700/80" data-testid="split-hero-status-row">
                <HeroStatusChips
                  module={module}
                  row={active}
                  canEdit={canEdit}
                  statusField={statusField}
                  followUpField={followUpField}
                  className="justify-end"
                />
              </div>
            </div>
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
          {(module.name === 'leads' || module.name === 'properties') && <DeskTab active={tab === 'matching'} onClick={() => setTab('matching')}><Link2 className="h-3.5 w-3.5" />Matching {module.name === 'leads' ? 'inventory' : 'leads'} {matchingCount ? <span className="rounded-full bg-slate-100 px-1 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{matchingCount}</span> : null}</DeskTab>}
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
          {tab === 'matching' && (module.name === 'leads' || module.name === 'properties') && <MatchingTab module={module.name} id={active.id} returnQuery="" recordLabel={active.label} />}
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
            is always present above notes: at rest it says no call is running,
            and it expands into the working controls during a call. Saving a
            call returns it to that ready state instead of hiding the deck.
          */}
          <CallDeckPanel module={module.name} recordId={active.id} />
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
        <div className="rounded-xl border border-brand-100 bg-brand-50 p-4 text-sm leading-6 text-slate-700 dark:border-brand-900 dark:bg-brand-950 dark:text-slate-200">
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
function QueueCard({ row, active, checked, attention, card, queueFields, onSelect, onToggle }: {
  row: RecordEnvelope;
  active: boolean;
  checked: boolean;
  attention: boolean;
  card: CardFields;
  queueFields?: FieldMeta[];
  onSelect: () => void;
  onToggle: (checked: boolean) => void;
}): JSX.Element {
  const read = (field: FieldMeta): string => displayOf(row, field);
  const type = card.type ? read(card.type) : '';
  const unit = card.unit ? read(card.unit) : '';
  const description = queueFields
    ? queueFields.map((field) => read(field)).filter((value) => value && value !== '—').join(', ')
    : unitDescription(card, read);
  const price = card.price ? cardPrice(row.values[card.price.name]) : '';
  const areaUnitField = card.area?.config.unitField;
  const area = card.area
    ? cardArea(row.values[card.area.name], typeof areaUnitField === 'string' ? row.values[areaUnitField] : undefined)
    : '';
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
    <div ref={self} data-testid="queue-card" className="group relative border-b border-[var(--border)]">
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'relative block w-full cursor-pointer px-3 py-2.5 text-left transition-colors',
          /*
            **27 September 2026, the owner:** *"Remove highlight box and shadow
            of box, We Need highlight whole box with only light colour for
            Selected record, When we Selected a record Then Font colour of Name
            and Price should be change as per theme."*

            So the open record is a light wash of the brand across the whole
            row and nothing else — no ring, no shadow, no bar down the edge,
            no border of its own. The rows are divided by one hairline each
            (the wrapper above), which is the separator he asked for; the card
            itself draws none.

            **Every colour here is a `brand-*` token**, which is the other half
            of that message: those resolve to CSS variables that Brand settings
            rewrites, so changing the theme moves this row with it. A hue
            written in as `indigo-50` would not have.
          */
          active
            ? 'bg-brand-50/45 dark:bg-brand-950/45'
            : 'hover:bg-[var(--surface-muted)] dark:hover:bg-slate-800',
        )}
      >
        {/*
          1. Who, and what kind of contact — the line a rep scans, so it is the
          heaviest thing on the card.
        */}
        <span className="flex min-w-0 items-center gap-1.5 pr-8">
          <span className={cn(
            'truncate text-[15px] font-extrabold tracking-tight',
            active ? 'text-brand-700 dark:text-brand-200' : 'text-slate-900 dark:text-slate-100',
          )}>
            {row.label}
          </span>
          {type && <TypeFlag label={type} strong={active} />}
          {attention && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Needs attention" />}
        </span>

        {/* 2. Which unit, cut short with "…" rather than wrapped. */}
        <span className={cn(
          'mt-1 block min-w-0 truncate text-xs',
          active ? 'font-semibold text-slate-700 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400',
        )}>
          {[unit, description].filter(Boolean).join(', ') || '—'}
        </span>

        {/*
          3. The money and the size. No rule above it — *"Remove Separator Line
          In between second and Third Row"* — because the line between one
          record and the next is the only one this queue needs.
        */}
        <span className="mt-1 flex items-center gap-2 text-sm">
          {price && (
            <span className={cn(
              'shrink-0 whitespace-nowrap text-base font-extrabold tabular-nums',
              active ? 'text-brand-700 dark:text-brand-200' : 'text-slate-900 dark:text-slate-100',
            )}>
              {price}
            </span>
          )}
          {/* `text-muted` and not a slate step: the token is the one that
              carries a contrast guarantee in both themes. */}
          {area && <span className="truncate text-xs font-medium text-muted">• {area}</span>}
        </span>
      </button>

      {/*
        The tick box, and nothing else, over the card's top-right corner.

        **The follow-up and stage chips were taken off on 27 September 2026**,
        on the owner's instruction — both facts are on the open record's own
        header, as chips, two inches away. A queue row that carries them as
        well is the same thing said twice in the one place a rep is scanning
        for a name.

        The box only shows on hover or once ticked, so the row reads as a name
        and a price until somebody reaches for a bulk action.
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
      </span>
    </div>
  );
}

/** One line of the queue's quick filter. Stays open — picking two is one visit. */
function QueueFilterRow({ label, chosen, onClick }: { label: string; chosen: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="queue-filter-row"
      onClick={onClick}
      aria-pressed={chosen}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        chosen
          ? 'bg-brand-50 font-bold text-brand-900 dark:bg-brand-950 dark:text-brand-100'
          : 'font-medium text-slate-700 hover:bg-[var(--surface-muted)] dark:text-slate-200',
      )}
    >
      <Check className={cn('h-3.5 w-3.5 shrink-0', chosen ? 'text-brand-600' : 'invisible')} />
      <span className="truncate">{label}</span>
    </button>
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
        /*
          Brand tints, not a fixed sky: *"The Theme colour Changed from Admin
          so please set all button/Chip/Text colour … accordingly."* These
          resolve to the CSS variables Brand settings rewrites.
        */
        'inline-flex shrink-0 items-center py-0.5 pl-2.5 pr-1.5 text-[10px] uppercase tracking-wider',
        strong
          ? 'bg-brand-200 font-bold text-brand-900 dark:bg-brand-800 dark:text-brand-50'
          : 'bg-brand-100 font-semibold text-brand-800 dark:bg-brand-950 dark:text-brand-200',
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
