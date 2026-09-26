import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, recordStrength, relativeTime, type FieldMeta, type ModuleMeta, type RecordEnvelope } from '@ipropy/shared';
import {
  AlarmClock, ArrowRightLeft, ArrowUpDown, Building2, CalendarClock, Check, CircleCheck, CircleEllipsis, FileText, Link2,
  MessageCircle, MoreHorizontal, Phone, PhoneCall, Sparkles, Star, Trash2, TriangleAlert, Users,
} from 'lucide-react';
import { FieldValue } from './FieldRenderer';
import { CALL_DECK_DOCK_ID } from './LiveCallDeck';
import { CallButton, CallDispositionProvider } from './CallDisposition';
import { WhatsAppComposerProvider } from './WhatsAppComposer';
import { MatchingTab } from './MatchingTab';
import { WhatsAppTab } from './WhatsAppTab';
import { WhatsAppButton } from './WhatsAppButton';
import { TagButton, TagChips } from './TagButton';
import { CallsTab, FilesTab, RecordCollaboratorsPanel, TimelineTab } from '../pages/RecordDetail';
import { EditableField, isInlineEditable } from './EditableField';
import { FieldBlock, HeaderFieldStrip, NotesPanel } from './RecordBlocks';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import { cardArea, cardPrice, queueCardFields, unitDescription, type CardFields } from '../lib/queueCard';
import { followUpChip, type FollowUpChip as FollowUpChipValue, type FollowUpTone } from '../lib/followUpDates';
import { invalidateRecordQueries } from '../lib/invalidate';
import { ModuleIcon } from './Layout';
import { Avatar, ConfirmDialog, Dropdown, DropdownItem, Modal, Spinner } from './ui';
import { ACTION_BASE, ACTION_CIRCLE, ACTION_REST } from '../lib/actionCircle';
import { api } from '../lib/api';
import { cn, restrictionForField } from '../lib/utils';
import { toast } from '../lib/store';

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
function SplitHandle({ label, onDrag }: { label: string; onDrag: (deltaX: number) => void }): JSX.Element {
  const from = useRef(0);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
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


/** One choice in the queue's sorting menu: a column to order by, and which way. */
interface SortChoice {
  key: string;
  label: string;
  /** Absent on the first choice, which is the list's own default order. */
  sort?: { by: string; dir: 'asc' | 'desc' };
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
  openId, sortBy, sortDir, onSort,
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
  onSort?: (by: string | undefined, dir: 'asc' | 'desc') => void;
}): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(openId ?? rows[0]?.id ?? null);
  const [tab, setTab] = useState<DeskTabKey>('overview');
  const [queueWidth, setQueueWidth] = useState(() => loadSplit(360));
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
    sight — the cue to go and shorten the list in Admin → Split View. That
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

  const resize = useCallback((delta: number) => {
    const [min, max] = QUEUE_LIMITS;
    setQueueWidth((current) => {
      const next = Math.min(max, Math.max(min, current + delta));
      try { localStorage.setItem(`${SPLIT_KEY}.queue`, String(Math.round(next))); } catch { /* see loadSplit */ }
      return next;
    });
  }, []);

  /*
    Which fields this module's panes show — the admin's Split View
    arrangement, then the Layout Designer's, then the module's own flags.

    One hook, because the WhatsApp Chats screen shows the same record beside a
    conversation and must reach the same answer. A second copy of this
    reasoning is the mistake this repo keeps finding months later.
  */
  const { headerFields, blocks, subtitleFields, queueChosen, assignedField, statusField, followUpField, phoneField } = useRecordPanes(module);
  const callDispositionField = useMemo(
    () => module.fields.find((field) => field.name === 'call_disposition' || field.columnName === 'call_disposition'),
    [module.fields],
  );
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
    What the queue's one menu can do. Ordering and the follow-up windows are
    two different questions and they stay two sections, but they are one
    control: "sort this queue" is a single thought to a rep working it.
  */
  const sortChoices = useMemo<SortChoice[]>(() => {
    const out: SortChoice[] = [{ key: 'recent', label: 'Recently updated' }];
    const nameField = module.labelFields.map((name) => module.fields.find((f) => f.name === name)).find(Boolean);
    if (nameField) out.push({ key: 'name', label: `${nameField.label} A–Z`, sort: { by: nameField.name, dir: 'asc' } });
    for (const field of subtitleFields) out.push({ key: `subtitle:${field.name}`, label: `${field.label} A–Z`, sort: { by: field.name, dir: 'asc' } });
    if (statusField) out.push({ key: 'status', label: `${statusField.label} A–Z`, sort: { by: statusField.name, dir: 'asc' } });
    if (followUpField) out.push({ key: 'task', label: 'Task, soonest first', sort: { by: followUpField.name, dir: 'asc' } });
    return out;
  }, [module.labelFields, module.fields, subtitleFields, statusField, followUpField]);

  const activeSort = sortChoices.find((choice) => choice.sort && choice.sort.by === sortBy) ?? sortChoices[0]!;

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
  const allChecked = rows.length > 0 && rows.every((row) => selected.has(row.id));

  /*
    One provider around the whole view, **not keyed on the open record**.
    Keyed, every click in the list rebuilt the entire split view — list
    included — so the list jumped back to the top and the record just clicked
    scrolled out of sight (26 September 2026, the owner). A call belongs to the
    record it was started from through `useLiveCall` now, and the WhatsApp
    composer closes itself when the record changes, so neither needs the key.
  */
  return <CallDispositionProvider recordId={active?.id ?? ''} module={module.name}>
    <WhatsAppComposerProvider recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
    <section data-testid="ipropy-workspace" className="bg-[#f7f9fc] dark:bg-slate-950">
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
      className="flex min-h-[calc(100vh-13rem)] flex-col xl:h-[var(--pane-h)] xl:min-h-0 xl:flex-row"
      style={{
        ['--queue-w' as string]: `${queueWidth}px`,
        ['--pane-h' as string]: paneTop ? `calc(100vh - ${paneTop}px)` : 'calc(100vh - 13rem)',
      }}
    >
      <aside className="flex w-full shrink-0 flex-col border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 xl:w-[var(--queue-w)] xl:border-b-0">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-200 px-3 dark:border-slate-800">
          {/* Beside the module's own name, because that is what it selects:
              everything on this page, for the bulk-edit bar the list already
              carries. */}
          {onToggleAll && (
            <input
              type="checkbox"
              aria-label={`Select all ${module.label.toLowerCase()} shown`}
              checked={allChecked}
              onChange={(event) => onToggleAll(event.target.checked)}
              className="h-4 w-4 shrink-0 rounded border-slate-300"
            />
          )}
          <p className="flex min-w-0 items-center gap-1.5 truncate text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            <ModuleIcon name={module.icon} className="h-4 w-4 shrink-0 text-brand-600" />{module.label}
          </p>
          <span className="shrink-0 text-2xs font-semibold text-slate-400">{rows.length}</span>
          {onSort && (
            <div className="ml-auto shrink-0">
              <Dropdown
                align="right"
                trigger={(
                  <button
                    type="button"
                    className="inline-flex max-w-[11rem] items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-2xs font-semibold text-slate-600 hover:border-brand-300 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300"
                    aria-label="Sort this list"
                  >
                    <ArrowUpDown className="h-3 w-3 shrink-0" />
                    <span className="truncate">{activeSort.label}</span>
                  </button>
                )}
              >
                {(close) => (
                  <div className="py-1">
                    <p className="px-3 pb-1 pt-1.5 text-2xs font-bold uppercase tracking-wide text-slate-400">Sort by</p>
                    {sortChoices.map((choice) => (
                      <DropdownItem
                        key={choice.key}
                        icon={<Check className={cn('h-3.5 w-3.5', activeSort.key === choice.key ? 'text-brand-600' : 'invisible')} />}
                        onClick={() => { onSort(choice.sort?.by, choice.sort?.dir ?? 'desc'); close(); }}
                      >
                        {choice.label}
                      </DropdownItem>
                    ))}
                  </div>
                )}
              </Dropdown>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-white dark:bg-slate-950">
          {rows.map((row) => (
            <QueueCard
              key={row.id}
              row={row}
              active={row.id === active?.id}
              checked={selected.has(row.id)}
              attention={attentionIds.has(row.id)}
              card={cardFields}
              followUpField={followUpField ?? cardFields.followUp}
              adminLine={queueChosen ? subtitleFields : null}
              onSelect={() => setActiveId(row.id)}
              onToggle={(checked) => onToggleSelect(row.id, checked)}
              onStar={() => star.mutate(row)}
            />
          ))}
        </div>
      </aside>

      <SplitHandle label="Resize the list" onDrag={resize} />

      {/*
        **One scroll area, never two stacked.** The WhatsApp tab has its own
        scrolling message list; with this pane scrolling too, the wheel went to
        whichever happened to be under the mouse, so the chat scrolled only when
        the pointer sat over the bubbles and the whole pane lurched everywhere
        else — 25 September 2026, the owner: *"only bringing mouse to a certain
        place scroll is working."* On that tab the pane holds still and the list
        does all the scrolling.
      */}
      {active && <main className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col',
        tab === 'whatsapp' ? 'overflow-hidden' : 'overflow-y-auto',
      )}>
        {/* Sticky, so the name, the assignment and the tabs stay on screen
            while the fields below them scroll. */}
        <header className="relative sticky top-0 z-10 border-b border-slate-200 bg-white px-4 pt-2 dark:border-slate-800 dark:bg-slate-900 sm:px-5">
          {/*
            The actions live on the name's own line, at the end of it.

            They had a row of their own above the name, which is what the
            owner's words asked for and not what his screenshot showed — and
            when he saw it he sent the screenshot back: *"Move icons ... with
            an alignment of Full Name ... should be same as per screenshot"*.
            So they are on that line now, and the screenshot decides the rest:
            plain light circles, one weight of grey, no colour per button. The
            colours made four ordinary controls look like four warnings.
          */}
          {/*
            The live call, floating in the header's top-right corner — where
            the owner drew it, and out of the layout so nothing moves when it
            appears.
          */}
          <CallDeckDock />

          <div className="flex min-w-0 items-start gap-3">
            <Avatar name={active.label} size={42} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              {/*
                One line here too. It used to wrap, so a long name pushed
                "Updated …" onto a second row and the header grew by a line for
                nothing — the opposite of the ask. The name gives way first
                (`truncate`) and everything beside it holds its width.
              */}
              <div className="flex min-w-0 items-center gap-x-2 whitespace-nowrap">
                <h2 className="min-w-0 truncate text-xl font-extrabold tracking-tight text-slate-950 dark:text-white">{active.label}</h2>
                {assignedField && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:bg-violet-950/40 dark:text-violet-200" title="Agent">
                    <Users className="h-3 w-3" aria-hidden />
                    {canEdit && isInlineEditable(assignedField) ? (
                      <EditableField
                        module={module.name}
                        recordId={active.id}
                        field={assignedField}
                        value={active.values[assignedField.name]}
                        display={active.display?.[assignedField.name]}
                        compact
                        siblings={active.values}
                        restrictTo={restrictionForField(module.picklistDependencies, active.values, assignedField.name)}
                        onSaved={() => invalidateRecordQueries(queryClient, module.name, active.id)}
                      />
                    ) : (
                      <FieldValue field={assignedField} value={active.values[assignedField.name]} display={active.display?.[assignedField.name]} compact />
                    )}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs">
                <span className="text-slate-400">Updated {relativeTime(active.updatedAt)}</span>
                <span className="text-slate-300">•</span>
                <span
                  className="font-semibold text-blue-600 dark:text-blue-300"
                  role="img"
                  aria-label={`Record ${recordStrength(module.fields, active.values).percent}% complete`}
                >
                  {recordStrength(module.fields, active.values).percent}% Profile Complete
                </span>
              </div>

            </div>

            <span className="mt-1 flex shrink-0 items-center gap-2">
              {/* The record's tags, before the icons. They used to trail the
                  name after "Updated …", capped at two — the end of a line of
                  text is where a chip goes unread, and the owner asked for
                  them beside the icons in every view. */}
              <TagChips module={module.name} tags={active.tags} className="mr-0.5 max-w-[11rem]" />
              {statusField && displayOf(active, statusField) && (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-700 px-3 py-2 text-xs font-bold text-white shadow-sm">
                  <CircleCheck className="h-3.5 w-3.5" />{displayOf(active, statusField)}
                </span>
              )}
              {callDispositionField && displayOf(active, callDispositionField) && (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-bold text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
                  <PhoneCall className="h-3.5 w-3.5" />{displayOf(active, callDispositionField)}
                </span>
              )}
              {/*
                The line the owner asked for twice: everything to its left is
                the record, everything to its right is what you *do* with it —
                the controls and, under them, the call. One hairline, because a
                heavier rule in a header this tight reads as a border somebody
                forgot to remove.
              */}
              <span className="mx-1.5 h-8 w-px shrink-0 rounded bg-slate-300 dark:bg-slate-600" aria-hidden />
              <button
                aria-label={active.starred ? 'Remove from starred' : 'Star this record'}
                title={active.starred ? 'Remove from starred' : 'Star this record'}
                onClick={() => star.mutate(active)}
                className={cn(
                  ACTION_BASE,
                  'hover:bg-amber-500',
                  active.starred ? 'border-transparent bg-amber-500 text-white' : ACTION_REST,
                )}
              >
                <Star className={cn('h-4 w-4', active.starred && 'fill-white')} />
              </button>
              {phoneValue && <WhatsAppButton to={phoneValue} iconOnly round />}
              {phoneValue && <CallButton to={phoneValue} iconOnly round />}
              {/* Tagging, the same dialog the record page opens. */}
              <TagButton
                module={module.name}
                recordId={active.id}
                tags={active.tags}
                canEdit={canEdit}
                className={cn(ACTION_CIRCLE, 'hover:bg-brand-600')}
              />
              {/*
                No delete circle. Delete is in the menu beside it, and one
                destructive action offered twice, a thumb's width from Call, is
                one more chance to hit it by accident than it is worth.
              */}

              {/*
                The record page's own menu, here. The owner asked for it by
                name: the three dots he gets on a record and did not get here.
                Same four actions, done against whatever the queue has open,
                without leaving the split view for a page.
              */}
              <Dropdown
                align="right"
                className="min-w-[15rem]"
                trigger={(
                  <button className={cn(ACTION_CIRCLE, 'hover:bg-slate-600')} aria-label="More actions" title="More actions">
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
                      <DropdownItem
                        icon={<Users className="h-3.5 w-3.5" />}
                        onClick={() => { setSharingWithTeam(true); close(); }}
                      >
                        Share with team
                      </DropdownItem>
                    )}
                    {canEdit && onDelete && (
                      <DropdownItem
                        icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
                        onClick={() => {
                          close();
                          setMoveTarget(module.name === 'leads' ? 'properties' : 'leads');
                        }}
                      >
                        Move to {module.name === 'leads' ? 'Inventories' : 'Leads'}
                      </DropdownItem>
                    )}
                    {onDelete && (
                      <DropdownItem
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        danger
                        onClick={() => { close(); onDelete(active); }}
                      >
                        Delete record
                      </DropdownItem>
                    )}
                  </>
                )}
              </Dropdown>
            </span>
          </div>

            {/*
              Every header value the record page carries, each one typed in
              where it stands. The owner's instruction: "Full of the header
              things phone number, next follow-up all other things be in
              line editable." The same strip the WhatsApp chat header shows.
            */}
            <HeaderFieldStrip module={module} row={active} fields={headerFields} canEdit={canEdit} className="mt-2" />

          <nav className="mt-1.5 flex max-w-full overflow-x-auto" aria-label="Record workspace sections">
            <DeskTab active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</DeskTab>
            <DeskTab active={tab === 'timeline'} onClick={() => setTab('timeline')}>Timeline</DeskTab>
            <DeskTab active={tab === 'matching'} onClick={() => setTab('matching')}><Link2 className="h-3.5 w-3.5" />Matching {module.name === 'leads' ? 'inventory' : 'leads'} {matchingCount ? <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-2xs font-bold text-violet-700">{matchingCount}</span> : null}</DeskTab>
            <DeskTab active={tab === 'files'} onClick={() => setTab('files')}><FileText className="h-3.5 w-3.5" />Files</DeskTab>
            <DeskTab active={tab === 'calls'} onClick={() => setTab('calls')}><Phone className="h-3.5 w-3.5" />Calls</DeskTab>
            <DeskTab active={tab === 'whatsapp'} onClick={() => setTab('whatsapp')}><MessageCircle className="h-3.5 w-3.5" />WhatsApp</DeskTab>
          </nav>
        </header>
        <div className={cn(
          'min-w-0 flex-1 bg-[#f7f9fc] dark:bg-slate-950/50',
          tab === 'whatsapp' ? 'flex min-h-0 flex-col' : 'p-4 sm:p-6',
        )}>
          {/*
            Notes beside Basic Information rather than in a third column. Two
            panes, as the owner asked — and a note is written about what is on
            screen, so it belongs next to it.
          */}
          {tab === 'overview' && (
            <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem] 2xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="min-w-0 space-y-4">
                {blocks.map((block) => (
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
              </div>
              <NotesPanel module={module.name} record={active} />
            </div>
          )}
          {tab === 'timeline' && <TimelineTab module={module.name} id={active.id} />}
          {tab === 'matching' && <MatchingTab module={module.name} id={active.id} returnQuery="" recordLabel={active.label} />}
          {tab === 'files' && <FilesTab module={module.name} id={active.id} canEdit={canEdit} />}
          {tab === 'calls' && <CallsTab recordId={active.id} />}
          {tab === 'whatsapp' && <WhatsAppTab module={module.name} recordId={active.id} mobile={phoneValue || null} />}
        </div>
      </main>}
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
 *   Name  [TYPE]                                              ☆
 *   🏢 H. No: A-2701 • Single, 4 BHK Builder Floor, Greenfields Colony
 *   ₹1.85 Cr  2,100 sq.ft                                 [TODAY]
 *
 * The open record carries a plum bar down its left edge and a lifted shadow,
 * so which one is open reads at a glance. The middle line is cut short with
 * "…" rather than wrapping, so every card is the same height.
 *
 * When Admin → Split View has chosen the line under the name, that choice
 * replaces the middle line: an admin's arrangement outranks this default.
 *
 * The card, its star and its tick box are three separate buttons laid over one
 * another rather than one button holding two more. A button inside a button
 * is not allowed in HTML, and a screen reader cannot reach the inner one.
 */
function QueueCard({ row, active, checked, attention, card, followUpField, adminLine, onSelect, onToggle, onStar }: {
  row: RecordEnvelope;
  active: boolean;
  checked: boolean;
  attention: boolean;
  card: CardFields;
  followUpField?: FieldMeta;
  /** Admin → Split View's chosen line, when there is one. */
  adminLine: FieldMeta[] | null;
  onSelect: () => void;
  onToggle: (checked: boolean) => void;
  onStar: () => void;
}): JSX.Element {
  const read = (field: FieldMeta): string => displayOf(row, field);
  const type = card.type ? read(card.type) : '';
  const unit = card.unit ? read(card.unit) : '';
  const description = unitDescription(card, read);
  // Contact type is already the compact chip beside the name. Repeating it in
  // the detail line wastes the one piece of queue real estate a rep scans.
  const adminText = adminLine?.filter((field) => field.name !== card.type?.name).map(read).filter(Boolean).join(' — ') ?? '';
  const price = card.price ? cardPrice(row.values[card.price.name]) : '';
  const areaUnitField = card.area?.config.unitField;
  const area = card.area
    ? cardArea(row.values[card.area.name], typeof areaUnitField === 'string' ? row.values[areaUnitField] : undefined)
    : '';
  const followUp = followUpField ? row.values[followUpField.name] : null;
  const due = followUpChip(followUp);

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
          'relative block w-full overflow-hidden border-b-2 border-slate-200 bg-white py-2.5 pl-4 pr-3 text-left transition-colors dark:border-slate-800 dark:bg-slate-900',
          active
            ? 'bg-violet-50/80 shadow-[inset_4px_0_0_#7c3aed] dark:bg-violet-950/30'
            : 'hover:bg-violet-50/50 dark:hover:bg-slate-800',
        )}
      >
        {active && <span className="absolute inset-y-0 left-0 w-1 bg-brand-600 dark:bg-brand-400" aria-hidden />}

        {/* 1. Who, and what kind of contact. Room kept on the right for the star. */}
        <span className="flex min-w-0 items-center gap-2 pr-12">
          <span className={cn(
            'truncate text-base font-bold',
            active ? 'text-brand-600 dark:text-brand-300' : 'text-[var(--text)] dark:text-slate-100',
          )}>
            {row.label}
          </span>
          {type && (
            <span className="shrink-0 rounded bg-brand-100 px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide text-brand-700 dark:bg-brand-950/50 dark:text-brand-200">
              {type}
            </span>
          )}
          {attention && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" title="Needs attention" />}
        </span>

        {/* 2. Which unit, cut short with "…" rather than wrapped. */}
        <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-sm text-[#475569] dark:text-slate-400">
          <Building2 className="h-4 w-4 shrink-0 text-[#4338ca] dark:text-indigo-300" aria-hidden />
          {adminLine ? (
            <span className="truncate">{adminText || '—'}</span>
          ) : (
            <span className="truncate">
              {unit && <span className="font-semibold text-[#0f172a] dark:text-slate-100">H. No: {unit}</span>}
              {unit && description && ' • '}
              {description}
              {!unit && !description && '—'}
            </span>
          )}
        </span>

        {/* 3. The money, the size, and when they are due. */}
        {(price || area || due) && <span className="mt-2 flex items-center gap-2">
          {price && <span className="shrink-0 whitespace-nowrap text-lg font-extrabold tabular-nums text-[#3730a3] dark:text-indigo-300">{price}</span>}
          {area && <span className="min-w-0 truncate whitespace-nowrap text-xs text-[#64748b] dark:text-slate-400">{area}</span>}
          <span className="ml-auto shrink-0">
            {due && <FollowUpBadge due={due} date={followUp} />}
          </span>
        </span>}
      </button>

      {/*
        The star and the tick box sit over the card's top-right corner. The tick
        box only shows on hover or once ticked, so the card reads like the
        mock-up until somebody reaches for a bulk action.
      */}
      <span className="absolute right-2.5 top-2.5 flex items-center gap-1">
        <input
          aria-label={`Select ${row.label}`}
          type="checkbox"
          checked={checked}
          onChange={(event) => onToggle(event.target.checked)}
          className={cn(
            'h-4 w-4 rounded border-slate-300 transition-opacity',
            checked ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100',
          )}
        />
        <button
          type="button"
          onClick={onStar}
          aria-pressed={Boolean(row.starred)}
          aria-label={row.starred ? `Remove ${row.label} from favourites` : `Add ${row.label} to favourites`}
          title={row.starred ? 'Remove from favourites' : 'Add to favourites'}
          className="rounded p-1 text-slate-400 hover:text-brand-600 dark:hover:text-brand-300"
        >
          <Star className={cn('h-5 w-5', row.starred && 'fill-brand-600 text-brand-600 dark:fill-brand-300 dark:text-brand-300')} />
        </button>
      </span>
    </div>
  );
}

/*
  The owner's colours for the task chip, one per state. Each text colour
  clears WCAG AA against its tint; Pending uses the darker of his two slates,
  because #64748b on #f1f5f9 falls just short.
*/
const FOLLOW_UP_STYLE: Record<FollowUpTone, { className: string; icon: typeof AlarmClock }> = {
  today: { className: 'bg-[#fffbeb] text-[#b45309] dark:bg-amber-950/50 dark:text-amber-300', icon: AlarmClock },
  tomorrow: { className: 'bg-[#eff6ff] text-[#1d4ed8] dark:bg-blue-950/50 dark:text-blue-300', icon: CalendarClock },
  overdue: { className: 'bg-[#fef2f2] text-[#b91c1c] dark:bg-red-950/50 dark:text-red-300', icon: TriangleAlert },
  pending: { className: 'bg-[#f1f5f9] text-[#475569] dark:bg-slate-800 dark:text-slate-300', icon: CircleEllipsis },
};

function FollowUpBadge({ due, date }: { due: FollowUpChipValue; date: unknown }): JSX.Element {
  const style = FOLLOW_UP_STYLE[due.tone];
  const Icon = style.icon;
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded px-2 py-1 text-2xs font-bold uppercase tracking-wide', style.className)}
      title={date ? `Follow-up ${formatDate(String(date))}` : undefined}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {due.label}
    </span>
  );
}

