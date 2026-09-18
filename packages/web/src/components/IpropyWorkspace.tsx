import { type JSX, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { recordStrength, relativeTime, type FieldMeta, type ModuleMeta, type RecordEnvelope, type TimelineEntry } from '@ipropy/shared';
import { ChevronRight, CircleEllipsis, FileText, Link2, MessageCircle, Pencil, Phone, Send, Star, Tag, Trash2, UserRound } from 'lucide-react';
import { FieldValue } from './FieldRenderer';
import { CallButton, CallDispositionProvider } from './CallDisposition';
import { WhatsAppComposerProvider } from './WhatsAppComposer';
import { MatchingTab } from './MatchingTab';
import { WhatsAppTab } from './WhatsAppTab';
import { WhatsAppButton } from './WhatsAppButton';
import { CallsTab, FilesTab, TimelineTab } from '../pages/RecordDetail';
import RecordForm from './RecordForm';
import { Modal, Spinner } from './ui';
import { EditableField, isInlineEditable } from './EditableField';
import { invalidateRecordQueries } from '../lib/invalidate';
import { ModuleIcon } from './Layout';
import { api } from '../lib/api';
import { cn, restrictionForField } from '../lib/utils';
import { toast } from '../lib/store';

type DeskTabKey = 'overview' | 'timeline' | 'matching' | 'files' | 'calls' | 'whatsapp';

/**
 * The module as the list itself has it: fields, plus the two things writing
 * needs — what this profile may do, and which picklist narrows which.
 */
type DescribedModule = ModuleMeta & {
  permissions: { view: boolean; create: boolean; edit: boolean; delete: boolean };
  picklistDependencies: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[];
};

/** A high-density record desk: list, record context and team notes in one view. */
export function IpropyWorkspace({
  module, rows, selected, attentionIds, onToggleSelect, onOpen, onDelete,
}: {
  module: DescribedModule; rows: RecordEnvelope[];
  selected: Set<string>; attentionIds: Set<string>; onToggleSelect: (id: string, checked: boolean) => void;
  onOpen: (id: string) => void;
  /** Absent when this profile may not delete — the button is not offered at all. */
  onDelete?: (row: RecordEnvelope) => void;
}): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(rows[0]?.id ?? null);
  const [tab, setTab] = useState<DeskTabKey>('overview');
  // Editing happens here, in a dialog over the desk. Leaving for the record
  // page was the whole complaint: this view is where the work is done.
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const star = useMutation({
    mutationFn: (row: RecordEnvelope) => api.star(module.name, row.id, !row.starred),
    onSuccess: () => invalidateRecordQueries(queryClient, module.name),
    onError: (error: Error) => toast.error('Could not change that', error.message),
  });
  useEffect(() => setActiveId((current) => rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? null)), [rows]);

  const active = rows.find((row) => row.id === activeId) ?? rows[0] ?? null;
  const statusField = useMemo(() => module.fields.find((f) => f.name === module.pipelineField) ?? module.fields.find((f) => /status|stage/i.test(f.name)), [module.fields, module.pipelineField]);
  const followUpField = useMemo(() => module.fields.find((f) => f.columnName === 'next_followup_at') ?? module.fields.find((f) => /next.*follow.*up/i.test(f.name)), [module.fields]);
  const phoneField = useMemo(() => module.fields.find((f) => f.uitype === 'phone'), [module.fields]);
  const phoneValue = active && phoneField ? displayOf(active, phoneField) : '';
  const overviewFields = useMemo(() => {
    /*
      The record's fields, not the list's columns.

      The card is the record seen from the list, so it shows what the record
      has — a table narrowed to five columns would otherwise narrow this to
      five fields, and the value somebody came here to fix is exactly the one
      that is not a column.
    */
    const identity = new Set(module.labelFields);
    return module.fields
      .filter((field) => field.isActive && field.displayType !== 'hidden')
      .filter((field) => !identity.has(field.name) && field.uitype !== 'autonumber')
      .sort((a, b) => a.sequence - b.sequence);
  }, [module.fields, module.labelFields]);

  /*
    One provider around the desk, keyed on the record that is open: the call
    dialog belongs to a record, and re-keying it is what stops an outcome being
    saved against whoever was on screen before.
  */
  return <CallDispositionProvider key={active?.id ?? 'none'} recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
    <WhatsAppComposerProvider key={active?.id ?? 'none'} recordId={active?.id ?? ''} module={module.name} recordLabel={active?.label ?? ''}>
    <section data-testid="ipropy-workspace" className="min-h-full bg-[#f7f9fc] dark:bg-slate-950">
    <div className="grid min-h-[calc(100vh-13rem)] xl:grid-cols-[minmax(20rem,29rem)_minmax(0,1fr)_minmax(18rem,23rem)] xl:grid-rows-[auto_1fr]">
      <aside className="border-b border-slate-200 bg-white xl:row-span-2 xl:border-b-0 xl:border-r dark:border-slate-800 dark:bg-slate-900">
        <div className="flex h-10 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300"><ModuleIcon name={module.icon} className="h-4 w-4 text-brand-600" />{module.singularLabel} / Contact</p>
          <span className="text-2xs font-semibold text-slate-400">{rows.length} shown</span>
        </div>
        <div className="max-h-[31rem] overflow-y-auto xl:max-h-[calc(100vh-13rem)]">
          {rows.map((row) => <QueueRow key={row.id} module={module} row={row} active={row.id === active?.id} checked={selected.has(row.id)} attention={attentionIds.has(row.id)} statusField={statusField} followUpField={followUpField} onSelect={() => setActiveId(row.id)} onToggle={(checked) => onToggleSelect(row.id, checked)} />)}
        </div>
      </aside>
      {active && <main className="contents">
        <header className="border-b border-slate-200 bg-white px-5 pt-4 dark:border-slate-800 dark:bg-slate-900 sm:px-7 xl:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4"><ScoreRing module={module} row={active} large /><div className="min-w-0"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h2 className="truncate text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white">{active.label}</h2><span className="hidden h-1 w-1 rounded-full bg-slate-300 sm:inline" /><span className="inline-flex items-center gap-1 text-sm text-slate-500"><UserRound className="h-3.5 w-3.5" />{active.ownerName ?? 'Unassigned'}</span><span className="text-sm text-slate-400">• Updated {relativeTime(active.updatedAt)}</span></div><div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">{phoneField && displayOf(active, phoneField) && <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-200"><Phone className="h-3.5 w-3.5 text-brand-600" />{displayOf(active, phoneField)}</span>}{followUpField && <span className="text-slate-500">Next Follow-up: <b className="text-slate-700 dark:text-slate-200">{dateLabel(active.values[followUpField.name]) ?? '—'}</b></span>}{statusField && <StatusPill field={statusField} row={active} label={displayOf(active, statusField) || 'Not set'} />}{active.tags?.slice(0, 2).map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 text-2xs font-semibold text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"><Tag className="h-3 w-3" />{tag}</span>)}</div></div></div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                aria-label={active.starred ? 'Remove from starred' : 'Star this record'}
                title={active.starred ? 'Remove from starred' : 'Star this record'}
                onClick={() => star.mutate(active)}
                className={cn('inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors', active.starred ? 'border-amber-300 bg-amber-100 text-amber-600 dark:border-amber-800 dark:bg-amber-950/50' : 'border-amber-200 bg-amber-50 text-amber-500 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30')}
              >
                <Star className={cn('h-4 w-4', active.starred && 'fill-amber-400')} />
              </button>
              {/* The same two buttons the record page carries, doing the same
                  two things: the call opens the outcome form so it is logged,
                  and WhatsApp leaves for WhatsApp itself. */}
              {phoneValue && <WhatsAppButton to={phoneValue} />}
              {phoneValue && <CallButton to={phoneValue} />}
              <button onClick={() => setEditing(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-100 dark:border-brand-900 dark:bg-brand-950/30 dark:text-brand-300" title="Edit this record here">
                <Pencil className="h-4 w-4" />Edit
              </button>
              <button onClick={() => onOpen(active.id)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800" title="Open the full record page" aria-label="Open the full record page"><CircleEllipsis className="h-4 w-4" /></button>
              {onDelete && <button onClick={() => onDelete(active)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-600 transition-colors hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300" title={`Delete ${active.label}`} aria-label={`Delete ${active.label}`}><Trash2 className="h-4 w-4" /></button>}
            </div>
          </div>
          <nav className="mt-4 flex max-w-full overflow-x-auto" aria-label="Record workspace sections">
            {/* Every tab renders in this window. They used to send you to the
                record page, which is the trip this view exists to save. */}
            <DeskTab active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</DeskTab>
            <DeskTab active={tab === 'timeline'} onClick={() => setTab('timeline')}>Timeline</DeskTab>
            <DeskTab active={tab === 'matching'} onClick={() => setTab('matching')}><Link2 className="h-3.5 w-3.5" />Matching {module.name === 'leads' ? 'inventory' : 'leads'}</DeskTab>
            <DeskTab active={tab === 'files'} onClick={() => setTab('files')}><FileText className="h-3.5 w-3.5" />Files</DeskTab>
            <DeskTab active={tab === 'calls'} onClick={() => setTab('calls')}><Phone className="h-3.5 w-3.5" />Calls</DeskTab>
            <DeskTab active={tab === 'whatsapp'} onClick={() => setTab('whatsapp')}><MessageCircle className="h-3.5 w-3.5" />WhatsApp</DeskTab>
          </nav>
        </header>
        <div className="min-w-0 bg-[#f7f9fc] p-4 sm:p-6 dark:bg-slate-950/50">
          {tab === 'overview' && <OverviewCard module={module} fields={overviewFields} row={active} onEdit={() => setEditing(true)} />}
          {tab === 'timeline' && <TimelineTab module={module.name} id={active.id} />}
          {tab === 'matching' && <MatchingTab module={module.name} id={active.id} returnQuery="" recordLabel={active.label} />}
          {tab === 'files' && <FilesTab module={module.name} id={active.id} canEdit={module.permissions.edit} />}
          {tab === 'calls' && <CallsTab recordId={active.id} />}
          {tab === 'whatsapp' && <WhatsAppTab module={module.name} recordId={active.id} mobile={phoneValue || null} />}
        </div>
      </main>}
      {active && <NotesPanel module={module.name} record={active} />}
    </div>
    {active && editing && <EditRecordDialog module={module} recordId={active.id} label={active.label} onClose={() => setEditing(false)} />}
    </section>
    </WhatsAppComposerProvider>
  </CallDispositionProvider>;
}

/**
 * The record's own form, over the desk.
 *
 * The full record is fetched rather than taken from the row: a list row holds
 * the values the *list* asked for, and saving a form built from those would
 * write blanks over every field the list did not carry. It is the same form
 * the record page uses, so validation, dependent picklists and the duplicate
 * warning all come along.
 */
function EditRecordDialog({ module, recordId, label, onClose }: {
  module: DescribedModule; recordId: string; label: string; onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { data: record, isLoading } = useQuery({
    queryKey: ['record', module.name, recordId],
    queryFn: () => api.record(module.name, recordId),
  });

  return <Modal open onClose={onClose} title={`Edit ${label}`} size="xl">
    {isLoading || !record
      ? <div className="flex justify-center p-10"><Spinner /></div>
      : <RecordForm
          module={module}
          record={record}
          onSaved={() => {
            invalidateRecordQueries(queryClient, module.name, recordId);
            toast.success('Saved');
            onClose();
          }}
          onCancel={onClose}
        />}
  </Modal>;
}

function QueueRow({ module, row, active, checked, attention, statusField, followUpField, onSelect, onToggle }: { module: ModuleMeta; row: RecordEnvelope; active: boolean; checked: boolean; attention: boolean; statusField?: FieldMeta; followUpField?: FieldMeta; onSelect: () => void; onToggle: (checked: boolean) => void }): JSX.Element {
  const due = followUpField ? dueLabel(row.values[followUpField.name]) : null;
  return <button type="button" onClick={onSelect} className={cn('group flex w-full items-center gap-3 border-b border-slate-100 px-4 py-2 text-left transition-colors dark:border-slate-800', active ? 'border-l-4 border-l-brand-600 bg-brand-50/70 pl-3 dark:bg-brand-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/70')}><input aria-label={`Select ${row.label}`} type="checkbox" checked={checked} onClick={(event) => event.stopPropagation()} onChange={(event) => onToggle(event.target.checked)} className="h-4 w-4 shrink-0 rounded border-slate-300" /><ScoreRing module={module} row={row} /><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">{row.label}</span>{row.starred && <Star className="h-3 w-3 fill-amber-400 text-amber-500" />}</span><span className="mt-0.5 block truncate text-xs text-slate-500">{row.ownerName ?? row.recordNumber ?? module.singularLabel}</span></span><span className="flex shrink-0 flex-col items-end gap-1">{due && <span className={cn('rounded px-1.5 py-0.5 text-2xs font-bold', due.tone)}>{due.label}</span>}{statusField && <StatusPill field={statusField} row={row} label={displayOf(row, statusField) || 'Not set'} />}{attention && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Needs attention" />}</span><ChevronRight className="hidden h-4 w-4 text-slate-300 group-hover:block" /></button>;
}
function ScoreRing({ module, row, large = false }: { module: ModuleMeta; row: RecordEnvelope; large?: boolean }): JSX.Element { const percent = recordStrength(module.fields, row.values).percent; const color = percent >= 80 ? '#14b86a' : percent >= 55 ? '#f59e0b' : '#ee3458'; const size = large ? 58 : 36; return <span className="relative flex shrink-0 items-center justify-center rounded-full bg-white shadow-sm dark:bg-slate-800" style={{ width: size, height: size, background: `conic-gradient(${color} ${percent}%, #e8edf4 0)` }}><span className="flex items-center justify-center rounded-full bg-white font-extrabold tabular-nums text-slate-800 dark:bg-slate-900 dark:text-white" style={{ width: size - 7, height: size - 7, fontSize: large ? 16 : 10 }}>{percent}%</span></span>; }
/**
 * The record's own fields, editable where the table's cells are editable.
 *
 * `EditableField` is the same component the table uses, so a value changed
 * here goes through the same validation, the same permissions and the same
 * audit trail — the desk is a different way to look at a record, not a second
 * way to write one. A field the profile may not edit, or one whose type has no
 * inline editor, falls back to reading exactly as it did before.
 */
function OverviewCard({ module, fields, row, onEdit }: { module: DescribedModule; fields: FieldMeta[]; row: RecordEnvelope; onEdit: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
    <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
      <p className="text-base font-bold text-slate-900 dark:text-white">Basic Information</p>
      <button onClick={onEdit} className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700"><Pencil className="h-3.5 w-3.5" />Edit</button>
    </header>
    <dl className="grid gap-x-8 gap-y-4 p-5 sm:grid-cols-2">{fields.map((field) => <div key={field.name}>
      <dt className="mb-1.5 text-2xs font-bold uppercase tracking-wide text-slate-500">{field.label}{field.isMandatory && <span className="ml-0.5 text-rose-500">*</span>}</dt>
      <dd className="min-h-10 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-100">
        {module.permissions.edit && isInlineEditable(field, 'list')
          ? <EditableField
              surface="list"
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
function NotesPanel({ module, record }: { module: string; record: RecordEnvelope }): JSX.Element { const queryClient = useQueryClient(); const [note, setNote] = useState(''); const { data: entries, isLoading } = useQuery({ queryKey: ['timeline', module, record.id, 'comment'], queryFn: () => api.timeline(module, record.id, ['comment']) }); const add = useMutation({ mutationFn: () => api.addComment(module, record.id, note.trim()), onSuccess: () => { setNote(''); void queryClient.invalidateQueries({ queryKey: ['timeline', module, record.id] }); toast.success('Note added'); }, onError: (error: Error) => toast.error('Could not add note', error.message) }); return <aside className="border-t border-slate-200 bg-white xl:border-l xl:border-t-0 dark:border-slate-800 dark:bg-slate-900"><header className="flex h-12 items-center gap-2 border-b border-slate-200 px-5 dark:border-slate-800"><FileText className="h-4 w-4 text-brand-600" /><h3 className="font-bold text-slate-900 dark:text-white">Notes</h3></header><div className="p-4"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note for the team… type @ to notify someone" className="min-h-28 w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none placeholder:text-slate-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 dark:border-slate-700 dark:bg-slate-800" /><div className="mt-2 flex items-center justify-between"><span className="text-2xs text-slate-400">⌘↵ to post</span><button disabled={!note.trim() || add.isPending} onClick={() => add.mutate()} className="btn-primary btn-sm"><Send className="h-3.5 w-3.5" />{add.isPending ? 'Posting…' : 'Post'}</button></div></div><div className="max-h-[25rem] space-y-4 overflow-y-auto border-t border-slate-100 p-5 dark:border-slate-800">{isLoading ? <p className="text-sm text-slate-400">Loading notes…</p> : entries?.length ? entries.map((entry) => <NoteEntry key={entry.id} entry={entry} />) : <div className="py-12 text-center"><FileText className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">No notes yet</p><p className="mt-1 text-xs text-slate-400">Internal team comments appear here.</p></div>}</div></aside>; }
function NoteEntry({ entry }: { entry: TimelineEntry }): JSX.Element { return <article><p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{entry.title}</p><p className="mt-0.5 text-2xs text-slate-400">{entry.actorName ?? 'iPROPY'} · {relativeTime(entry.at)}</p>{entry.body && <p className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-slate-600 dark:text-slate-300">{entry.body}</p>}</article>; }
function DeskTab({ active = false, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element { return <button onClick={onClick} className={cn('flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-semibold transition-colors', active ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>{children}</button>; }
function StatusPill({ field, row, label }: { field: FieldMeta; row: RecordEnvelope; label: string }): JSX.Element { const value = String(row.values[field.name] ?? ''); const color = field.options?.find((option) => option.value === value)?.color; return <span className="max-w-32 truncate rounded px-2 py-0.5 text-2xs font-bold" style={color ? { backgroundColor: `${color}20`, color } : undefined}>{label}</span>; }
function displayOf(row: RecordEnvelope, field: FieldMeta): string { const display = row.display?.[field.name]; if (display) return display; const value = row.values[field.name]; return Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value); }
function dateLabel(value: unknown): string | null { if (!value) return null; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
function dueLabel(value: unknown): { label: string; tone: string } | null { if (!value) return null; const date = new Date(String(value)); if (Number.isNaN(date.getTime())) return null; const today = new Date(); today.setHours(0, 0, 0, 0); date.setHours(0, 0, 0, 0); const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000); return diff < 0 ? { label: 'Overdue', tone: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300' } : diff === 0 ? { label: 'Today', tone: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' } : diff === 1 ? { label: 'Tomorrow', tone: 'bg-brand-100 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300' } : { label: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), tone: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }; }
