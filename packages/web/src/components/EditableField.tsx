/**
 * Universal inline editing. Click any editable field's displayed value —
 * in a list table cell, a kanban card, or a record detail page — and change
 * it right there, with no separate edit screen. Every list/detail screen
 * already goes through FieldValue/FieldInput (FieldRenderer.tsx); this sits
 * on top of them and chooses one of four interaction shapes depending on
 * how much commitment a uitype's value warrants:
 *
 *  - instant: `boolean` toggles and saves on a single click.
 *  - inline text: scalars (string, number, currency, date, textarea…) morph
 *    the read value into a bordered input in the same spot; Enter/blur
 *    commits, Escape reverts.
 *  - popover picker: anything chosen from a list (picklist, owner, user,
 *    reference, multipicklist, tags) opens a floating panel. Picking writes
 *    through immediately — there's nothing to "confirm" once you've clicked
 *    an option. Multi-select fields keep the panel open across several picks.
 *  - popover form: `address`/`json` are compound values, so they get an
 *    explicit Save/Cancel instead of autosaving a half-typed edit.
 *
 * Every write is optimistic (the UI updates immediately, closes back to the
 * read state, and the network round-trip happens in the background) with a
 * quiet success/error ring on the field itself — see the pulse-success /
 * pulse-error keyframes in tailwind.config.js. A failed save reverts the
 * value and explains why via toast, rather than silently dropping the edit.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldMeta } from '@ipropy/shared';
import {
  Check, ChevronDown, Loader2, Pencil,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { cn, deepEqual } from '../lib/utils';
import { Avatar } from './ui';
import {
  FieldInput, FieldValue, MultiSelect, ReferencePicker, TagInput,
} from './FieldRenderer';

const NOT_INLINE_EDITABLE: ReadonlySet<string> = new Set([
  // Computed/generated — nothing to write.
  'autonumber', 'formula', 'rollup',
  // Has its own dedicated multi-file uploader (GalleryField) that needs more
  // room than an inline cell/popover can offer.
  'image',
  // No working editor exists for this uitype anywhere in the app today (not
  // even the full record-edit form) — no module currently uses it either.
  'multireference',
]);

/** Uitypes whose read display (FieldValue) renders an <a>/Link of its own — see the render branch below for why that rules out wrapping the whole thing in a <button>. */
const HAS_OWN_LINK: ReadonlySet<string> = new Set(['reference', 'email', 'phone', 'url']);

export function isInlineEditable(field: FieldMeta): boolean {
  if (field.isReadonly || field.displayType === 'readonly' || field.displayType === 'hidden') return false;
  return !NOT_INLINE_EDITABLE.has(field.uitype);
}

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

type Status = 'idle' | 'saving' | 'success' | 'error';

export interface EditableFieldProps {
  module: string;
  recordId: string;
  field: FieldMeta;
  value: unknown;
  display?: string;
  compact?: boolean;
  /** dependent-picklist restriction, resolved from the module's picklistDependencies against the record's current values */
  restrictTo?: string[];
  /** module of a reference field's target, so its read state can still link through (edit affordance becomes a separate pencil icon) */
  linkTo?: string;
  onSaved?: (value: unknown, display?: string) => void;
}