/**
 * How complete a record is, as a straight line with the number beside it.
 *
 * It used to be a ring around the avatar. The owner asked for the two to be
 * separated — the face identifies the person, the bar answers a different
 * question — and a bar reads as a proportion at a glance where a ring has to
 * be decoded.
 */
function StrengthBar({ module, row, className, slim = false }: { module: ModuleMeta; row: RecordEnvelope; className?: string; slim?: boolean }): JSX.Element {
  const percent = recordStrength(module.fields, row.values).percent;
  const color = percent >= 80 ? '#14b86a' : percent >= 55 ? '#f59e0b' : '#ee3458';
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <span
        className={cn('min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700', slim ? 'h-1' : 'h-1.5')}
        role="img"
        aria-label={`Record ${percent}% complete`}
      >
        <span className="block h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: color }} />
      </span>
      <span className="shrink-0 text-2xs font-bold tabular-nums text-slate-500 dark:text-slate-400">{percent}%</span>
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
function DeskTab({ active = false, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element { return <button onClick={onClick} className={cn('flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition-colors', active ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>{children}</button>; }
function displayOf(row: RecordEnvelope, field: FieldMeta): string { const display = row.display?.[field.name]; if (display) return display; const value = row.values[field.name]; return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value); }

/** Where the call deck docks when this record's header is on screen. */
function CallDeckDock(): JSX.Element {
  /*
    Only the spot the deck docks in when this record's header is on screen.
    The deck itself is drawn once by the app's shell (`components/LiveCallDeck`)
    so it survives leaving this page mid-call; it sits over this placeholder
    until somebody drags it elsewhere.
  */
  return <div id={CALL_DECK_DOCK_ID} aria-hidden="true" className="pointer-events-none absolute right-3 top-12 h-px w-[23rem]" />;
}
