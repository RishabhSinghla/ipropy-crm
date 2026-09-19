import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { recordStrength, relativeTime, type FieldMeta, type ModuleMeta, type RecordEnvelope, type TimelineEntry } from '@ipropy/shared';
import { ChevronRight, FileText, Link2, MessageCircle, Phone, Send, Star, Tag, Trash2 } from 'lucide-react';
import { FieldValue } from './FieldRenderer';
import { CallButton, CallDispositionProvider } from './CallDisposition';
import { WhatsAppComposerProvider } from './WhatsAppComposer';
import { MatchingTab } from './MatchingTab';
import { WhatsAppTab } from './WhatsAppTab';
import { WhatsAppButton } from './WhatsAppButton';
import { CallsTab, FilesTab, TimelineTab } from '../pages/RecordDetail';
import { EditableField, isInlineEditable } from './EditableField';
import { invalidateRecordQueries } from '../lib/invalidate';
import { assignmentField, queueSubtitleField } from '../lib/fields';
import { ModuleIcon } from './Layout';
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
  Where the two dividers sit, remembered in the browser.

  The same reasoning as which view a list opens in: it is a personal
  preference somebody adjusts several times a day, it is nobody else's
  business, and a per-user setting needing a round trip to say how wide you
  like your queue is slow at exactly the wrong moment.
*/
const SPLIT_KEY = 'ipropy.split';
const LIMITS = { queue: [240, 620], notes: [240, 560] } as const;

function loadSplit(which: 'queue' | 'notes', fallback: number): number {
  const [min, max] = LIMITS[which];
  try {
    const raw = Number(localStorage.getItem(`${SPLIT_KEY}.${which}`));
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.min(max, Math.max(min, raw));
  } catch {
    // A private window and blocked site data both throw here, and a divider
    // that cannot be remembered is not a reason for a blank screen.
    return fallback;
  }
}

/**
 * The grip between two panes.
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
 * The split view: the queue on the left, the whole record in the middle, the
 * team's notes on the right — and **nothing that sends you anywhere else**.
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
 *    place.
 */