export function EditableField(props: EditableFieldProps): JSX.Element {
  const {
    module, recordId, field, value, display, compact, restrictTo, linkTo, onSaved,
  } = props;

  const [localValue, setLocalValue] = useState(value);
  const [localDisplay, setLocalDisplay] = useState(display);
  const [status, setStatus] = useState<Status>('idle');
  const [flashKey, setFlashKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(value);
  const editRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const commitSeq = useRef(0);

  /** Put focus back on the trigger after closing, so Tab order isn't lost. */
  const restoreFocus = (): void => {
    queueMicrotask(() => triggerRef.current?.querySelector('button')?.focus());
  };

  // Adopt the server value when it changes from outside (another user's
  // edit, a refetch) — but never while mid-edit, so we don't yank an input
  // out from under someone who's actively typing.
  useEffect(() => {
    if (editing) return;
    setLocalValue(value);
    setLocalDisplay(display);
  }, [value, display, editing]);

  async function commit(next: unknown, previous: unknown): Promise<void> {
    const seq = ++commitSeq.current;
    setStatus('saving');
    try {
      const saved = await api.update(module, recordId, { [field.name]: next });
      if (commitSeq.current !== seq) return; // superseded by a later edit
      const savedValue = saved.values[field.name];
      const savedDisplay = saved.display?.[field.name];
      setLocalValue(savedValue);
      setLocalDisplay(savedDisplay);
      setStatus('success');
      setFlashKey((k) => k + 1);
      onSaved?.(savedValue, savedDisplay);
    } catch (err) {
      if (commitSeq.current !== seq) return;
      setLocalValue(previous);
      setStatus('error');
      setFlashKey((k) => k + 1);
      toast.error(`Could not update ${field.label}`, (err as Error).message);
    }
  }

  useEffect(() => {
    if (status !== 'success' && status !== 'error') return;
    const t = setTimeout(() => setStatus('idle'), status === 'success' ? 900 : 2600);
    return () => clearTimeout(t);
  }, [status, flashKey]);

  function openEdit(): void {
    if (status === 'saving') return;
    setDraft(localValue);
    setEditing(true);
  }

  function closeWithoutSaving(): void {
    setEditing(false);
    setDraft(localValue);
    restoreFocus();
  }

  function closeAndCommitIfChanged(nextDraft: unknown = draft): void {
    if (field.isMandatory && isEmptyValue(nextDraft)) return; // stay open — inline error is already visible
    setEditing(false);
    if (deepEqual(nextDraft, localValue)) return;
    const previous = localValue;
    setLocalValue(nextDraft);
    void commit(nextDraft, previous);
  }

  /** A pick from a single-value popover (picklist/owner/reference): apply, close, save in the background. */
  function pickAndClose(next: unknown): void {
    setDraft(next);
    setEditing(false);
    if (deepEqual(next, localValue)) return;
    const previous = localValue;
    setLocalValue(next);
    void commit(next, previous);
  }

  /** A toggle inside a multi-value popover (multipicklist/tags): apply and save, but keep the panel open. */
  function pickAndStayOpen(next: unknown): void {
    setDraft(next);
    if (deepEqual(next, localValue)) return;
    const previous = localValue;
    setLocalValue(next);
    void commit(next, previous);
  }

  useEffect(() => {
    if (!editing) return;
    const onDocClick = (e: MouseEvent): void => {
      if (editRef.current && !editRef.current.contains(e.target as Node)) {
        // Address/JSON are compound, explicit-save values — a stray outside
        // click shouldn't half-commit a partial edit.
        if (field.uitype === 'address' || field.uitype === 'json') closeWithoutSaving();
        else closeAndCommitIfChanged();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); closeWithoutSaving(); }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draft, localValue]);

  if (!isInlineEditable(field)) {
    return <FieldValue field={field} value={localValue} display={localDisplay} compact={compact} />;
  }

  // --- instant: boolean --------------------------------------------------
  if (field.uitype === 'boolean') {
    return (
      <StatusRing key={flashKey} status={status}>
        <button
          type="button"
          role="switch"
          aria-label={field.label}
          aria-checked={Boolean(localValue)}
          disabled={status === 'saving'}
          onClick={(e) => {
            e.stopPropagation();
            const next = !localValue;
            const previous = localValue;
            setLocalValue(next);
            void commit(next, previous);
          }}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60',
            localValue ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-700',
          )}
        >
          <span className={cn(
            'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
            localValue ? 'translate-x-4' : 'translate-x-0',
          )} />
        </button>
        {status === 'saving' && <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-slate-400" />}
      </StatusRing>
    );
  }

  const mandatoryError = editing && field.isMandatory && isEmptyValue(draft) ? `${field.label} is required` : undefined;
  const kind = editorKind(field);
  // Controls that draw their own input-looking box (a text input, a combobox)
  // would read as a duplicate sitting next to the value, so they cover it.
  // Bare dropdown panels have nothing to duplicate and hang below it instead.
  const coversValue = kind === 'text' || kind === 'control';

  const readState = HAS_OWN_LINK.has(field.uitype) ? (
    // FieldValue renders an <a> for these (mailto:/tel:/href, or a reference
    // Link) — nesting that inside a <button> would be invalid,
    // interactive-in-interactive HTML that silently breaks in browsers.
    // Keep the link itself a plain click, and put editing behind its own
    // small affordance instead of swallowing the click into it.
    <StatusRing key={flashKey} status={status}>
      <span className={cn('group/ef -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5', editing && coversValue && 'invisible')}>
        <FieldValue field={field} value={localValue} display={localDisplay} compact={compact} linkTo={linkTo} />
        {status === 'saving' ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-slate-400" />
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openEdit(); }}
            title="Change"
            className="shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition-opacity hover:text-slate-500 group-hover/ef:opacity-100 dark:hover:text-slate-300"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </span>
    </StatusRing>
  ) : (
    <EditTrigger
      onClick={openEdit}
      status={status}
      flashKey={flashKey}
      compact={compact}
      invisible={editing && coversValue}
    >
      <FieldValue field={field} value={localValue} display={localDisplay} compact={compact} />
    </EditTrigger>
  );

  return (
    <div className="relative inline-block" ref={editing ? editRef : undefined} onClick={(e) => e.stopPropagation()}>
      {/* Always rendered, even mid-edit: it is what reserves the cell's width,
          so opening an editor can't resize a table column and reflow the page. */}
      <div ref={triggerRef} className="contents">{readState}</div>

      {editing && (
        <div
          className={cn(
            // Absolute so the editor is painted over the layout rather than
            // participating in it — the row keeps its exact geometry.
            'absolute left-0 z-40',
            coversValue ? 'top-1/2 -translate-y-1/2' : 'top-full mt-1.5',
            kind === 'text' && (field.uitype === 'textarea' || field.uitype === 'richtext'
              ? 'w-72'
              : compact ? 'w-40' : 'w-52'),
            kind === 'control' && (field.uitype === 'tags' ? 'w-56' : 'w-64'),
          )}
        >
          {kind === 'picklist' ? (
            <PicklistPopover field={field} value={draft as string | null} restrictTo={restrictTo} onPick={pickAndClose} />
          ) : kind === 'owner' ? (
            <OwnerPopover value={draft as string | null} allowGroups={field.uitype === 'owner'} mandatory={field.isMandatory} onPick={pickAndClose} />
          ) : kind === 'form' ? (
            <div className="w-80 animate-slide-up space-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-float dark:border-slate-700 dark:bg-slate-900">
              <FieldInput field={field} value={draft} onChange={setDraft} autoFocus error={mandatoryError} />
              {mandatoryError && <p className="text-2xs text-negative">{mandatoryError}</p>}
              <div className="flex justify-end gap-1.5 pt-0.5">
                <button type="button" className="btn-ghost btn-sm" onClick={closeWithoutSaving}>Cancel</button>
                <button type="button" className="btn-primary btn-sm" onClick={() => closeAndCommitIfChanged()}>Save</button>
              </div>
            </div>
          ) : field.uitype === 'reference' ? (
            <ReferencePicker
              field={field}
              value={draft as string | null}
              autoOpen
              onOpenChange={(open) => { if (!open) setEditing(false); }}
              onChange={pickAndClose}
            />
          ) : field.uitype === 'multipicklist' ? (
            <MultiSelect options={field.options ?? []} value={(draft as string[]) ?? []} onChange={pickAndStayOpen} />
          ) : field.uitype === 'tags' ? (
            <TagInput value={(draft as string[]) ?? []} onChange={pickAndStayOpen} />
          ) : (
            <InlineTextEditor
              field={field}
              draft={draft}
              setDraft={setDraft}
              error={mandatoryError}
              onCommit={closeAndCommitIfChanged}
            />
          )}
        </div>
      )}
    </div>
  );
}

