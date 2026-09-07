import { type CSSProperties, type JSX, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { createPortal } from 'react-dom';
import type { FieldMeta } from '@ipropy/shared';
import {
  Check, ChevronDown, Loader2, Pencil,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast, useApp } from '../lib/store';
import { cn, deepEqual } from '../lib/utils';
import { Avatar, Badge } from './ui';
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

/**
 * Whether a field can be edited where it is shown.
 *
 * Now gated on an org setting as well as the field's own flags, and that setting
 * ships **off**. Clicking a phone number on the leads list used to turn it into
 * an edit box, which is a lovely feature when you meant it and a way to corrupt
 * a live record when you did not — one stray click on a row you only opened to
 * read. The risk is asymmetric: a mistyped mobile costs a customer, and the
 * saving is one click.
 *
 * Read from the store rather than passed down, because every call site would
 * otherwise have to thread it through, and a call site that forgot would be
 * exactly the hole this closes. Turn it back on in Admin → Settings → Your
 * business.
 */
export function isInlineEditable(field: FieldMeta, surface: 'list' | 'record' = 'record'): boolean {
  if (surface === 'list' && !useApp.getState().user?.ui?.inlineEdit) return false;
  if (field.isReadonly || field.displayType === 'readonly' || field.displayType === 'hidden') return false;
  return !NOT_INLINE_EDITABLE.has(field.uitype);
}

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

type Status = 'idle' | 'saving' | 'success' | 'error';

export interface EditableFieldProps {
  /**
   * Where this field is being drawn.
   *
   * A list and a record page want opposite things. On a list you click a row to
   * open it, and turning a value into an edit box under your cursor is how a
   * live mobile number gets changed by somebody who only meant to read it. On a
   * record page you are already there on purpose, and editing in place is the
   * point of the screen.
   *
   * So the "editing from a list" setting gates `list` only. `record` is always
   * editable, which is why this defaults to it: a new call site should get the
   * behaviour of the screen it is most likely on, not the restriction.
   */
  surface?: 'list' | 'record';
  module: string;
  recordId: string;
  field: FieldMeta;
  value: unknown;
  display?: string;
  compact?: boolean;
  /** dependent-picklist restriction, resolved from the module's picklistDependencies against the record's current values */
  restrictTo?: string[];
  /**
   * The rest of the record's values.
   *
   * Only needed by the controls that own a companion field — a mobile and its
   * country code, an area and its unit. Passing it lets those edit both halves
   * in one popover and save them in one request; omitting it degrades the
   * companion to a read-only prefix/suffix.
   */
  siblings?: Record<string, unknown>;
  /** module of a reference field's target, so its read state can still link through (edit affordance becomes a separate pencil icon) */
  linkTo?: string;
  onSaved?: (value: unknown, display?: string) => void;
}

export function EditableField(props: EditableFieldProps): JSX.Element {
  const {
    module, recordId, field, value, display, compact, restrictTo, siblings, linkTo, onSaved,
    surface = 'record',
  } = props;

  const inlineEdit = useApp((st) => st.user?.ui?.inlineEdit ?? false);
  const [localValue, setLocalValue] = useState(value);
  /** Pending edits to companion fields (country code, area unit), saved with the value. */
  const [otherDraft, setOtherDraft] = useState<Record<string, unknown>>({});
  const [localDisplay, setLocalDisplay] = useState(display);
  const [status, setStatus] = useState<Status>('idle');
  const [flashKey, setFlashKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(value);
  const editRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
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
      const saved = await api.update(module, recordId, { ...otherDraft, [field.name]: next });
      if (commitSeq.current !== seq) return; // superseded by a later edit
      setOtherDraft({});
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
    setOtherDraft({});
    setEditing(true);
  }

  function closeWithoutSaving(): void {
    setEditing(false);
    setDraft(localValue);
    setOtherDraft({});
    restoreFocus();
  }

  function closeAndCommitIfChanged(nextDraft: unknown = draft): void {
    if (field.isMandatory && isEmptyValue(nextDraft)) return; // stay open — inline error is already visible
    setEditing(false);
    // A changed companion field is a change even when the number itself is
    // untouched — switching +91 to +971 has to save.
    if (deepEqual(nextDraft, localValue) && !Object.keys(otherDraft).length) return;
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
      const target = e.target as Node;
      // The editor is portalled to <body>, so "outside" has to mean outside
      // *both* the trigger and the floating panel — testing the trigger alone
      // would treat every click on an option as a dismissal.
      const inside = editRef.current?.contains(target) || panelRef.current?.contains(target);
      if (editRef.current && !inside) {
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

  // Subscribed, not read once: flipping the switch in Admin should take effect
  // without a reload. The exported isInlineEditable reads the same value for
  // callers that only need to decide whether to draw an edit affordance.
  if ((surface === 'list' && !inlineEdit) || !isInlineEditable(field, surface)) {
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
      label={field.label}
      status={status}
      flashKey={flashKey}
      compact={compact}
      invisible={editing && coversValue}
    >
      <FieldValue field={field} value={localValue} display={localDisplay} compact={compact} />
    </EditTrigger>
  );

  return (
    // `editRef` is always attached, not only while editing: it is both the
    // "did the click land inside me" test *and* the box the floating editor
    // measures against. The inner wrapper below cannot serve as that anchor —
    // `display: contents` produces no box at all, so its getBoundingClientRect
    // is all zeros and every popover would open in the top-left corner.
    <div className="relative inline-block" ref={editRef} onClick={(e) => e.stopPropagation()}>
      {/* Always rendered, even mid-edit: it is what reserves the cell's width,
          so opening an editor can't resize a table column and reflow the page. */}
      <div ref={triggerRef} className="contents">{readState}</div>

      {editing && (
        <FloatingEditor
          anchorRef={editRef}
          panelRef={panelRef}
          coversValue={coversValue}
          className={cn(
            kind === 'text' && (field.uitype === 'textarea' || field.uitype === 'richtext'
              ? 'w-72'
              // Two controls side by side (code + number, area + unit) need
              // more than a bare text field's width.
              : field.uitype === 'phone' || (field.uitype === 'area' && field.config.unitField)
                ? 'w-64'
                : compact ? 'w-40' : 'w-52'),
            kind === 'control' && (field.uitype === 'tags' ? 'w-56' : 'w-64'),
          )}
        >
          {kind === 'picklist' ? (
            <PicklistPopover field={field} value={draft as string | null} restrictTo={restrictTo} onPick={pickAndClose} />
          ) : kind === 'owner' ? (
            <OwnerPopover value={draft as string | null} mandatory={field.isMandatory} onPick={pickAndClose} />
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
              formValues={{ ...siblings, ...otherDraft }}
              onChangeOther={siblings ? (name, v) => setOtherDraft((prev) => ({ ...prev, [name]: v })) : undefined}
              error={mandatoryError}
              onCommit={closeAndCommitIfChanged}
            />
          )}
        </FloatingEditor>
      )}
    </div>
  );
}

/**
 * The open editor, painted over the page from a portal.
 *
 * It used to be an absolutely-positioned child of the field, which meant every
 * ancestor with `overflow-hidden` clipped it — and the detail page wraps each
 * section in exactly that, so a picklist near the bottom of a card lost its last
 * options behind the card's edge (list tables did the same horizontally). A
 * portal escapes the clip entirely; the cost is that position must be measured
 * rather than inherited, which is what this does: pin to the trigger, flip above
 * when there isn't room below, and clamp to the viewport on both axes.
 *
 * Re-measures on scroll (capturing, so inner scroll containers count too) and
 * on resize, so the panel tracks the field instead of floating away from it.
 */
function FloatingEditor({
  anchorRef, panelRef, coversValue, className, children,
}: {
  // `| null` because that is the truth: React 19 types `useRef<T>(null)` as
  // `RefObject<T | null>`, and a ref really is null until the element mounts.
  // Both reads below already use `?.`, so nothing changes at runtime — the
  // props were simply claiming a guarantee they never had.
  anchorRef: React.RefObject<HTMLElement | null>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  /** the editor draws its own input box, so it sits *on* the value rather than under it */
  coversValue: boolean;
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  const MARGIN = 8;
  const GAP = 6;
  // Transparent, not hidden, for the one frame before it is measured:
  // `visibility: hidden` makes everything inside unfocusable, so the editor's
  // autoFocus silently did nothing and clicking a field left no cursor in it.
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, opacity: 0 });

  useLayoutEffect(() => {
    const place = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;

      const left = Math.max(
        MARGIN,
        Math.min(anchor.left, window.innerWidth - panel.width - MARGIN),
      );

      let top: number;
      if (coversValue) {
        top = anchor.top + anchor.height / 2 - panel.height / 2;
      } else {
        const below = anchor.bottom + GAP;
        const fitsBelow = below + panel.height <= window.innerHeight - MARGIN;
        const roomAbove = anchor.top - MARGIN;
        top = fitsBelow || roomAbove < panel.height ? below : anchor.top - GAP - panel.height;
      }
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - panel.height - MARGIN));

      setStyle({ position: 'fixed', top, left, zIndex: 50, opacity: 1 });
    };

    place();
    // The panel's own content can settle a frame late (an async options list, a
    // focused input growing), so measure once more after paint.
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef, panelRef, coversValue]);

  return createPortal(
    <div ref={panelRef} style={style} className={cn('max-w-[calc(100vw-1rem)]', className)}>
      {children}
    </div>,
    document.body,
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
 * "T…"). Cells already clip via `.list-cell`'s `whitespace-nowrap`, and
 * FieldValue does its own length-capping in `compact` mode, so neither is
 * this component's job.
 *
 * `invisible` renders it as a size-preserving placeholder while an overlay
 * editor sits on top — that is what keeps the table from reflowing on click.
 */