export function IpropyWorkspace({
  module, rows, selected, attentionIds, onToggleSelect, onDelete,
}: {
  module: DescribedModule; rows: RecordEnvelope[];
  selected: Set<string>; attentionIds: Set<string>; onToggleSelect: (id: string, checked: boolean) => void;
  /** Absent when this profile may not delete — the button is not offered at all. */
  onDelete?: (row: RecordEnvelope) => void;
}): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(rows[0]?.id ?? null);
  const [tab, setTab] = useState<DeskTabKey>('overview');
  const [queueWidth, setQueueWidth] = useState(() => loadSplit('queue', 360));
  const [notesWidth, setNotesWidth] = useState(() => loadSplit('notes', 320));
  const queryClient = useQueryClient();

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

  const resize = useCallback((which: 'queue' | 'notes', delta: number) => {
    const [min, max] = LIMITS[which];
    const setter = which === 'queue' ? setQueueWidth : setNotesWidth;
    setter((current) => {
      // The notes panel is on the right, so dragging its handle right makes it
      // *narrower* — the sign flips or the pane fights the cursor.
      const next = Math.min(max, Math.max(min, current + (which === 'queue' ? delta : -delta)));
      try { localStorage.setItem(`${SPLIT_KEY}.${which}`, String(Math.round(next))); } catch { /* see loadSplit */ }
      return next;
    });
  }, []);

  const layout = useMemo<DetailLayout>(
    () => (module.layouts?.find((l) => l.type === 'detail' && l.is_default)?.config ?? {}) as DetailLayout,
    [module.layouts],
  );
  const fieldMap = useMemo(() => new Map(module.fields.map((field) => [field.name, field])), [module.fields]);
  const assignedField = useMemo(() => assignmentField(module.fields), [module.fields]);
  const subtitleField = useMemo(() => queueSubtitleField(module.fields), [module.fields]);
  const statusField = useMemo(() => module.fields.find((f) => f.name === module.pipelineField) ?? module.fields.find((f) => /status|stage/i.test(f.name)), [module.fields, module.pipelineField]);
  const followUpField = useMemo(() => module.fields.find((f) => f.columnName === 'next_followup_at') ?? module.fields.find((f) => /next.*follow.*up/i.test(f.name)), [module.fields]);
  const phoneField = useMemo(() => module.fields.find((f) => f.uitype === 'phone'), [module.fields]);
  const phoneValue = active && phoneField ? displayOf(active, phoneField) : '';

  /*
    The header strip: what the Layout Designer put there, plus the assignment
    field when it is not already on the list, plus the phone and the follow-up
    when an admin has not named them. Identical to the record page's rule on
    purpose — an admin arranges a header once, for both screens.
  */
  const headerFields = useMemo(() => {
    const names: string[] = [...(layout.headerFields ?? [])];
    /*
      Four the record page appends the same way, and one the owner named:
      Contact Type on a contact, Unit Number on a unit. "I cannot see contact
      type in this header" — it is not on the saved header layout, and waiting
      for an admin to add it there is not an answer to a rep who needs to see
      at a glance whether this is a buyer or a seller.
    */
    for (const field of [assignedField, phoneField, followUpField, statusField, subtitleField]) {
      if (field && !names.includes(field.name)) names.push(field.name);
    }
    return names
      .map((name) => fieldMap.get(name))
      .filter((field): field is FieldMeta => Boolean(field && field.isActive && field.displayType !== 'hidden'));
  }, [layout.headerFields, fieldMap, assignedField, phoneField, followUpField, statusField, subtitleField]);

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
    if (arranged.length) return arranged;

    return [{
      key: 'all',
      label: 'Basic Information',
      columns: 2,
      fields: module.fields
        .filter(usable)
        .filter((field) => !identity.has(field.name))
        .sort((a, b) => a.sequence - b.sequence),
    }];
  }, [layout.blocks, fieldMap, module.fields, module.labelFields]);

  // A list row carries no `can`, so the module's own permission stands in
  // until the record itself arrives and answers for this row.
  const canEdit = active?.can?.edit ?? module.permissions.edit;

  /*
    One provider around the whole view, keyed on the record that is open: the
    call dialog belongs to a record, and re-keying it is what stops an outcome
    being saved against whoever was on screen before.
  */
  return <CallDispositionProvider key={active?.id ?? 'none'} recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
    <WhatsAppComposerProvider key={active?.id ?? 'none'} recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
    <section data-testid="ipropy-workspace" className="min-h-full bg-[#f7f9fc] dark:bg-slate-950">
    {/*
      A flex row with two draggable dividers, not a fixed grid. Below `xl` the
      panes stack and the widths are ignored entirely — the handles are
      `xl:block`, because a divider you cannot see is not one you can drag.
    */}
    <div
      className="flex min-h-[calc(100vh-13rem)] flex-col xl:flex-row"
      style={{ ['--queue-w' as string]: `${queueWidth}px`, ['--notes-w' as string]: `${notesWidth}px` }}
    >
      <aside className="w-full shrink-0 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 xl:w-[var(--queue-w)] xl:border-b-0">
        <div className="flex h-10 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300"><ModuleIcon name={module.icon} className="h-4 w-4 text-brand-600" />{module.label}</p>
          <span className="text-2xs font-semibold text-slate-400">{rows.length} shown</span>
        </div>
        <div className="max-h-[31rem] overflow-y-auto xl:max-h-[calc(100vh-13rem)]">
          {rows.map((row) => <QueueRow key={row.id} module={module} row={row} active={row.id === active?.id} checked={selected.has(row.id)} attention={attentionIds.has(row.id)} statusField={statusField} followUpField={followUpField} subtitleField={subtitleField} onSelect={() => setActiveId(row.id)} onToggle={(checked) => onToggleSelect(row.id, checked)} />)}
        </div>
      </aside>

      <SplitHandle label="Resize the list" onDrag={(delta) => resize('queue', delta)} />

      {active && <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-slate-200 bg-white px-5 pt-4 dark:border-slate-800 dark:bg-slate-900 sm:px-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <ScoreRing module={module} row={active} large />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h2 className="truncate text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white">{active.label}</h2>
                  <span className="text-sm text-slate-400">Updated {relativeTime(active.updatedAt)}</span>
                  {active.tags?.slice(0, 2).map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 text-2xs font-semibold text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"><Tag className="h-3 w-3" />{tag}</span>)}
                </div>
                {/*
                  Every header value the record page carries, each one typed in
                  where it stands. The owner's instruction: "Full of the header
                  things phone number, next follow-up all other things be in
                  line editable."
                */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-slate-800 dark:text-slate-100">
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
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                aria-label={active.starred ? 'Remove from starred' : 'Star this record'}
                title={active.starred ? 'Remove from starred' : 'Star this record'}
                onClick={() => star.mutate(active)}
                className={cn('inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors', active.starred ? 'border-amber-300 bg-amber-100 text-amber-600 dark:border-amber-800 dark:bg-amber-950/50' : 'border-amber-200 bg-amber-50 text-amber-500 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30')}
              >
                <Star className={cn('h-4 w-4', active.starred && 'fill-amber-400')} />
              </button>
              {/* Icons only. The words cost a third of the header strip for
                  two buttons everybody recognises by their shape. */}
              {phoneValue && <WhatsAppButton to={phoneValue} iconOnly />}
              {phoneValue && <CallButton to={phoneValue} iconOnly />}
              {onDelete && <button onClick={() => onDelete(active)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-600 transition-colors hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300" title={`Delete ${active.label}`} aria-label={`Delete ${active.label}`}><Trash2 className="h-4 w-4" /></button>}
            </div>
          </div>
          <nav className="mt-4 flex max-w-full overflow-x-auto" aria-label="Record workspace sections">
            <DeskTab active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</DeskTab>
            <DeskTab active={tab === 'timeline'} onClick={() => setTab('timeline')}>Timeline</DeskTab>
            <DeskTab active={tab === 'matching'} onClick={() => setTab('matching')}><Link2 className="h-3.5 w-3.5" />Matching {module.name === 'leads' ? 'inventory' : 'leads'}</DeskTab>
            <DeskTab active={tab === 'files'} onClick={() => setTab('files')}><FileText className="h-3.5 w-3.5" />Files</DeskTab>
            <DeskTab active={tab === 'calls'} onClick={() => setTab('calls')}><Phone className="h-3.5 w-3.5" />Calls</DeskTab>
            <DeskTab active={tab === 'whatsapp'} onClick={() => setTab('whatsapp')}><MessageCircle className="h-3.5 w-3.5" />WhatsApp</DeskTab>
          </nav>
        </header>
        <div className="min-w-0 flex-1 space-y-4 bg-[#f7f9fc] p-4 sm:p-6 dark:bg-slate-950/50">
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
      </main>}

      <SplitHandle label="Resize the notes panel" onDrag={(delta) => resize('notes', delta)} />

      {active && <NotesPanel module={module.name} record={active} />}
    </div>
    </section>
    </WhatsAppComposerProvider>
  </CallDispositionProvider>;
}

function QueueRow({ module, row, active, checked, attention, statusField, followUpField, subtitleField, onSelect, onToggle }: { module: ModuleMeta; row: RecordEnvelope; active: boolean; checked: boolean; attention: boolean; statusField?: FieldMeta; followUpField?: FieldMeta; subtitleField?: FieldMeta; onSelect: () => void; onToggle: (checked: boolean) => void }): JSX.Element {
  const due = followUpField ? dueLabel(row.values[followUpField.name]) : null;
  // A contact's Type, a unit's Unit Number — never the record id, which
  // identifies a row to a database and nothing to a person.
  const subtitle = subtitleField ? displayOf(row, subtitleField) : '';
  return <button type="button" onClick={onSelect} className={cn('group flex w-full items-center gap-3 border-b border-slate-100 px-4 py-2 text-left transition-colors dark:border-slate-800', active ? 'border-l-4 border-l-brand-600 bg-brand-50/70 pl-3 dark:bg-brand-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/70')}><input aria-label={`Select ${row.label}`} type="checkbox" checked={checked} onClick={(event) => event.stopPropagation()} onChange={(event) => onToggle(event.target.checked)} className="h-4 w-4 shrink-0 rounded border-slate-300" /><ScoreRing module={module} row={row} /><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">{row.label}</span>{row.starred && <Star className="h-3 w-3 fill-amber-400 text-amber-500" />}</span>{subtitle && <span className="mt-0.5 block truncate text-xs text-slate-500">{subtitle}</span>}</span><span className="flex shrink-0 flex-col items-end gap-1">{due && <span className={cn('rounded px-1.5 py-0.5 text-2xs font-bold', due.tone)}>{due.label}</span>}{statusField && <StatusPill field={statusField} row={row} label={displayOf(row, statusField) || 'Not set'} />}{attention && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Needs attention" />}</span><ChevronRight className="hidden h-4 w-4 text-slate-300 group-hover:block" /></button>;
}
function ScoreRing({ module, row, large = false }: { module: ModuleMeta; row: RecordEnvelope; large?: boolean }): JSX.Element { const percent = recordStrength(module.fields, row.values).percent; const color = percent >= 80 ? '#14b86a' : percent >= 55 ? '#f59e0b' : '#ee3458'; const size = large ? 58 : 36; return <span className="relative flex shrink-0 items-center justify-center rounded-full bg-white shadow-sm dark:bg-slate-800" style={{ width: size, height: size, background: `conic-gradient(${color} ${percent}%, #e8edf4 0)` }}><span className="flex items-center justify-center rounded-full bg-white font-extrabold tabular-nums text-slate-800 dark:bg-slate-900 dark:text-white" style={{ width: size - 7, height: size - 7, fontSize: large ? 16 : 10 }}>{percent}%</span></span>; }

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
function NotesPanel({ module, record }: { module: string; record: RecordEnvelope }): JSX.Element { const queryClient = useQueryClient(); const [note, setNote] = useState(''); const { data: entries, isLoading } = useQuery({ queryKey: ['timeline', module, record.id, 'comment'], queryFn: () => api.timeline(module, record.id, ['comment']) }); const add = useMutation({ mutationFn: () => api.addComment(module, record.id, note.trim()), onSuccess: () => { setNote(''); void queryClient.invalidateQueries({ queryKey: ['timeline', module, record.id] }); toast.success('Note added'); }, onError: (error: Error) => toast.error('Could not add note', error.message) }); return <aside className="w-full shrink-0 border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 xl:w-[var(--notes-w)] xl:border-t-0"><header className="flex h-12 items-center gap-2 border-b border-slate-200 px-5 dark:border-slate-800"><FileText className="h-4 w-4 text-brand-600" /><h3 className="font-bold text-slate-900 dark:text-white">Notes</h3></header><div className="p-4"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note for the team… type @ to notify someone" className="min-h-28 w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none placeholder:text-slate-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-800" /><div className="mt-2 flex items-center justify-between"><span className="text-2xs text-slate-400">⌘↵ to post</span><button disabled={!note.trim() || add.isPending} onClick={() => add.mutate()} className="btn-primary btn-sm"><Send className="h-3.5 w-3.5" />{add.isPending ? 'Posting…' : 'Post'}</button></div></div><div className="max-h-[25rem] space-y-4 overflow-y-auto border-t border-slate-100 p-5 dark:border-slate-800">{isLoading ? <p className="text-sm text-slate-400">Loading notes…</p> : entries?.length ? entries.map((entry) => <NoteEntry key={entry.id} entry={entry} />) : <div className="py-12 text-center"><FileText className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">No notes yet</p><p className="mt-1 text-xs text-slate-400">Internal team comments appear here.</p></div>}</div></aside>; }
function NoteEntry({ entry }: { entry: TimelineEntry }): JSX.Element { return <article><p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{entry.title}</p><p className="mt-0.5 text-2xs text-slate-400">{entry.actorName ?? 'iPROPY'} · {relativeTime(entry.at)}</p>{entry.body && <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-slate-600 dark:text-slate-300">{entry.body}</p>}</article>; }
function DeskTab({ active = false, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element { return <button onClick={onClick} className={cn('flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-semibold transition-colors', active ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>{children}</button>; }
function StatusPill({ field, row, label }: { field: FieldMeta; row: RecordEnvelope; label: string }): JSX.Element { const value = String(row.values[field.name] ?? ''); const color = field.options?.find((option) => option.value === value)?.color; return <span className="max-w-32 truncate rounded px-2 py-0.5 text-2xs font-bold" style={color ? { backgroundColor: `${color}20`, color } : undefined}>{label}</span>; }
function displayOf(row: RecordEnvelope, field: FieldMeta): string { const display = row.display?.[field.name]; if (display) return display; const value = row.values[field.name]; return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value); }
function dueLabel(value: unknown): { label: string; tone: string } | null { if (!value) return null; const date = new Date(String(value)); if (Number.isNaN(date.getTime())) return null; const today = new Date(); today.setHours(0, 0, 0, 0); date.setHours(0, 0, 0, 0); const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000); return diff < 0 ? { label: 'Overdue', tone: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' } : diff === 0 ? { label: 'Today', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' } : diff === 1 ? { label: 'Tomorrow', tone: 'bg-brand-100 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300' } : { label: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), tone: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }; }
