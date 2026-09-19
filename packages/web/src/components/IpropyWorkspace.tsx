import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { recordStrength, relativeTime, type FieldMeta, type ModuleMeta, type RecordEnvelope, type TimelineEntry } from '@ipropy/shared';
import {
  ArrowRightLeft, ArrowUpDown, Check, FileText, Link2, MessageCircle, MoreHorizontal,
  Phone, Send, Sparkles, Star, Tag, Trash2, Users,
} from 'lucide-react';
import { FieldValue } from './FieldRenderer';
import { CallButton, CallDispositionProvider } from './CallDisposition';
import { WhatsAppComposerProvider } from './WhatsAppComposer';
import { MatchingTab } from './MatchingTab';
import { WhatsAppTab } from './WhatsAppTab';
import { WhatsAppButton } from './WhatsAppButton';
import { CallsTab, FilesTab, RecordCollaboratorsPanel, TimelineTab } from '../pages/RecordDetail';
import { EditableField, isInlineEditable } from './EditableField';
import { invalidateRecordQueries } from '../lib/invalidate';
import { assignmentField, subtitleFieldsOf } from '../lib/fields';
import { ModuleIcon } from './Layout';
import { Avatar, ConfirmDialog, Dropdown, DropdownItem, Modal, Spinner } from './ui';
import { api } from '../lib/api';
import { cn, restrictionForField } from '../lib/utils';
import { toast } from '../lib/store';

type DeskTabKey = 'overview' | 'timeline' | 'matching' | 'files' | 'calls' | 'whatsapp';

/**
 * The module as the list itself has it: fields, the layout an admin arranged,
 * and the two things writing needs — what this profile may do, and which
 * picklist narrows which.
 */
type DescribedModule = ModuleMeta & {
  permissions: { view: boolean; create: boolean; edit: boolean; delete: boolean };
  picklistDependencies: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[];
  layouts?: { id: string; name: string; type: string; is_default: boolean; config: unknown }[];
};

/** What the Layout Designer arranged, read the same way the record page reads it. */
interface DetailLayout {
  blocks?: { key: string; label: string; columns: number; collapsed?: boolean; fields: string[] }[];
  headerFields?: string[];
}

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

/**
 * The record header's action buttons.
 *
 * One neutral circle for all of them, from the owner's screenshot. Each
 * button used to carry the colour of the thing it opened — amber, green,
 * blue, red — and four tinted circles in a row read as four warnings rather
 * than as four ordinary controls.
 */
const ACTION_CIRCLE = 'inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';

/** One choice in the queue's sorting menu: a column to order by, and which way. */
/**
 * Header fields the owner asked to read in Basic Information instead.
 *
 * 19 September 2026: "Lost Reason, Contact Type, Unit Number be removed from
 * the header of the split pane on the right side and be moved in the basic
 * information below where they can be inline editable."
 *
 * By field name and not by label, because a label is something an admin
 * renames on a Tuesday and a name is the key everything else in this CRM uses.
 * Contact Type and Unit Number are not listed here — they are whatever an
 * admin flagged as the queue's subtitle, so they are found through that flag
 * rather than named twice.
 */