function EditTrigger({
  onClick, status, flashKey, compact, invisible, label, children,
}: {
  onClick?: () => void;
  status: Status;
  flashKey: number;
  compact?: boolean;
  invisible?: boolean;
  /** The field this edits, so the button can say which one it is. */
  label: string;
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
      /*
        Named for the field, not "Click to edit".

        Every editable value on a record was a button whose only accessible name
        was the tooltip, so a record page presented twenty identical "Click to
        edit" buttons. A screen reader announced the same three words for the
        mobile number, the budget and the pipeline status alike, and the value
        beside it was decoration the button did not claim. Nothing said which
        field was about to open.

        The tooltip stays as it was for a sighted user hovering; the label is
        what anyone not looking at the screen actually gets.
      */
      aria-label={invisible ? undefined : `Edit ${label}`}
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
  field, draft, setDraft, formValues, onChangeOther, error, onCommit,
}: {
  field: FieldMeta;
  draft: unknown;
  setDraft: (v: unknown) => void;
  formValues?: Record<string, unknown>;
  onChangeOther?: (field: string, value: unknown) => void;
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
      <FieldInput
        field={field}
        value={draft}
        onChange={handleChange}
        onChangeOther={onChangeOther}
        formValues={formValues}
        autoFocus
        error={error}
      />
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
    // `listbox`/`option` is what this actually is. A screen reader previously
    // heard a stack of unrelated buttons, and — now the panel is portalled to
    // the end of <body> — "the button that says New" no longer distinguishes an
    // option from a table cell showing the same value.
    <div
      role="listbox"
      aria-label={field.label}
      className="w-max min-w-[12rem] max-w-xs animate-slide-up overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-float dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="max-h-72 overflow-y-auto">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={o.value === value}
            onClick={() => onPick(o.value)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            {/* The option is shown as the chip it will become, not as a dot
                beside plain text. Picking then changes nothing about how the
                value looks — same fill, same type, same box — which is what
                made the old menu feel like it resized the row on every edit. */}
            <Badge color={o.color} className="min-w-0 max-w-full"><span className="truncate">{o.label}</span></Badge>
            {o.value === value && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-brand-600" />}
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
  value, mandatory, onPick,
}: {
  value: string | null;
  mandatory?: boolean;
  onPick: (v: string | null) => void;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<{ id: string; fullName: string }[]>([]);

  useEffect(() => {
    void api.users().then((rows) => setUsers(rows as never)).catch(() => undefined);
  }, []);

  const q = search.trim().toLowerCase();
  const filteredUsers = users.filter((u) => !q || u.fullName.toLowerCase().includes(q));

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
            </span>
            {u.id === value && <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />}
          </button>
        ))}
        {filteredUsers.length === 0 && (
          <p className="px-3 py-4 text-center text-xs text-muted">No matches</p>
        )}
      </div>
    </div>
  );
}
