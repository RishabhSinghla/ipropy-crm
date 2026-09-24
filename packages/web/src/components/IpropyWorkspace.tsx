import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { recordStrength, relativeTime, type FieldMeta, type ModuleMeta, type RecordEnvelope } from '@ipropy/shared';
import {
  ArrowRightLeft, ArrowUpDown, Check, FileText, Link2, MessageCircle, MoreHorizontal,
  Phone, Sparkles, Star, Trash2, Users,
} from 'lucide-react';
import { FieldValue } from './FieldRenderer';
import { CallButton, CallDispositionProvider, useCallDisposition } from './CallDisposition';
import { CallDeck } from './CallDeck';
import { WhatsAppComposerProvider } from './WhatsAppComposer';
import { MatchingTab } from './MatchingTab';
import { WhatsAppTab } from './WhatsAppTab';
import { WhatsAppButton } from './WhatsAppButton';
import { TagButton, TagChips } from './TagButton';
import { CallsTab, FilesTab, RecordCollaboratorsPanel, TimelineTab } from '../pages/RecordDetail';
import { EditableField, isInlineEditable } from './EditableField';
import { FieldBlock, HeaderFieldStrip, NotesPanel } from './RecordBlocks';
import { useRecordPanes, type DescribedModule } from '../lib/recordPanes';
import { invalidateRecordQueries } from '../lib/invalidate';
import { ModuleIcon } from './Layout';
import { Avatar, Badge, ConfirmDialog, Dropdown, DropdownItem, Modal, Spinner } from './ui';
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
  const { headerFields, blocks, subtitleFields, assignedField, statusField, followUpField, phoneField } = useRecordPanes(module);
  const phoneValue = active && phoneField ? displayOf(active, phoneField) : '';

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
    One provider around the whole view, keyed on the record that is open: the
    call dialog belongs to a record, and re-keying it is what stops an outcome
    being saved against whoever was on screen before.
  */
  return <CallDispositionProvider key={active?.id ?? 'none'} recordId={active?.id ?? ''} module={module.name}>
    <WhatsAppComposerProvider key={active?.id ?? 'none'} recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.map((row) => <QueueRow key={row.id} row={row} active={row.id === active?.id} checked={selected.has(row.id)} attention={attentionIds.has(row.id)} statusField={statusField} followUpField={followUpField} subtitleFields={subtitleFields} onSelect={() => setActiveId(row.id)} onToggle={(checked) => onToggleSelect(row.id, checked)} />)}
        </div>
      </aside>

      <SplitHandle label="Resize the list" onDrag={resize} />

      {active && <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
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
          <LiveCallDeck />

          <div className="flex min-w-0 items-start gap-3">
            <Avatar name={active.label} size={42} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              {/*
                One line here too. It used to wrap, so a long name pushed
                "Updated …" onto a second row and the header grew by a line for
                nothing — the opposite of the ask. The name gives way first
                (`truncate`) and everything beside it holds its width.
              */}
              <div className="flex min-w-0 items-center gap-x-3 whitespace-nowrap">
                <h2 className="min-w-0 truncate text-xl font-extrabold tracking-tight text-slate-950 dark:text-white">{active.label}</h2>
                {/* Between the name and when it was last touched, which is
                    where the owner asked for it. */}
                {assignedField && (
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-sm">
                    <span className="shrink-0 text-xs font-normal text-muted">{assignedField.label}:</span>
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
                <span className="shrink-0 text-sm text-slate-400">Updated {relativeTime(active.updatedAt)}</span>
              </div>

              {/* How complete the record is, under the name rather than
                  wrapped around the avatar. */}
              <StrengthBar module={module} row={active} className="mt-1 max-w-[11rem]" slim />

            </div>

            <span className="mt-1 flex shrink-0 items-center gap-2">
              {/* The record's tags, before the icons. They used to trail the
                  name after "Updated …", capped at two — the end of a line of
                  text is where a chip goes unread, and the owner asked for
                  them beside the icons in every view. */}
              <TagChips module={module.name} tags={active.tags} className="mr-0.5 max-w-[16rem]" />
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
            <DeskTab active={tab === 'matching'} onClick={() => setTab('matching')}><Link2 className="h-3.5 w-3.5" />Matching {module.name === 'leads' ? 'inventory' : 'leads'}</DeskTab>
            <DeskTab active={tab === 'files'} onClick={() => setTab('files')}><FileText className="h-3.5 w-3.5" />Files</DeskTab>
            <DeskTab active={tab === 'calls'} onClick={() => setTab('calls')}><Phone className="h-3.5 w-3.5" />Calls</DeskTab>
            <DeskTab active={tab === 'whatsapp'} onClick={() => setTab('whatsapp')}><MessageCircle className="h-3.5 w-3.5" />WhatsApp</DeskTab>
          </nav>
        </header>
        <div className="min-w-0 flex-1 bg-[#f7f9fc] p-4 sm:p-6 dark:bg-slate-950/50">
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
 * One record in the queue.
 *
 * Two lines and two chips, in the order a rep reads them: who this is with
 * when they are due, then the module's own facts with the status under that
 * date. No completeness bar — the owner asked for it off this side on
 * 19 September; it is a number about the *record*, and the queue is about the
 * people in it.
 *
 * No chevron either. It pointed at nothing: the record opens in the pane
 * already on screen, and the owner's word for it was "irritating".
 */
function QueueRow({ row, active, checked, attention, statusField, followUpField, subtitleFields, onSelect, onToggle }: { row: RecordEnvelope; active: boolean; checked: boolean; attention: boolean; statusField?: FieldMeta; followUpField?: FieldMeta; subtitleFields: FieldMeta[]; onSelect: () => void; onToggle: (checked: boolean) => void }): JSX.Element {
  const due = followUpField ? dueLabel(row.values[followUpField.name]) : null;
  /*
    A contact's Type then its Unit Number, joined by a hyphen — "Buyer — 304".
    Never the record id, which identifies a row to a database and nothing to a
    person. Empty values drop out rather than printing a stray dash.
  */
  const subtitle = subtitleFields.map((field) => displayOf(row, field)).filter(Boolean).join(' — ');
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex w-full items-start gap-2.5 border-b border-slate-100 px-3 py-2.5 text-left transition-colors dark:border-slate-800',
        active
          ? 'bg-brand-50 dark:bg-brand-950/50'
          : 'hover:bg-slate-50 dark:hover:bg-slate-800/70',
      )}
    >
      {/*
        The bar marking the open record is an element, not a border.

        It was `border-l-4 border-l-brand-600` on a row that also says
        `border-b border-slate-100`, and which of those two decides the left
        edge's colour is Tailwind's stylesheet order rather than the order they
        are written — so the marker could come out slate on slate and the row
        looked no different from its neighbours. Nothing competes with a span.
      */}
      {active && <span className="absolute inset-y-0 left-0 w-1 bg-brand-600" aria-hidden />}
      <input
        aria-label={`Select ${row.label}`}
        type="checkbox"
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onToggle(event.target.checked)}
        className="mt-1.5 h-4 w-4 shrink-0 rounded border-slate-300"
      />
      <span className="relative shrink-0">
        <Avatar name={row.label} size={36} />
        {attention && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-amber-500 dark:border-slate-900" title="Needs attention" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 truncate text-sm font-bold text-slate-900 dark:text-slate-100">
          <span className="truncate">{row.label}</span>
          {row.starred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" />}
        </span>
        <span className="mt-1 block truncate text-xs text-slate-500">{subtitle || '—'}</span>
      </span>
      {/*
        The date and the status in one column on the right, the status under
        the date and ending where it ends. Two chips on two different lines
        with two different right edges is the thing that makes a queue look
        ragged, and the owner asked for them lined up.
      */}
      <span className="flex shrink-0 flex-col items-end gap-1">
        {due
          ? <span className={cn('rounded px-1.5 py-0.5 text-2xs font-bold', due.tone)}>{due.label}</span>
          : <span className="px-1.5 py-0.5 text-2xs font-bold text-slate-300">—</span>}
        {statusField && <StatusPill field={statusField} row={row} />}
      </span>
    </button>
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
/**
 * The record's stage, as the CRM draws a stage everywhere else.
 *
 * `Badge` rather than a tint computed here: it fills the chip and `lib/color.ts`
 * guarantees the text clears WCAG AA against that fill in both themes. This
 * used to paint the admin's raw hex as text on a 12% wash of itself, which is
 * the pattern CLAUDE.md names — it lands around 2–3:1, and how readable it came
 * out depended entirely on which colour somebody had chosen.
 */
function StatusPill({ field, row }: { field: FieldMeta; row: RecordEnvelope }): JSX.Element {
  const value = String(row.values[field.name] ?? '');
  const color = field.options?.find((option) => option.value === value)?.color;
  // Never nothing: a row with no stage set has to look different from a row
  // whose stage simply did not load.
  const label = displayOf(row, field) || 'No status';
  return <Badge color={color} className="max-w-32 shrink-0 truncate text-2xs">{label}</Badge>;
}
function displayOf(row: RecordEnvelope, field: FieldMeta): string { const display = row.display?.[field.name]; if (display) return display; const value = row.values[field.name]; return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value); }
function dueLabel(value: unknown): { label: string; tone: string } | null { if (!value) return null; const date = new Date(String(value)); if (Number.isNaN(date.getTime())) return null; const today = new Date(); today.setHours(0, 0, 0, 0); date.setHours(0, 0, 0, 0); const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000); return diff < 0 ? { label: 'Overdue', tone: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' } : diff === 0 ? { label: 'Today', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' } : diff === 1 ? { label: 'Tomorrow', tone: 'bg-brand-100 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300' } : { label: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), tone: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }; }

/**
 * The deck, when a call is running, and nothing at all when one is not.
 *
 * A component of its own because `useCallDisposition` is a hook and this
 * renders inside a conditional — and because the record page draws the very
 * same thing, so there is one deck rather than two that drift.
 */
function LiveCallDeck(): JSX.Element | null {
  const calls = useCallDisposition();
  if (!calls?.deck) return null;
  /*
    **It floats, and that is the fix rather than the shortcut.** Sitting in the
    header's own row, the deck appearing pushed the name, the assignment and
    every action circle sideways the instant Call was pressed, and pulled them
    back when the call ended — the bounce the owner reported. Taken out of the
    flow it changes no other element's position at all, and it lands in the
    top-right corner he drew it in.
  */
  return (
    <div className="absolute right-3 top-2 z-30">
      <CallDeck {...calls.deck} />
    </div>
  );
}