const DEMOTED_FROM_HEADER = new Set(['lost_reason']);

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
  sortBy, sortDir, onSort,
}: {
  module: DescribedModule; rows: RecordEnvelope[];
  selected: Set<string>; attentionIds: Set<string>; onToggleSelect: (id: string, checked: boolean) => void;
  /** Tick every row on this page, for the bulk-edit bar the list already has. */
  onToggleAll?: (checked: boolean) => void;
  /** Absent when this profile may not delete — the button is not offered at all. */
  onDelete?: (row: RecordEnvelope) => void;
  /** The list's own ordering, so the queue's menu drives the same query the table does. */
  sortBy?: string; sortDir?: 'asc' | 'desc';
  onSort?: (by: string | undefined, dir: 'asc' | 'desc') => void;
}): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(rows[0]?.id ?? null);
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
    onSuccess: () => invalidateRecordQueries(queryClient, module.name),
    onError: (error: Error) => toast.error('Could not change that', error.message),
  });
  useEffect(() => setActiveId((current) => rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? null)), [rows]);

  const listRow = rows.find((row) => row.id === activeId) ?? rows[0] ?? null;

  const { data: fetched } = useQuery({
    queryKey: ['record', module.name, listRow?.id],
    queryFn: () => api.record(module.name, listRow!.id),
    enabled: Boolean(listRow?.id),
  });
  // The row stands in while the record loads, so the pane never blanks between
  // two selections. Its values are right, there are simply fewer of them.
  const active = fetched && fetched.id === listRow?.id ? fetched : listRow;

  const resize = useCallback((delta: number) => {
    const [min, max] = QUEUE_LIMITS;
    setQueueWidth((current) => {
      const next = Math.min(max, Math.max(min, current + delta));
      try { localStorage.setItem(`${SPLIT_KEY}.queue`, String(Math.round(next))); } catch { /* see loadSplit */ }
      return next;
    });
  }, []);

  const layout = useMemo<DetailLayout>(
    () => (module.layouts?.find((l) => l.type === 'detail' && l.is_default)?.config ?? {}) as DetailLayout,
    [module.layouts],
  );
  const fieldMap = useMemo(() => new Map(module.fields.map((field) => [field.name, field])), [module.fields]);
  const assignedField = useMemo(() => assignmentField(module.fields), [module.fields]);
  /*
    Whatever an admin flagged with `config.listSubtitle`, in the order the flag
    gives: a contact reads `Buyer — 304`, a unit reads its Unit Number. Named
    by metadata rather than in this file, like every other field here.
  */
  const subtitleFields = useMemo(() => subtitleFieldsOf(module.fields), [module.fields]);
  const statusField = useMemo(() => module.fields.find((f) => f.name === module.pipelineField) ?? module.fields.find((f) => /status|stage/i.test(f.name)), [module.fields, module.pipelineField]);
  const followUpField = useMemo(() => module.fields.find((f) => f.columnName === 'next_followup_at') ?? module.fields.find((f) => /next.*follow.*up/i.test(f.name)), [module.fields]);
  const phoneField = useMemo(() => module.fields.find((f) => f.uitype === 'phone'), [module.fields]);
  const phoneValue = active && phoneField ? displayOf(active, phoneField) : '';

  /*
    The header strip: what the Layout Designer put there, plus the phone, the
    follow-up, the status and the module's own fact when an admin has not named
    them. Identical to the record page's rule on purpose — an admin arranges a
    header once, for both screens.

    The assignment field is deliberately **not** here. It goes on the name line
    instead, between the name and when the record was last touched, which is
    where the owner asked for it.
  */
  const headerFields = useMemo(() => {
    const names: string[] = [...(layout.headerFields ?? [])];
    for (const field of [phoneField, followUpField, statusField]) {
      if (field && !names.includes(field.name)) names.push(field.name);
    }
    return names
      .filter((name) => name !== assignedField?.name)
      .filter((name) => !DEMOTED_FROM_HEADER.has(name))
      // Contact Type and Unit Number already read on every queue row, under
      // the name. Repeating them two inches away said the same thing twice
      // and crowded out the header's job, which is the handful of facts you
      // act on: who, their number, what is next and where they are up to.
      .filter((name) => !subtitleFields.some((field) => field.name === name))
      .map((name) => fieldMap.get(name))
      .filter((field): field is FieldMeta => Boolean(field && field.isActive && field.displayType !== 'hidden'));
  }, [layout.headerFields, fieldMap, assignedField, phoneField, followUpField, statusField, subtitleFields]);

  const blocks = useMemo(() => {
    /*
      The record's own blocks, as the Layout Designer arranged them, so this
      pane reads like the record page rather than like a second opinion about
      the same record. With no layout saved it falls back to every field in
      sequence, which is what this card used to show.
    */
    const identity = new Set(module.labelFields);
    const usable = (field: FieldMeta | undefined): field is FieldMeta =>
      Boolean(field && field.isActive && field.displayType !== 'hidden' && field.uitype !== 'autonumber');

    const arranged = (layout.blocks ?? [])
      .map((block) => ({
        key: block.key,
        label: block.label,
        columns: block.columns,
        fields: block.fields.map((name) => fieldMap.get(name)).filter(usable),
      }))
      .filter((block) => block.fields.length);

    if (arranged.length) {
      /*
        A field taken off the header has to land somewhere, or the owner has
        simply lost it. Lost Reason, Contact Type and Unit Number are header
        fields on this layout and are not in any block, so demoting them
        without this would delete them from the screen rather than move them —
        and a value you can no longer see is one you can no longer edit.

        They go into the first block, which is Basic Information, where
        `FieldBlock` already renders them inline-editable like everything else.
      */
      const placed = new Set(arranged.flatMap((block) => block.fields.map((field) => field.name)));
      const homeless = [...DEMOTED_FROM_HEADER, ...subtitleFields.map((field) => field.name)]
        .filter((name) => !placed.has(name))
        .map((name) => fieldMap.get(name))
        .filter(usable);
      if (homeless.length) {
        arranged[0] = { ...arranged[0]!, fields: [...arranged[0]!.fields, ...homeless] };
      }
      return arranged;
    }

    return [{
      key: 'all',
      label: 'Basic Information',
      columns: 2,
      fields: module.fields
        .filter(usable)
        .filter((field) => !identity.has(field.name))
        .sort((a, b) => a.sequence - b.sequence),
    }];
  }, [layout.blocks, fieldMap, module.fields, module.labelFields, subtitleFields]);

  /*
    What the queue's one menu can do. Ordering and the follow-up windows are
    two different questions and they stay two sections, but they are one
    control: "sort this queue" is a single thought to a rep working it.
  */
  const sortChoices = useMemo<SortChoice[]>(() => {
    const out: SortChoice[] = [{ key: 'recent', label: 'Recently updated' }];
    const nameField = module.labelFields.map((name) => fieldMap.get(name)).find(Boolean);
    if (nameField) out.push({ key: 'name', label: `${nameField.label} A–Z`, sort: { by: nameField.name, dir: 'asc' } });
    for (const field of subtitleFields) out.push({ key: `subtitle:${field.name}`, label: `${field.label} A–Z`, sort: { by: field.name, dir: 'asc' } });
    if (statusField) out.push({ key: 'status', label: `${statusField.label} A–Z`, sort: { by: statusField.name, dir: 'asc' } });
    if (followUpField) out.push({ key: 'task', label: 'Task, soonest first', sort: { by: followUpField.name, dir: 'asc' } });
    return out;
  }, [module.labelFields, fieldMap, subtitleFields, statusField, followUpField]);

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
  return <CallDispositionProvider key={active?.id ?? 'none'} recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
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
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 pt-3 dark:border-slate-800 dark:bg-slate-900 sm:px-7">
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
          <div className="flex min-w-0 items-start gap-4">
            <Avatar name={active.label} size={52} className="mt-0.5 text-lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="truncate text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white">{active.label}</h2>
                {/* Between the name and when it was last touched, which is
                    where the owner asked for it. */}
                {assignedField && (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
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
                <span className="text-sm text-slate-400">Updated {relativeTime(active.updatedAt)}</span>
                {active.tags?.slice(0, 2).map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 text-2xs font-semibold text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"><Tag className="h-3 w-3" />{tag}</span>)}

              </div>

              {/* How complete the record is, under the name rather than
                  wrapped around the avatar. */}
              <StrengthBar module={module} row={active} className="mt-1.5 max-w-[13rem]" slim />

              {/*
                Every header value the record page carries, each one typed in
                where it stands. The owner's instruction: "Full of the header
                things phone number, next follow-up all other things be in
                line editable."
              */}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 pb-1 text-sm font-medium text-slate-800 dark:text-slate-100">
                {headerFields.map((field) => (
                  <span key={field.name} className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate">
                    <span className="shrink-0 text-xs font-normal text-muted">{field.label}:</span>
                    {canEdit && isInlineEditable(field) ? (
                      <EditableField
                        module={module.name}
                        recordId={active.id}
                        field={field}
                        value={active.values[field.name]}
                        display={active.display?.[field.name]}
                        compact
                        siblings={active.values}
                        restrictTo={restrictionForField(module.picklistDependencies, active.values, field.name)}
                        onSaved={() => invalidateRecordQueries(queryClient, module.name, active.id)}
                      />
                    ) : (
                      <FieldValue field={field} value={active.values[field.name]} display={active.display?.[field.name]} compact />
                    )}
                  </span>
                ))}
              </div>
            </div>

            <span className="mt-1 flex shrink-0 items-center gap-2">
              <button
                aria-label={active.starred ? 'Remove from starred' : 'Star this record'}
                title={active.starred ? 'Remove from starred' : 'Star this record'}
                onClick={() => star.mutate(active)}
                className={cn(ACTION_CIRCLE, active.starred && 'text-amber-500')}
              >
                <Star className={cn('h-4 w-4', active.starred && 'fill-amber-400')} />
              </button>
              {phoneValue && <WhatsAppButton to={phoneValue} iconOnly round />}
              {phoneValue && <CallButton to={phoneValue} iconOnly round />}
              {onDelete && (
                <button
                  onClick={() => onDelete(active)}
                  className={cn(ACTION_CIRCLE, 'hover:text-rose-600')}
                  title={`Delete ${active.label}`}
                  aria-label={`Delete ${active.label}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}

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

          <nav className="mt-3 flex max-w-full overflow-x-auto" aria-label="Record workspace sections">
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
        'flex w-full items-start gap-2.5 border-b border-slate-100 px-3 py-2.5 text-left transition-colors dark:border-slate-800',
        active ? 'border-l-4 border-l-brand-600 bg-brand-50/70 pl-2 dark:bg-brand-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/70',
      )}
    >
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
        {statusField && <StatusPill field={statusField} row={row} label={displayOf(row, statusField) || 'Not set'} />}
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
function FieldBlock({ module, title, columns, fields, row, canEdit }: {
  module: DescribedModule; title: string; columns: number; fields: FieldMeta[]; row: RecordEnvelope; canEdit: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
    <header className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
      <p className="text-base font-bold text-slate-900 dark:text-white">{title}</p>
    </header>
    <dl className={cn('grid gap-x-8 gap-y-4 p-5', columns >= 3 ? 'sm:grid-cols-3' : columns === 1 ? '' : 'sm:grid-cols-2')}>{fields.map((field) => <div key={field.name}>
      <dt className="mb-1.5 text-2xs font-bold uppercase tracking-wide text-slate-500">{field.label}{field.isMandatory && <span className="ml-0.5 text-rose-500">*</span>}</dt>
      {/*
        The whole cell is the target, not just the value inside it.

        `EditableField` takes the click on its own box, which is only as wide
        as the value — so on an empty field that box is a dash in the middle of
        a wide cell and a click anywhere else in it hits nothing at all. That
        reads as inline editing being broken, which is the opposite of the ask.
        A click on the cell forwards to the field's own "Change …" control, so
        there is still exactly one thing that opens an editor.
      */}
      <dd
        className={cn(
          'min-h-10 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-100',
          canEdit && isInlineEditable(field) && 'cursor-pointer hover:border-brand-300',
        )}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          event.currentTarget.querySelector<HTMLButtonElement>('button')?.click();
        }}
      >
        {canEdit && isInlineEditable(field)
          ? <EditableField
              module={module.name}
              recordId={row.id}
              field={field}
              value={row.values[field.name]}
              display={row.display?.[field.name]}
              siblings={row.values}
              restrictTo={restrictionForField(module.picklistDependencies, row.values, field.name)}
              onSaved={() => invalidateRecordQueries(queryClient, module.name, row.id)}
            />
          : <FieldValue field={field} value={row.values[field.name]} display={row.display?.[field.name]} compact />}
      </dd>
    </div>)}</dl>
  </section>;
}

/**
 * The team's notes, beside the record's own fields rather than in a column of
 * their own. Two panes, as the owner asked on 19 September.
 */
function NotesPanel({ module, record }: { module: string; record: RecordEnvelope }): JSX.Element {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const { data: entries, isLoading } = useQuery({ queryKey: ['timeline', module, record.id, 'comment'], queryFn: () => api.timeline(module, record.id, ['comment']) });
  const add = useMutation({
    mutationFn: () => api.addComment(module, record.id, note.trim()),
    onSuccess: () => { setNote(''); void queryClient.invalidateQueries({ queryKey: ['timeline', module, record.id] }); toast.success('Note added'); },
    onError: (error: Error) => toast.error('Could not add note', error.message),
  });
  return <section className="h-fit overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
    <header className="flex h-12 items-center gap-2 border-b border-slate-200 px-5 dark:border-slate-800"><FileText className="h-4 w-4 text-brand-600" /><h3 className="font-bold text-slate-900 dark:text-white">Notes</h3></header>
    <div className="p-4"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note for the team… type @ to notify someone" className="min-h-24 w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none placeholder:text-slate-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-800" /><div className="mt-2 flex items-center justify-between"><span className="text-2xs text-slate-400">⌘↵ to post</span><button disabled={!note.trim() || add.isPending} onClick={() => add.mutate()} className="btn-primary btn-sm"><Send className="h-3.5 w-3.5" />{add.isPending ? 'Posting…' : 'Post'}</button></div></div>
    <div className="max-h-[25rem] space-y-4 overflow-y-auto border-t border-slate-100 p-5 dark:border-slate-800">{isLoading ? <p className="text-sm text-slate-400">Loading notes…</p> : entries?.length ? entries.map((entry) => <NoteEntry key={entry.id} entry={entry} />) : <div className="py-10 text-center"><FileText className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">No notes yet</p><p className="mt-1 text-xs text-slate-400">Internal team comments appear here.</p></div>}</div>
  </section>;
}
function NoteEntry({ entry }: { entry: TimelineEntry }): JSX.Element { return <article><p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{entry.title}</p><p className="mt-0.5 text-2xs text-slate-400">{entry.actorName ?? 'iPROPY'} · {relativeTime(entry.at)}</p>{entry.body && <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-slate-600 dark:text-slate-300">{entry.body}</p>}</article>; }
function DeskTab({ active = false, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element { return <button onClick={onClick} className={cn('flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-semibold transition-colors', active ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>{children}</button>; }
function StatusPill({ field, row, label }: { field: FieldMeta; row: RecordEnvelope; label: string }): JSX.Element { const value = String(row.values[field.name] ?? ''); const color = field.options?.find((option) => option.value === value)?.color; return <span className="max-w-32 shrink-0 truncate rounded px-2 py-0.5 text-2xs font-bold" style={color ? { backgroundColor: `${color}20`, color } : undefined}>{label}</span>; }
function displayOf(row: RecordEnvelope, field: FieldMeta): string { const display = row.display?.[field.name]; if (display) return display; const value = row.values[field.name]; return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value); }
function dueLabel(value: unknown): { label: string; tone: string } | null { if (!value) return null; const date = new Date(String(value)); if (Number.isNaN(date.getTime())) return null; const today = new Date(); today.setHours(0, 0, 0, 0); date.setHours(0, 0, 0, 0); const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000); return diff < 0 ? { label: 'Overdue', tone: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' } : diff === 0 ? { label: 'Today', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' } : diff === 1 ? { label: 'Tomorrow', tone: 'bg-brand-100 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300' } : { label: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), tone: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }; }
