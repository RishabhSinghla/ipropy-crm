import { type JSX, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { type FieldMeta, type FilterGroup, type FilterOperator, NULLARY_OPERATORS, UITYPE_LIST } from '@ipropy/shared';
import { ChevronDown, ChevronUp, Copy, Edit3, Eye, EyeOff, GripVertical, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, ConfirmDialog, Modal, Select, Skeleton, Spinner, Toggle } from '../../components/ui';
import { ModuleIcon } from '../../components/Layout';

export default function ModuleBuilder(): JSX.Element {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editingField, setEditingField] = useState<FieldMeta | null>(null);
  const [creatingField, setCreatingField] = useState(false);
  const [creatingModule, setCreatingModule] = useState(false);
  // Two different destructive actions, so the dialog has to know which one.
  // "hide" is reversible and keeps the data; "delete" drops the column.
  const [pendingRemoval, setPendingRemoval] = useState<{ field: FieldMeta; mode: 'hide' | 'delete' } | null>(null);
  // Sections used to be editable only in the Layout Designer, which edits a
  // layout and not the section — so one deleted there stayed in this list, and
  // in the Section dropdown, for ever. This is where a section actually lives.
  const [pendingSection, setPendingSection] = useState<{ id: string; label: string } | null>(null);
  const [renamingSection, setRenamingSection] = useState<{ id: string; label: string } | null>(null);
  const [creatingSection, setCreatingSection] = useState(false);

  const { data: fieldModules = [], isLoading: isModulesLoading } = useQuery({
    queryKey: ['field-modules'],
    queryFn: () => api.fieldModules(),
  });
  // Dropdown labels (not their stable keys) are what the list prints beside a
  // picklist field — an admin renames the label and the list must follow.
  const { data: picklistCatalogue } = useQuery({
    queryKey: ['picklist-catalogue'],
    queryFn: () => api.picklistCatalogue(),
  });
  const requestedModule = searchParams.get('module');
  const selectedModule = requestedModule && fieldModules.some((m) => m.name === requestedModule)
    ? requestedModule
    : (fieldModules[0]?.name ?? '');

  const selectModule = (name: string): void => {
    const next = new URLSearchParams(searchParams);
    next.set('module', name);
    setSearchParams(next, { replace: true });
  };

  // Distinct query key from the app-wide ['module', name] used by record
  // screens: this one includes hidden/inactive fields so they can be found
  // and re-enabled, which those screens must never see.
  const { data: meta, isLoading } = useQuery({
    queryKey: ['module', selectedModule, 'builder'],
    queryFn: () => api.module(selectedModule, { includeInactive: true }),
    enabled: Boolean(selectedModule),
  });

  const invalidateModule = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['module', selectedModule, 'builder'] });
    void queryClient.invalidateQueries({ queryKey: ['module', selectedModule] });
    void queryClient.invalidateQueries({ queryKey: ['field-modules'] });
  };

  const deleteMutation = useMutation({
    mutationFn: ({ id, permanent }: { id: string; permanent: boolean }) => api.deleteField(id, permanent),
    onSuccess: (result) => {
      const r = result as { deactivated?: boolean; hadValues?: number };
      toast.success(
        r.deactivated ? 'Field hidden' : 'Field deleted',
        r.deactivated
          ? 'It is off every screen but its data is intact — restore it any time.'
          : r.hadValues
            ? `Removed along with ${r.hadValues} stored value(s).`
            : undefined,
      );
      invalidateModule();
    },
    onError: (err: Error) => toast.error('Could not remove the field', err.message),
  });

  const sectionMutation = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => api.updateBlock(id, { label }),
    onSuccess: () => { toast.success('Section renamed'); invalidateModule(); },
    onError: (err: Error) => toast.error('Could not rename the section', err.message),
  });

  const deleteSectionMutation = useMutation({
    mutationFn: (id: string) => api.deleteBlock(id),
    onSuccess: () => {
      toast.success('Section deleted', 'It is off this page, the Section dropdown and every layout.');
      invalidateModule();
      void queryClient.invalidateQueries({ queryKey: ['layouts'] });
    },
    onError: (err: Error) => toast.error('Could not delete the section', err.message),
  });

  const addSectionMutation = useMutation({
    mutationFn: (label: string) => {
      // The name is an identifier, not the heading — the API needs at least two
      // characters of one, so a section called "X" falls back to a made-up name
      // rather than being refused with a regular expression.
      const derived = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      const name = /^[a-z][a-z0-9_]{1,40}$/.test(derived) ? derived : `section_${Date.now().toString(36)}`;
      return api.createBlock(selectedModule, { name, label });
    },
    onSuccess: () => { toast.success('Section added'); invalidateModule(); },
    onError: (err: Error) => toast.error('Could not add the section', err.message),
  });

  /*
    Moving a field: up, down, or into another section, from the row itself.

    `POST /api/meta/fields/reorder` has existed since the layout designer was
    written and has never been called by anything — the designer edits a layout,
    which is a different object, and leaves ipy_field.sequence untouched. So the
    order on this page could not be changed from this page at all.

    Buttons rather than drag: this list runs to thirty-odd rows, dragging one to
    the far end of a scrolling page is miserable, and a drag handle is unusable
    by keyboard. The whole block is sent each time so the sequence numbers come
    out contiguous rather than drifting apart with every move.
  */
  const reorderMutation = useMutation({
    mutationFn: (fields: { id: string; blockId: string; sequence: number }[]) => api.reorderFields(fields),
    onSuccess: () => invalidateModule(),
    onError: (err: Error) => toast.error('Could not move the field', err.message),
  });

  const moveField = (blockId: string, fields: FieldMeta[], index: number, delta: number): void => {
    const next = [...fields];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorderMutation.mutate(next.map((f, i) => ({ id: f.id, blockId, sequence: i })));
  };

  /*
    Drag a field wherever it goes — the arrows this replaces asked for the same
    move one click at a time, and "somewhere near the bottom" was a dozen of
    them. Native HTML5 drag: no dependency, works with a mouse everywhere the
    panel runs. The arrows stay for one step at a time and for keyboards.
  */
  const [dragField, setDragField] = useState<{ field: FieldMeta; blockId: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const dropFieldOnto = (blockId: string, fields: FieldMeta[], targetIndex: number): void => {
    if (!dragField) return;
    const moving = dragField.field;
    const sameBlock = dragField.blockId === blockId;
    const list = sameBlock ? [...fields] : [...fields, moving];
    const from = list.findIndex((f) => f.id === moving.id);
    if (from === -1) return;
    // Remove, then clamp — dropping below where the row came from lands on the
    // row it was pushed past, not one further down.
    list.splice(from, 1);
    const insertAt = Math.max(0, Math.min(targetIndex, list.length));
    list.splice(insertAt, 0, moving);
    reorderMutation.mutate(list.map((f, i) => ({ id: f.id, blockId, sequence: i })));
    setDragField(null);
    setDragOver(null);
  };

  const moveToSection = (field: FieldMeta, blockId: string): void => {
    if (!blockId || blockId === field.blockId) return;
    const destination = meta?.blocks.find((b) => b.id === blockId);
    // Appended to the end of the destination, which is where somebody moving a
    // field expects to find it.
    reorderMutation.mutate([
      { id: field.id, blockId, sequence: destination?.fields.length ?? 0 },
    ]);
  };

  const unhideMutation = useMutation({
    mutationFn: (id: string) => api.updateField(id, { isActive: true }),
    onSuccess: () => {
      toast.success('Field restored');
      invalidateModule();
    },
    onError: (err: Error) => toast.error('Could not restore the field', err.message),
  });
  const duplicateMutation = useMutation({
    mutationFn: (id: string) => api.duplicateField(id),
    onSuccess: () => { toast.success('Field duplicated'); invalidateModule(); },
    onError: (err: Error) => toast.error('Could not duplicate the field', err.message),
  });

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Modules & Fields</h1>
          <p className="text-sm text-muted">
            Add, edit, remove or restore fields on any module. Changes apply everywhere immediately.
          </p>
        </div>
        <button onClick={() => setCreatingModule(true)} className="btn-primary btn-sm ml-auto">
          <Plus className="h-3.5 w-3.5" /> New module
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        {/* Module list */}
        <div className="card h-fit overflow-hidden">
          <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <p className="text-xs font-medium text-muted">Modules</p>
          </div>
          <div className="max-h-[32rem] overflow-y-auto p-1.5">
            {isModulesLoading && Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="mb-1 h-8" />
            ))}
            {fieldModules.map((m) => (
              <button
                key={m.name}
                onClick={() => selectModule(m.name)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                  selectedModule === m.name
                    ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                    : 'text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800',
                )}
              >
                <span style={{ color: m.color }}><ModuleIcon name={m.icon} /></span>
                <span className="flex-1 truncate">{m.label}</span>
                {m.isCustom && <Badge>Custom</Badge>}
                {!m.isActive && <Badge color="#ef4444">Disabled</Badge>}
              </button>
            ))}
          </div>
        </div>

        {/* Fields */}
        <div className="card overflow-hidden">
          {isLoading || !meta ? (
            <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
                <span style={{ color: meta.color }}><ModuleIcon name={meta.icon} /></span>
                <p className="text-sm font-medium">{meta.label}</p>
                <span className="text-2xs text-muted tnum">
                  {meta.fields.length} fields · {meta.blocks.length} blocks
                </span>
                <button
                  onClick={() => setCreatingSection(true)}
                  className="btn-secondary btn-sm ml-auto"
                >
                  <Plus className="h-3.5 w-3.5" /> Add section
                </button>
                <button onClick={() => setCreatingField(true)} className="btn-primary btn-sm">
                  <Plus className="h-3.5 w-3.5" /> Add field
                </button>
              </div>

              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {meta.blocks.map((block) => (
                  <div key={block.id}>
                    <div className="flex items-center gap-2 bg-slate-50/60 px-4 py-1.5 dark:bg-slate-800/40">
                      <p className="flex-1 truncate text-2xs font-semibold uppercase tracking-wide text-muted">
                        {block.label}
                      </p>
                      <button
                        onClick={() => setRenamingSection({ id: block.id, label: block.label })}
                        className="btn-ghost btn-sm px-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        title="Rename this section"
                        aria-label={`Rename section ${block.label}`}
                      >
                        <Edit3 className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => setPendingSection({ id: block.id, label: block.label })}
                        className="btn-ghost btn-sm px-1.5 text-slate-400 hover:text-red-600"
                        title="Delete this section"
                        aria-label={`Delete section ${block.label}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    {block.fields.map((field, fieldIndex) => (
                      <div
                        key={field.id}
                        draggable
                        onDragStart={(e) => {
                          setDragField({ field, blockId: block.id });
                          e.dataTransfer.effectAllowed = 'move';
                          // Firefox refuses a drag with no data set on it.
                          e.dataTransfer.setData('text/plain', field.id);
                        }}
                        onDragEnd={() => { setDragField(null); setDragOver(null); }}
                        onDragOver={(e) => {
                          if (!dragField) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          setDragOver(field.id);
                        }}
                        onDragLeave={() => setDragOver((cur) => (cur === field.id ? null : cur))}
                        onDrop={(e) => {
                          e.preventDefault();
                          dropFieldOnto(block.id, block.fields, fieldIndex);
                        }}
                        className={cn(
                          'flex items-center gap-3 px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/40',
                          dragField?.field.id === field.id && 'opacity-40',
                          dragOver === field.id && dragField && 'border-t-2 border-brand-500',
                        )}
                      >
                        {/* The drag handle says "grab me"; a cursor alone does
                            not, and half the discoverability of drag is the
                            handle. The arrows stay beside it: one step at a
                            time still beats drag for a single move, and it is
                            the keyboard path. */}
                        <span
                          className="shrink-0 cursor-grab text-slate-300 transition-colors hover:text-brand-600 active:cursor-grabbing dark:text-slate-600"
                          title="Drag to move"
                          aria-hidden
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </span>
                        <div className="flex shrink-0 flex-col">
                          <button
                            onClick={() => moveField(block.id, block.fields, fieldIndex, -1)}
                            disabled={fieldIndex === 0 || reorderMutation.isPending}
                            className="text-slate-300 transition-colors hover:text-brand-600 disabled:opacity-30 disabled:hover:text-slate-300 dark:text-slate-600"
                            title="Move up"
                            aria-label={`Move ${field.label} up`}
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => moveField(block.id, block.fields, fieldIndex, 1)}
                            disabled={fieldIndex === block.fields.length - 1 || reorderMutation.isPending}
                            className="text-slate-300 transition-colors hover:text-brand-600 disabled:opacity-30 disabled:hover:text-slate-300 dark:text-slate-600"
                            title="Move down"
                            aria-label={`Move ${field.label} down`}
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">{field.label}</span>
                            {field.isMandatory && <span className="text-negative">*</span>}
                            {field.isCustom && <Badge color="#6366f1">Custom</Badge>}
                            {!field.isActive && <Badge color="#94a3b8">Inactive</Badge>}
                            {field.displayType === 'hidden' && <Badge color="#94a3b8">Hidden</Badge>}
                          </div>
                          <p className="mt-0.5 font-mono text-2xs text-muted">
                            {field.name} · {field.uitype}
                            {field.config.picklist
                              ? ` (${picklistCatalogue?.find((p) => p.name === field.config.picklist)?.label ?? field.config.picklist})`
                              : ''}
                            {field.config.referenceModules ? ` → ${(field.config.referenceModules as string[]).join('/')}` : ''}
                          </p>
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {/* Which section this field sits in, changed from here
                              rather than by opening the editor. Only shown when
                              there is somewhere else for it to go. */}
                          {(meta?.blocks.length ?? 0) > 1 && (
                            <select
                              value={field.blockId ?? ''}
                              onChange={(e) => moveToSection(field, e.target.value)}
                              disabled={reorderMutation.isPending}
                              aria-label={`Section for ${field.label}`}
                              title="Move to another section"
                              className="input h-7 max-w-[9rem] px-1.5 py-0 text-2xs"
                            >
                              {meta?.blocks.map((b) => (
                                <option key={b.id} value={b.id}>{b.label}</option>
                              ))}
                            </select>
                          )}
                          <button
                            onClick={() => setEditingField(field)}
                            className="btn-ghost btn-sm gap-1 px-2"
                            title="Edit field"
                            aria-label={`Edit ${field.label}`}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span className="hidden xl:inline">Edit</span>
                          </button>
                          <button
                            onClick={() => duplicateMutation.mutate(field.id)}
                            disabled={duplicateMutation.isPending}
                            className="btn-ghost btn-sm gap-1 px-2"
                            title="Duplicate this field setup"
                            aria-label={`Duplicate ${field.label}`}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            <span className="hidden xl:inline">Duplicate</span>
                          </button>
                          {/* Hide and Delete are separate answers to separate
                              questions — "not on my screens" and "gone". They
                              used to be one button whose meaning depended on
                              whether the field happened to be custom, which is
                              not something an administrator should have to know. */}
                          {!field.isActive ? (
                            <button
                              onClick={() => unhideMutation.mutate(field.id)}
                              disabled={unhideMutation.isPending}
                              className="btn-ghost btn-sm gap-1 px-2 text-slate-400 hover:text-emerald-600"
                              title="Show field again"
                              aria-label={`Restore ${field.label}`}
                            >
                              <Eye className="h-3.5 w-3.5" />
                              <span className="hidden xl:inline">Restore</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => setPendingRemoval({ field, mode: 'hide' })}
                              className="btn-ghost btn-sm gap-1 px-2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                              title="Take off every screen, keeping the data"
                              aria-label={`Hide ${field.label}`}
                            >
                              <EyeOff className="h-3.5 w-3.5" />
                              <span className="hidden xl:inline">Hide</span>
                            </button>
                          )}
                          <button
                            onClick={() => setPendingRemoval({ field, mode: 'delete' })}
                            className="btn-ghost btn-sm gap-1 px-2 text-slate-400 hover:text-red-600"
                            title="Delete the field and its data permanently"
                            aria-label={`Delete ${field.label}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="hidden xl:inline">Delete</span>
                          </button>
                        </div>
                      </div>
                    ))}
                    {block.fields.length === 0 && (
                      <p className="px-4 py-3 text-xs text-muted">
                        Nothing in this section yet — drop a field into it, or delete it.
                      </p>
                    )}
                    {/* The end of the list is a drop zone too: "move to the
                        bottom" should not need pixel aim at the last row. */}
                    <div
                      onDragOver={(e) => { if (dragField) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
                      onDrop={(e) => { e.preventDefault(); dropFieldOnto(block.id, block.fields, block.fields.length); }}
                      className={cn(
                        'h-2 transition-colors',
                        dragField && 'hover:bg-brand-100 dark:hover:bg-brand-900/50',
                      )}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {(creatingField || editingField) && meta && (
        <FieldEditor
          module={meta}
          field={editingField}
          onClose={() => { setCreatingField(false); setEditingField(null); }}
          onSaved={() => {
            setCreatingField(false);
            setEditingField(null);
            invalidateModule();
          }}
        />
      )}

      {creatingModule && (
        <ModuleCreator
          onClose={() => setCreatingModule(false)}
          onCreated={(name) => {
            setCreatingModule(false);
            selectModule(name);
            toast.success('Module created', 'Reload to see it in the sidebar.');
            void queryClient.invalidateQueries({ queryKey: ['modules'] });
            void queryClient.invalidateQueries({ queryKey: ['field-modules'] });
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(pendingSection)}
        onClose={() => setPendingSection(null)}
        onConfirm={() => deleteSectionMutation.mutateAsync(pendingSection!.id)}
        title={`Delete the “${pendingSection?.label}” section?`}
        body="The section comes off this page, off the Section dropdown and off every layout that used it. Fields are never deleted with it — a section still holding fields is refused until you have moved them."
        confirmLabel="Delete section"
        danger
      />

      {renamingSection && (
        <SectionRenamer
          title="Rename section"
          cta="Save"
          label={renamingSection.label}
          onClose={() => setRenamingSection(null)}
          onSave={(label) => {
            sectionMutation.mutate({ id: renamingSection.id, label });
            setRenamingSection(null);
          }}
        />
      )}

      {creatingSection && (
        <SectionRenamer
          title="New section"
          cta="Create section"
          label=""
          onClose={() => setCreatingSection(false)}
          onSave={(label) => {
            addSectionMutation.mutate(label);
            setCreatingSection(false);
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(pendingRemoval)}
        onClose={() => setPendingRemoval(null)}
        onConfirm={() => deleteMutation.mutateAsync({
          id: pendingRemoval!.field.id,
          permanent: pendingRemoval!.mode === 'delete',
        })}
        title={pendingRemoval?.mode === 'delete'
          ? `Delete “${pendingRemoval.field.label}” permanently?`
          : `Hide “${pendingRemoval?.field.label}”?`}
        body={pendingRemoval?.mode === 'delete'
          ? 'The field, every value stored in it, and its place in any view or layout are all removed. This cannot be undone — and it stays deleted when the app is next updated.'
          : 'The field comes off every screen but keeps its data, and you can restore it from this page at any time.'}
        confirmLabel={pendingRemoval?.mode === 'delete' ? 'Delete permanently' : 'Hide'}
        danger
      />
    </div>
  );
}

/** Rename a section without leaving the page it lives on. */
function SectionRenamer({
  label, onClose, onSave, title = 'Rename section', cta = 'Save',
}: {
  label: string; onClose: () => void; onSave: (label: string) => void;
  title?: string; cta?: string;
}): JSX.Element {
  const [value, setValue] = useState(label);
  const ready = value.trim().length > 0 && value.trim() !== label;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!ready}
            onClick={() => onSave(value.trim())}
          >
            {cta}
          </button>
        </>
      }
    >
      <label className="label" htmlFor="section-label">Section name</label>
      <input
        id="section-label"
        className="input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && ready) onSave(value.trim()); }}
        autoFocus
      />
      <p className="mt-1.5 text-2xs text-muted">
        This is the heading above the fields on every record page and form.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Field rules
//
// Every rule below was already enforced by the engine — `collectFieldErrors` in
// shared runs them on the form and the API alike, and `evaluateFilter` decides
// visibility. None of it could be *set* without editing seed code, so a field an
// admin created was always a plain box. This is the missing half.
// ---------------------------------------------------------------------------

/**
 * What each field type actually does, in the words somebody picking one would use.
 *
 * The dropdown shows thirty-odd names and nothing else, and two of them are a
 * genuine trap. "Multi Select" and "Multi Lookup" sound like the same thing and
 * are not: one is a fixed list of words you type once, the other points at real
 * records in another module and stays in step with them. Choosing the wrong one
 * gets you as far as "— Choose an option set —" and then a dead end, with
 * nothing on screen explaining why.
 *
 * Only the types where the name is not enough are listed. A "Date" needs no help.
 */
const TYPE_HELP: Record<string, string> = {
  picklist: 'A fixed list of choices you write yourself, like New / Contacted / Lost. Pick one.',
  multipicklist:
    'A fixed list of choices you write yourself. Pick several. '
    + 'If you want to choose real records from another module instead — actual units, actual projects — use Multi Lookup under Relationship.',
  reference:
    'Points at one real record in another module, and follows it. Choose a unit and you get that unit, live, with its price and status.',
  multireference:
    'Points at several real records in another module, and follows them. '
    + 'This is the one for “which units is this buyer interested in” — the list comes from Properties itself, so it is never out of date.',
  owner: 'A person or team in your CRM. Used for who owns the record.',
  formula: 'Worked out from other fields. Nobody types into it.',
  rollup: 'Counts or totals related records, like how many site visits this lead has had.',
  autonumber: 'The CRM fills it in, counting up. Nobody types into it.',
  json: 'For structured data the CRM stores but does not draw a box for.',
};

/**
 * Chosen in the option-set dropdown to mean "I will type them here".
 *
 * A sentinel rather than a separate button because the choice is genuinely one
 * choice: reuse a set, or make one. Two controls would make it look like two
 * decisions.
 */
const NEW_PICKLIST = '__new__';

/** uitypes that can be bounded by another field of the same kind. */
const COMPARABLE = ['integer', 'decimal', 'currency', 'percent', 'area', 'score', 'date', 'datetime'];

/** uitypes where a format rule makes sense. */
const TEXTUAL = ['string', 'textarea', 'phone', 'url', 'email'];

/**
 * Named formats, so nobody has to write a regular expression to validate a PAN.
 * The message matters as much as the pattern — "invalid" tells a user nothing,
 * "a PAN looks like ABCDE1234F" tells them what to type.
 */
const FORMATS: { key: string; label: string; pattern: string; message: string }[] = [
  { key: 'pan', label: 'PAN (ABCDE1234F)', pattern: '^[A-Za-z]{5}[0-9]{4}[A-Za-z]$', message: 'A PAN looks like ABCDE1234F' },
  { key: 'gst', label: 'GST number', pattern: '^[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][0-9A-Za-z]Z[0-9A-Za-z]$', message: 'A GST number looks like 27ABCDE1234F1Z5' },
  { key: 'pincode', label: 'Pincode (6 digits)', pattern: '^[1-9][0-9]{5}$', message: 'An Indian pincode is six digits and cannot start with 0' },
  { key: 'aadhaar4', label: 'Aadhaar — last 4 digits', pattern: '^[0-9]{4}$', message: 'Enter only the last four digits of the Aadhaar' },
  { key: 'ifsc', label: 'IFSC code', pattern: '^[A-Za-z]{4}0[0-9A-Za-z]{6}$', message: 'An IFSC code looks like HDFC0001234' },
  { key: 'custom', label: 'Something else…', pattern: '', message: '' },
];

/** The right control for comparing against a field, so a date rule gets a date picker. */
function ValueInput({
  field, value, onChange,
}: { field?: FieldMeta; value: string; onChange: (v: string) => void }): JSX.Element {
  if (field?.uitype === 'picklist' && field.options?.length) {
    return (
      <Select
        value={value}
        onChange={onChange}
        placeholder="— pick a value —"
        options={field.options.map((o) => ({ value: o.value, label: o.label }))}
        className="min-w-[8rem] flex-1 py-1.5 text-xs sm:max-w-[10rem]"
      />
    );
  }
  return (
    <input
      className="input min-w-[7rem] flex-1 py-1.5 text-xs sm:max-w-[10rem]"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="value"
      type={field && COMPARABLE.includes(field.uitype) && field.uitype !== 'date' ? 'number' : 'text'}
    />
  );
}

/** The editable list behind an area's units or a phone's country codes. */
function OptionListEditor({
  title, hint, options, onChange, valuePlaceholder, labelPlaceholder,
}: {
  title: string;
  hint: string;
  options: { value: string; label: string }[];
  onChange: (next: { value: string; label: string }[]) => void;
  valuePlaceholder: string;
  labelPlaceholder: string;
}): JSX.Element {
  const set = (i: number, patch: Partial<{ value: string; label: string }>): void =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  return (
    <div>
      <label className="label">{title}</label>
      <p className="mb-1.5 text-2xs text-muted">{hint}</p>
      <div className="space-y-1.5">
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="input w-24 py-1.5 font-mono text-xs"
              value={o.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder={valuePlaceholder}
              aria-label="Stored value"
            />
            <input
              className="input min-w-0 flex-1 py-1.5 text-xs"
              value={o.label}
              onChange={(e) => set(i, { label: e.target.value })}
              placeholder={labelPlaceholder}
              aria-label="Shown to the user"
            />
            <button
              type="button"
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              className="btn-ghost btn-sm shrink-0 text-slate-400 hover:text-red-500"
              aria-label={`Remove ${o.label || o.value}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...options, { value: '', label: '' }])}
          className="btn-secondary btn-sm"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
        {options.length === 0 && (
          <p className="text-2xs text-muted">
            Empty means the built-in list is used.
          </p>
        )}
      </div>
    </div>
  );
}

function FieldEditor({
  module, field, onClose, onSaved,
}: {
  module: { name: string; blocks: { id: string; label: string }[]; fields: FieldMeta[] };
  field: FieldMeta | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { modules } = useApp();
  const isEdit = Boolean(field);

  const [label, setLabel] = useState(field?.label ?? '');
  const [name, setName] = useState(field?.name ?? '');
  const [uitype, setUitype] = useState(field?.uitype ?? 'string');
  const [blockId, setBlockId] = useState(field?.blockId ?? module.blocks[0]?.id ?? '');
  const [isMandatory, setIsMandatory] = useState(field?.isMandatory ?? false);
  const [isUnique, setIsUnique] = useState(field?.isUnique ?? false);
  const [quickCreate, setQuickCreate] = useState(field?.quickCreate ?? false);
  const [searchable, setSearchable] = useState(field?.searchable ?? false);
  const [filterable, setFilterable] = useState(field?.config.filterable !== false);
  const [sortable, setSortable] = useState(field?.config.sortable !== false);
  const [importable, setImportable] = useState(field?.config.importable !== false);
  const [exportable, setExportable] = useState(field?.config.exportable !== false);
  const [helpText, setHelpText] = useState(field?.helpText ?? '');
  const [picklist, setPicklist] = useState((field?.config.picklist as string) ?? '');
  const [newOptions, setNewOptions] = useState('');
  const [referenceModules, setReferenceModules] = useState<string[]>(
    (field?.config.referenceModules as string[]) ?? [],
  );
  const [formula, setFormula] = useState((field?.config.formula as { expression?: string })?.expression ?? '');
  const [formulaError, setFormulaError] = useState('');
  const [numberPrefix, setNumberPrefix] = useState(
    (field?.config.numbering as { prefix?: string })?.prefix ?? '',
  );

  // --- Advanced: rules the engine has always honoured but nothing could set --
  const existingRule = (field?.config.visibleWhen as FilterGroup | undefined)?.conditions?.[0] as
    { field?: string; operator?: FilterOperator; value?: unknown } | undefined;
  const [showWhenField, setShowWhenField] = useState(existingRule?.field ?? '');
  const [showWhenOp, setShowWhenOp] = useState<FilterOperator>(existingRule?.operator ?? 'equals');
  const [showWhenValue, setShowWhenValue] = useState(
    existingRule?.value === undefined || existingRule?.value === null ? '' : String(existingRule.value),
  );
  const [notAfterField, setNotAfterField] = useState((field?.config.notAfterField as string) ?? '');
  const [notBeforeField, setNotBeforeField] = useState((field?.config.notBeforeField as string) ?? '');
  const [pattern, setPattern] = useState((field?.config.pattern as string) ?? '');
  const [patternMessage, setPatternMessage] = useState((field?.config.patternMessage as string) ?? '');
  const [codePrefix, setCodePrefix] = useState(
    (field?.config.codePrefix as string) ?? (field ? '' : '+91'),
  );
  const [listOptions, setListOptions] = useState<{ value: string; label: string }[]>(
    (field?.config.unitOptions as { value: string; label: string }[])
      ?? (field?.config.countryCodes as { value: string; label: string }[])
      ?? [],
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [invalidStrategy, setInvalidStrategy] = useState<'blank' | 'default' | 'keep'>('blank');

  const [saving, setSaving] = useState(false);

  const { data: picklists } = useQuery({ queryKey: ['picklists'], queryFn: () => api.picklists() });
  const { data: picklistCatalogue } = useQuery({
    queryKey: ['picklist-catalogue'],
    queryFn: () => api.picklistCatalogue(),
  });

  const spec = UITYPE_LIST.find((u) => u.uitype === uitype);
  const needsPicklist = spec?.requiresConfig?.includes('picklist');
  const needsReference = spec?.requiresConfig?.includes('referenceModules');
  const needsFormula = spec?.requiresConfig?.includes('formula');
  const needsNumbering = spec?.requiresConfig?.includes('numbering');
  /** Area fields carry their unit list; phone fields their country codes. */
  /**
   * A phone field whose country code is stored in a picklist field has no
   * option list of its own — the picklist is the list, and the server derives
   * the dropdown from it. Offering a second editable copy here is how an admin
   * ends up deleting every country but +91 and watching nothing change.
   */
  const codeSourceName = uitype === 'phone' && field?.config.digitsFrom
    ? String(field.config.digitsFrom)
    : '';
  const codeSourceField = codeSourceName
    ? module.fields.find((f) => f.name === codeSourceName)
    : undefined;
  const codePicklist = codeSourceField?.config.picklist
    ? String(codeSourceField.config.picklist)
    : '';

  /**
   * Country codes stopped being a list an admin maintains (migration 064). A
   * phone field now carries the one code it puts in front of the box, so this
   * editor offers a box for that code rather than a table of countries nobody
   * in this business dials.
   */
  const supportsOptionList = false;
  /** Only a scalar can be compared to another field of the same kind. */
  const comparable = COMPARABLE.includes(uitype);

  /** Everything on this module except the field being edited — nothing can depend on itself. */
  const otherFields = module.fields.filter((f) => f.isActive && f.name !== field?.name);
  const comparableFields = otherFields.filter((f) => COMPARABLE.includes(f.uitype));
  const ruleCount = [showWhenField, notAfterField, notBeforeField, pattern].filter(Boolean).length;

  const autoName = (value: string): void => {
    setLabel(value);
    if (!isEdit) {
      setName(value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40));
    }
  };

  const save = async (): Promise<void> => {
    if (needsFormula && formula) {
      const check = await api.validateFormula(formula);
      if (!check.valid) { setFormulaError(check.error ?? 'Invalid formula'); return; }
    }

    setSaving(true);
    try {
      // Type changes use the explicit conversion endpoint, rather than a
      // metadata patch that could leave old values unreadable. The preview is
      // deliberately shown at the last safe moment: admin has all their new
      // field settings in front of them before deciding what invalid values do.
      if (isEdit && field && uitype !== field.uitype) {
        const preview = await api.previewFieldConversion(field.id, { targetType: uitype, invalidStrategy });
        const note = preview.invalidRecords
          ? `\n\n${preview.invalidRecords} value(s) cannot convert and will be ${invalidStrategy === 'blank' ? 'cleared' : invalidStrategy === 'keep' ? 'kept as-is' : 'replaced with the default'}.`
          : '';
        if (!window.confirm(`Convert ${preview.totalRecords} existing record value(s) from ${field.uitype} to ${uitype}?${note}\n\nThis is applied safely as one change.`)) {
          setSaving(false); return;
        }
        await api.convertField(field.id, { targetType: uitype, invalidStrategy });
      }
      // Start from what is already stored. Rebuilding config from scratch — as
      // this did — silently discarded every key this form does not render, so
      // editing Mobile's label wiped its digit rules and country codes.
      const config: Record<string, unknown> = { ...(field?.config ?? {}) };
      if (needsPicklist) config.picklist = picklist;
      if (needsReference) config.referenceModules = referenceModules;
      if (needsFormula) config.formula = { expression: formula };
      if (needsNumbering) config.numbering = { prefix: numberPrefix, digits: 5, start: 1 };

      // `null` rather than `delete`: the API merges config so a partial patch
      // cannot wipe a field's other settings, and null is how it is told to
      // remove a key. Deleting here would just leave the old rule in place.
      const clear = (key: string): void => { config[key] = null; };

      if (showWhenField) {
        config.visibleWhen = {
          logic: 'AND',
          conditions: [{
            field: showWhenField,
            operator: showWhenOp,
            ...(NULLARY_OPERATORS.includes(showWhenOp) ? {} : { value: showWhenValue }),
          }],
        };
      } else clear('visibleWhen');

      if (notAfterField) config.notAfterField = notAfterField; else clear('notAfterField');
      if (notBeforeField) config.notBeforeField = notBeforeField; else clear('notBeforeField');
      if (pattern) {
        config.pattern = pattern;
        if (patternMessage) config.patternMessage = patternMessage; else clear('patternMessage');
      } else { clear('pattern'); clear('patternMessage'); }

      if (uitype === 'area') {
        config.unitMaster = 'area';
        config.unitField = String(config.unitField ?? `${name}_unit`);
        clear('unitOptions');
      }
      if (uitype === 'currency') {
        config.unitMaster = 'budget_demand';
        config.unitField = String(config.unitField ?? `${name}_unit`);
        clear('unitOptions');
      }
      if (uitype === 'phone') {
        if (codePrefix.trim()) config.codePrefix = codePrefix.trim(); else clear('codePrefix');
      }
      config.filterable = filterable;
      config.sortable = sortable;
      config.importable = importable;
      config.exportable = exportable;

      const payload = {
        label, name, uitype, blockId, isMandatory, isUnique,
        quickCreate, searchable, helpText: helpText || undefined, config,
      };

      // The set has to exist before the field can name it, so it is made first
      // and the field is created against it. Two requests, one button.
      if (needsPicklist && picklist === NEW_PICKLIST) {
        const values = newOptions
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean);
        if (!values.length) throw new Error('Type at least one option, one per line.');

        // Named after the field so it is recognisable in Admin → Dropdowns, and
        // suffixed when that name is taken rather than quietly overwriting
        // somebody else's set.
        const base = (name || 'options').replace(/[^a-z0-9_]/g, '_').slice(0, 40);
        const taken = new Set(Object.keys(picklists ?? {}));
        const setName = taken.has(base) ? `${base}_${Date.now().toString(36).slice(-4)}` : base;

        await api.createPicklist({
          name: setName,
          label: label || setName.replace(/_/g, ' '),
          values: values.map((v) => ({ value: v, label: v, isActive: true, isDefault: false })),
        });
        (payload.config as Record<string, unknown>).picklist = setName;
      }

      if (isEdit) await api.updateField(field!.id, payload);
      else await api.createField(module.name, payload);

      toast.success(isEdit ? 'Field updated' : 'Field created');
      onSaved();
    } catch (err) {
      toast.error('Could not save the field', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit “${field!.label}”` : 'New field'}
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving || !label || !name}>
            {saving && <Spinner />} {isEdit ? 'Save changes' : 'Create field'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Label</label>
            <input className="input" value={label} onChange={(e) => autoName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">API name</label>
            <input
              className="input font-mono text-xs"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
            />
            {isEdit && (
              <p className="mt-1 text-2xs text-muted">
                {name === field!.name
                  ? 'The name this field goes by in imports, exports and connected apps. Change it and every view, layout, filter and automation follows.'
                  : `Renaming moves no data — every value stays exactly where it is. Views, layouts, filters and automations that name “${field!.name}” are rewritten with it.`}
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Field type</label>
            <select
              className="input"
              value={uitype}
              onChange={(e) => setUitype(e.target.value as typeof uitype)}
            >
              {Object.entries(
                UITYPE_LIST.reduce<Record<string, typeof UITYPE_LIST>>((acc, u) => {
                  (acc[u.group] ??= []).push(u);
                  return acc;
                }, {}),
              ).map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map((u) => <option key={u.uitype} value={u.uitype}>{u.label}</option>)}
                </optgroup>
              ))}
            </select>
            {TYPE_HELP[uitype] && (
              <p className="mt-1.5 text-2xs leading-relaxed text-muted">{TYPE_HELP[uitype]}</p>
            )}
            {isEdit && field && uitype !== field.uitype && (
              <div className="mt-2 rounded-md bg-amber-50 p-2 text-2xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <p className="font-medium">Existing values will be analysed before changing this type.</p>
                <label className="mt-1 block">If a value cannot convert</label>
                <select className="input mt-1 h-7 w-full py-0 text-2xs" value={invalidStrategy} onChange={(e) => setInvalidStrategy(e.target.value as typeof invalidStrategy)}>
                  <option value="blank">Clear that value</option>
                  <option value="keep">Keep its original value</option>
                  <option value="default">Use the field default</option>
                </select>
              </div>
            )}
          </div>
          <div>
            <label className="label">Section</label>
            <Select
              value={blockId}
              onChange={setBlockId}
              options={module.blocks.map((b) => ({ value: b.id, label: b.label }))}
            />
          </div>
        </div>

        {uitype === 'phone' && (
          <div>
            <label className="label">Country code</label>
            <input
              className="input w-32 font-mono text-sm tnum"
              value={codePrefix}
              onChange={(e) => setCodePrefix(e.target.value)}
              placeholder="+91"
              aria-label="Country code shown in front of the number"
            />
            <p className="mt-1 text-2xs text-muted">
              Painted on the front of the box and never typed in. The number itself is stored without
              it, and every call, WhatsApp link and export puts it back. Leave empty for no code.
            </p>
          </div>
        )}

            {needsPicklist && (
              <div>
                <label className="label">Dropdown options</label>
                {/*
                  The option set is named by its stable key (`config.picklist`),
                  but a person chooses by what they renamed it to — the label.
                  Showing the raw name here is how "I renamed Lead Source to
                  Source, and the field still says lead source" reads as a bug:
                  the label changed, the picker kept printing the key.
                */}
                <Select
                  value={picklist}
                  onChange={setPicklist}
                  placeholder="— Choose an option set —"
                  options={[
                    ...(picklistCatalogue ?? []).map((p) => ({ value: p.name, label: p.label })),
                    { value: NEW_PICKLIST, label: '+ Type the options here…' },
                  ]}
                />

            {/*
              Writing the options here, rather than sending somebody to another
              screen to make an option set and then back again to attach it.

              That round trip was the single most-complained-about thing in this
              admin: "I have to first create its dropdown then create field and
              attach dropdown". Nothing about the data model required it — a
              field's binding is one string in its config, and the set is created
              by its own endpoint. It was two screens purely because nobody had
              joined them up.
            */}
            {picklist === NEW_PICKLIST ? (
              <div className="mt-2 space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div>
                  <label className="label" htmlFor="new-picklist-options">One option per line</label>
                  <textarea
                    id="new-picklist-options"
                    className="input font-mono text-xs"
                    rows={5}
                    value={newOptions}
                    onChange={(e) => setNewOptions(e.target.value)}
                    placeholder={'Available\nHeld\nBooked'}
                  />
                </div>
                <p className="text-2xs text-muted">
                  Saved as a set named after this field, so it can be reused on another field later and
                  edited any time under Admin → Dropdowns. Type what you want people to see; blank lines
                  are ignored.
                </p>
              </div>
            ) : (
              <p className="mt-1 text-2xs text-muted">
                Reuses an existing set. Editing it under Admin → Dropdowns changes every field using it.
              </p>
            )}
          </div>
        )}

        {needsReference && (
          <div>
            <label className="label">Points at which modules?</label>
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              {modules.filter((m) => m.isEntity).map((m) => {
                const active = referenceModules.includes(m.name);
                return (
                  <button
                    key={m.name}
                    type="button"
                    onClick={() => setReferenceModules(active
                      ? referenceModules.filter((x) => x !== m.name)
                      : [...referenceModules, m.name])}
                    className={cn(
                      'rounded px-2 py-1 text-xs transition-colors',
                      active
                        ? 'bg-brand-100 font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300'
                        : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {needsFormula && (
          <div>
            <label className="label">Formula</label>
            <textarea
              className="input font-mono text-xs"
              rows={3}
              value={formula}
              onChange={(e) => { setFormula(e.target.value); setFormulaError(''); }}
              placeholder="{base_price} + COALESCE({parking_charge},0)"
            />
            {formulaError && <p className="mt-1 text-xs text-red-600">{formulaError}</p>}
            <p className="mt-1 text-2xs text-muted">
              Reference fields as {'{field_name}'}. Functions: IF, ROUND, SUM, MIN, MAX, CONCAT,
              DAYS_BETWEEN, LAKH, CRORE, PERCENT_OF and more.
            </p>
          </div>
        )}

        {needsNumbering && (
          <div>
            <label className="label">Number prefix</label>
            <input
              className="input font-mono"
              value={numberPrefix}
              onChange={(e) => setNumberPrefix(e.target.value)}
              placeholder="INV-"
            />
            <p className="mt-1 text-2xs text-muted">
              Produces {numberPrefix || 'PREFIX-'}00001, {numberPrefix || 'PREFIX-'}00002, …
            </p>
          </div>
        )}

        <div>
          <label className="label">Help text</label>
          <input className="input" value={helpText} onChange={(e) => setHelpText(e.target.value)} />
        </div>

        {/* Advanced rules.
            Collapsed by default: most fields need none of this, and putting it
            in front of every "add a field" would make the common case feel
            harder than it is. */}
        <div className="rounded-lg border border-slate-200 dark:border-slate-700">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 transition-transform', !advancedOpen && '-rotate-90')} />
            <span className="text-sm font-medium">Rules</span>
            <span className="text-2xs text-muted">
              when to show it, and what counts as a valid answer
            </span>
            {ruleCount > 0 && <Badge className="ml-auto" color="#6366f1">{ruleCount}</Badge>}
          </button>

          {advancedOpen && (
            <div className="space-y-4 border-t border-slate-100 p-3 dark:border-slate-800">
              {/* --- conditional visibility ------------------------------ */}
              <div>
                <label className="label">Only show this field when…</label>
                <p className="mb-1.5 text-2xs text-muted">
                  Leave the first box empty to always show it. Example: show “Loan Bank”
                  only when “Loan Required” is Yes.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={showWhenField}
                    onChange={setShowWhenField}
                    placeholder="— always show —"
                    options={otherFields.map((f) => ({ value: f.name, label: f.label }))}
                    className="min-w-[9rem] flex-1 py-1.5 text-xs sm:max-w-[12rem]"
                  />
                  {showWhenField && (
                    <>
                      <Select
                        value={showWhenOp}
                        onChange={(v) => setShowWhenOp(v as FilterOperator)}
                        options={[
                          { value: 'equals', label: 'is' },
                          { value: 'not_equals', label: 'is not' },
                          { value: 'is_not_empty', label: 'is filled in' },
                          { value: 'is_empty', label: 'is empty' },
                          { value: 'is_true', label: 'is ticked' },
                          { value: 'is_false', label: 'is not ticked' },
                        ]}
                        className="w-32 shrink-0 py-1.5 text-xs"
                      />
                      {!NULLARY_OPERATORS.includes(showWhenOp) && (
                        <ValueInput
                          field={otherFields.find((f) => f.name === showWhenField)}
                          value={showWhenValue}
                          onChange={setShowWhenValue}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* --- cross-field bounds ---------------------------------- */}
              {comparable && (
                <div>
                  <label className="label">Compare against another field</label>
                  <p className="mb-1.5 text-2xs text-muted">
                    Stops impossible pairs. Example: on “Budget (Min)”, set
                    <em> must not be more than</em> “Budget (Max)”.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="flex items-center gap-2 text-xs">
                      <span className="shrink-0 text-muted">Not more than</span>
                      <Select
                        value={notAfterField}
                        onChange={setNotAfterField}
                        placeholder="— no limit —"
                        options={comparableFields.map((f) => ({ value: f.name, label: f.label }))}
                        className="min-w-0 flex-1 py-1.5 text-xs"
                      />
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <span className="shrink-0 text-muted">Not less than</span>
                      <Select
                        value={notBeforeField}
                        onChange={setNotBeforeField}
                        placeholder="— no limit —"
                        options={comparableFields.map((f) => ({ value: f.name, label: f.label }))}
                        className="min-w-0 flex-1 py-1.5 text-xs"
                      />
                    </label>
                  </div>
                </div>
              )}

              {/* --- format -------------------------------------------- */}
              {TEXTUAL.includes(uitype) && (
                <div>
                  <label className="label">Must look like</label>
                  <p className="mb-1.5 text-2xs text-muted">
                    Refuses anything in the wrong shape, with a message that explains why.
                  </p>
                  <Select
                    // `f.pattern &&` matters: the "Something else…" preset has an
                    // empty pattern, so without it an unset field matches custom
                    // and the dropdown reads "Something else…" instead of "anything".
                    value={FORMATS.find((f) => f.pattern && f.pattern === pattern)?.key ?? (pattern ? 'custom' : '')}
                    onChange={(key) => {
                      const preset = FORMATS.find((f) => f.key === key);
                      if (!preset) { setPattern(''); setPatternMessage(''); return; }
                      if (preset.key === 'custom') { setPattern(pattern || '^.*$'); return; }
                      setPattern(preset.pattern);
                      setPatternMessage(preset.message);
                    }}
                    placeholder="— anything —"
                    options={FORMATS.map((f) => ({ value: f.key, label: f.label }))}
                    className="w-full py-1.5 text-sm sm:max-w-xs"
                  />
                  {pattern && (
                    <div className="mt-2 space-y-2">
                      <div>
                        <label className="label">Message when it doesn’t match</label>
                        <input
                          className="input text-sm"
                          value={patternMessage}
                          onChange={(e) => setPatternMessage(e.target.value)}
                          placeholder="A PAN looks like ABCDE1234F"
                        />
                      </div>
                      {!FORMATS.some((f) => f.pattern && f.pattern === pattern) && (
                        <div>
                          <label className="label">Pattern</label>
                          <input
                            className="input font-mono text-xs"
                            value={pattern}
                            onChange={(e) => setPattern(e.target.value)}
                          />
                          <p className="mt-1 text-2xs text-muted">
                            A regular expression. Leave the presets above if you are not sure.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {(uitype === 'area' || uitype === 'currency') && (
                <div className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700">
                  <p className="font-medium">Shared unit master</p>
                  <p className="mt-1 text-muted">This field automatically uses the {uitype === 'area' ? 'Area / Size' : 'Budget / Demand'} Unit Master. Add or change units from Admin → Area & Pricing Units.</p>
                </div>
              )}

              {codePicklist && (
                <div className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700">
                  <p className="font-medium">Country codes offered</p>
                  <p className="mt-1 text-muted">
                    Taken from the <strong>{codeSourceField?.label ?? codePicklist}</strong> dropdown,
                    so there is one list rather than two that can disagree. Edit it in{' '}
                    <Link
                      to={`/admin/picklists?picklist=${encodeURIComponent(codePicklist)}`}
                      className="text-brand-600 underline dark:text-brand-400"
                    >
                      Admin → Dropdowns
                    </Link>
                    {' '}and every mobile field follows immediately.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-700">
          <Toggle checked={isMandatory} onChange={setIsMandatory} label="Required" />
          <Toggle checked={isUnique} onChange={setIsUnique} label="Must be unique" />
          <Toggle checked={quickCreate} onChange={setQuickCreate} label="Show in quick create" />
          <Toggle checked={searchable} onChange={setSearchable} label="Include in search" />
          <Toggle checked={filterable} onChange={setFilterable} label="Allow filters" />
          <Toggle checked={sortable} onChange={setSortable} label="Allow sorting" />
          <Toggle checked={importable} onChange={setImportable} label="Allow import" />
          <Toggle checked={exportable} onChange={setExportable} label="Allow export" />
        </div>
      </div>
    </Modal>
  );
}

function ModuleCreator({
  onClose, onCreated,
}: { onClose: () => void; onCreated: (name: string) => void }): JSX.Element {
  const [label, setLabel] = useState('');
  const [singular, setSingular] = useState('');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('box');
  const [color, setColor] = useState('#6366f1');
  const [menuGroup, setMenuGroup] = useState('Custom');
  const [saving, setSaving] = useState(false);

  const ICONS = ['box', 'briefcase', 'building', 'clipboard-list', 'file-text', 'flag',
    'gift', 'hammer', 'key', 'map', 'package', 'shield', 'star', 'ticket', 'truck', 'wrench'];

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await api.createModule({
        name, label, singularLabel: singular || label.replace(/s$/, ''),
        icon, color, menuGroup, labelFields: ['name'],
      });
      onCreated(name);
    } catch (err) {
      toast.error('Could not create the module', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New module"
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving || !label || !name}>
            {saving && <Spinner />} Create module
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          A new module gets its own table, list views, layouts, permissions and API endpoints —
          exactly like the built-in ones.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Plural label</label>
            <input
              className="input"
              value={label}
              placeholder="e.g. Maintenance Requests"
              onChange={(e) => {
                setLabel(e.target.value);
                setName(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40));
              }}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Singular label</label>
            <input
              className="input"
              value={singular}
              placeholder="e.g. Maintenance Request"
              onChange={(e) => setSingular(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="label">API name</label>
          <input className="input font-mono text-xs" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Menu group</label>
            <Select
              value={menuGroup}
              onChange={setMenuGroup}
              options={['Sales', 'Inventory', 'Marketing', 'Finance', 'Productivity', 'Custom']
                .map((g) => ({ value: g, label: g }))}
            />
          </div>
          <div>
            <label className="label">Colour</label>
            <input
              type="color"
              className="input h-9 p-1"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Icon</label>
            <Select
              value={icon}
              onChange={setIcon}
              options={ICONS.map((i) => ({ value: i, label: i.replace(/-/g, ' ') }))}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