type EditorKind = 'picklist' | 'owner' | 'form' | 'control' | 'text';

function editorKind(field: FieldMeta): EditorKind {
  switch (field.uitype) {
    case 'picklist': return 'picklist';
    case 'owner': case 'user': return 'owner';
    case 'address': case 'json': return 'form';
    case 'reference': case 'multipicklist': case 'tags': return 'control';
    default: return 'text';
  }
}

// ---------------------------------------------------------------------------

function StatusRing({ status, children }: { status: Status; children: React.ReactNode }): JSX.Element {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full',
      status === 'success' && 'animate-pulse-success',
      status === 'error' && 'animate-pulse-error',
    )}>
      {children}
    </span>
  );
}

/**
 * Deliberately plain geometry: `inline-flex` sized to its content, and
 * nothing that constrains width. An earlier version wrapped the value in a
 * `truncate` span and capped the button at `max-w-full` — both are layout
 * poison here. `truncate` sets `overflow:hidden`, which per the flexbox spec
 * drops a flex item's `min-width` from `auto` to `0`, so the value could
 * shrink to nothing; `max-w-full` inside an auto-layout `<table>` then let
 * every column resolve to that new near-zero minimum ("Test" rendered as
 * "T…"). Cells already clip via `.table-cell`'s `whitespace-nowrap`, and
 * FieldValue does its own length-capping in `compact` mode, so neither is
 * this component's job.
 *
 * `invisible` renders it as a size-preserving placeholder while an overlay
 * editor sits on top — that is what keeps the table from reflowing on click.
 */
function EditTrigger({
  onClick, status, flashKey, compact, invisible, children,
}: {
  onClick?: () => void;
  status: Status;
  flashKey: number;
  compact?: boolean;
  invisible?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      key={flashKey}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      disabled={status === 'saving' || invisible}
      tabIndex={invisible ? -1 : undefined}
      aria-hidden={invisible}
      title={invisible ? undefined : 'Click to edit'}
      className={cn(
        'group/ef -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-left transition-colors',
        invisible
          ? 'invisible'
          : 'hover:bg-slate-100 disabled:cursor-wait dark:hover:bg-slate-800/70',
        !invisible && status === 'success' && 'animate-pulse-success',
        !invisible && status === 'error' && 'animate-pulse-error',
      )}
    >
      {children}
      {status === 'saving'
        ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-slate-400" />
        : <ChevronDown className={cn('h-3 w-3 shrink-0 text-slate-300 opacity-0 transition-opacity group-hover/ef:opacity-100', compact && 'hidden sm:inline')} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inline text-swap — scalars, dates, currency, textarea/richtext
// ---------------------------------------------------------------------------

function InlineTextEditor({
  field, draft, setDraft, error, onCommit,
}: {
  field: FieldMeta;
  draft: unknown;
  setDraft: (v: unknown) => void;
  error?: string;
  onCommit: (draft: unknown) => void;
}): JSX.Element {
  const isMultiline = field.uitype === 'textarea' || field.uitype === 'richtext';
  const committedRef = useRef(false);
  // CurrencyInput (and potentially other sub-editors) buffers what the user
  // types locally and only calls onChange once, already-parsed, from its own
  // onBlur — which fires in the same synchronous event-bubble phase as the
  // blur handler below, just before it. Reading `draft` there would race: the
  // setDraft call from that onChange is a batched React update, not yet
  // reflected in this closure's `draft`. A ref mirror updated synchronously
  // in the same handler sidesteps the race entirely.
  const draftRef = useRef(draft);
  const handleChange = (v: unknown): void => {
    draftRef.current = v;
    setDraft(v);
  };

  const commitOnce = (): void => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(draftRef.current);
  };

  return (
    <div
      // Width comes from the absolutely-positioned wrapper in EditableField;
      // the shadow lifts the editor off whatever value it is covering.
      className="relative rounded-lg shadow-float"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) commitOnce();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (isMultiline ? (e.metaKey || e.ctrlKey) : true)) {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
          commitOnce();
        }
      }}
    >
      <FieldInput field={field} value={draft} onChange={handleChange} autoFocus error={error} />
      {error && <p className="mt-1 text-2xs text-negative">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Picklist popover — coloured option list instead of a native <select>
// ---------------------------------------------------------------------------

function PicklistPopover({
  field, value, restrictTo, onPick,
}: {
  field: FieldMeta;
  value: string | null;
  restrictTo?: string[];
  onPick: (v: string | null) => void;
}): JSX.Element {
  const options = useMemo(() => {
    const all = (field.options ?? []).filter((o) => o.isActive || o.value === value);
    return restrictTo?.length ? all.filter((o) => restrictTo.includes(o.value)) : all;
  }, [field.options, restrictTo, value]);

  return (
    <div className="w-max min-w-[12rem] max-w-xs animate-slide-up overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-float dark:border-slate-700 dark:bg-slate-900">
      <div className="max-h-72 overflow-y-auto">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onPick(o.value)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: o.color ?? '#94a3b8' }} />
            <span className="flex-1 truncate">{o.label}</span>
            {o.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
          </button>
        ))}
        {options.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted">No options</p>}
      </div>
      {!field.isMandatory && (
        <>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <button
            type="button"
            onClick={() => onPick(null)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-slate-300 dark:border-slate-600" />
            Clear
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Owner/user popover — searchable people list instead of a native <select>
// ---------------------------------------------------------------------------

function OwnerPopover({
  value, allowGroups, mandatory, onPick,
}: {
  value: string | null;
  allowGroups?: boolean;
  mandatory?: boolean;
  onPick: (v: string | null) => void;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<{ id: string; fullName: string; designation?: string }[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    void api.users().then((rows) => setUsers(rows as never)).catch(() => undefined);
    if (allowGroups) void api.groups().then((rows) => setGroups(rows as never)).catch(() => undefined);
  }, [allowGroups]);

  const q = search.trim().toLowerCase();
  const filteredUsers = users.filter((u) => !q || u.fullName.toLowerCase().includes(q));
  const filteredGroups = groups.filter((g) => !q || g.name.toLowerCase().includes(q));

  return (
    <div className="w-64 animate-slide-up overflow-hidden rounded-xl border border-slate-200 bg-white shadow-float dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-100 p-2 dark:border-slate-800">
        <input
          className="input py-1 text-xs"
          placeholder="Search people…"
          value={search}
          autoFocus
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {!mandatory && (
          <button
            type="button"
            onClick={() => onPick(null)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Unassigned
          </button>
        )}
        {filteredGroups.length > 0 && (
          <p className="px-3 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">Teams</p>
        )}
        {filteredGroups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onPick(g.id)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Avatar name={g.name} size={20} />
            <span className="flex-1 truncate">{g.name}</span>
            {g.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
          </button>
        ))}
        {filteredGroups.length > 0 && filteredUsers.length > 0 && (
          <p className="px-3 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">People</p>
        )}
        {filteredUsers.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => onPick(u.id)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Avatar name={u.fullName} size={20} />
            <span className="flex-1 truncate">
              {u.fullName}
              {u.designation && <span className="text-muted"> · {u.designation}</span>}
            </span>
            {u.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
          </button>
        ))}
        {filteredUsers.length === 0 && filteredGroups.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-muted">No matches</p>
        )}
      </div>
    </div>
  );
}
