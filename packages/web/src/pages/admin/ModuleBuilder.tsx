import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { FieldMeta } from '@ipropy/shared';
import { UITYPE_LIST } from '@ipropy/shared';
import { Blocks, Edit3, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast, useApp } from '../../lib/store';
import { cn } from '../../lib/utils';
import { Badge, ConfirmDialog, EmptyState, Modal, Select, Skeleton, Spinner, Toggle } from '../../components/ui';
import { ModuleIcon } from '../../components/Layout';

export default function ModuleBuilder(): JSX.Element {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editingField, setEditingField] = useState<FieldMeta | null>(null);
  const [creatingField, setCreatingField] = useState(false);
  const [creatingModule, setCreatingModule] = useState(false);
  const [deleteField, setDeleteField] = useState<FieldMeta | null>(null);

  const { data: fieldModules = [], isLoading: isModulesLoading } = useQuery({
    queryKey: ['field-modules'],
    queryFn: () => api.fieldModules(),
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
    mutationFn: (id: string) => api.deleteField(id),
    onSuccess: (result) => {
      const r = result as { deactivated?: boolean };
      toast.success(r.deactivated ? 'Field hidden' : 'Field deleted');
      invalidateModule();
    },
    onError: (err: Error) => toast.error('Could not remove the field', err.message),
  });

  const unhideMutation = useMutation({
    mutationFn: (id: string) => api.updateField(id, { isActive: true }),
    onSuccess: () => {
      toast.success('Field restored');
      invalidateModule();
    },
    onError: (err: Error) => toast.error('Could not restore the field', err.message),
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
                <button onClick={() => setCreatingField(true)} className="btn-primary btn-sm ml-auto">
                  <Plus className="h-3.5 w-3.5" /> Add field
                </button>
              </div>

              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {meta.blocks.map((block) => (
                  <div key={block.id}>
                    <div className="bg-slate-50/60 px-4 py-1.5 dark:bg-slate-800/40">
                      <p className="text-2xs font-semibold uppercase tracking-wide text-muted">
                        {block.label}
                      </p>
                    </div>
                    {block.fields.map((field) => (
                      <div
                        key={field.id}
                        className="flex items-center gap-3 px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                      >
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
                            {field.config.picklist ? ` (${field.config.picklist})` : ''}
                            {field.config.referenceModules ? ` → ${(field.config.referenceModules as string[]).join('/')}` : ''}
                          </p>
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => setEditingField(field)}
                            className="btn-ghost btn-sm gap-1 px-2"
                            title="Edit field"
                            aria-label={`Edit ${field.label}`}
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span className="hidden xl:inline">Edit</span>
                          </button>
                          {!field.isCustom && !field.isActive ? (
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
                              onClick={() => setDeleteField(field)}
                              className="btn-ghost btn-sm gap-1 px-2 text-slate-400 hover:text-red-600"
                              title={field.isCustom ? 'Delete field permanently' : 'Remove field from screens'}
                              aria-label={`Remove ${field.label}`}
                            >
                              {field.isCustom ? <Trash2 className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                              <span className="hidden xl:inline">Remove</span>
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    {block.fields.length === 0 && (
                      <p className="px-4 py-3 text-xs text-muted">No fields in this block</p>
                    )}
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
        open={Boolean(deleteField)}
        onClose={() => setDeleteField(null)}
        onConfirm={() => deleteMutation.mutateAsync(deleteField!.id)}
        title={deleteField?.isCustom ? `Delete “${deleteField.label}”?` : `Hide “${deleteField?.label}”?`}
        body={deleteField?.isCustom
          ? 'The field and all of its stored values will be permanently removed.'
          : 'Built-in fields cannot be deleted. This hides the field from every screen; you can re-enable it later.'}
        confirmLabel={deleteField?.isCustom ? 'Delete' : 'Hide'}
        danger
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function FieldEditor({
  module, field, onClose, onSaved,
}: {
  module: { name: string; blocks: { id: string; label: string }[] };
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
  const [helpText, setHelpText] = useState(field?.helpText ?? '');
  const [picklist, setPicklist] = useState((field?.config.picklist as string) ?? '');
  const [referenceModules, setReferenceModules] = useState<string[]>(
    (field?.config.referenceModules as string[]) ?? [],
  );
  const [formula, setFormula] = useState((field?.config.formula as { expression?: string })?.expression ?? '');
  const [formulaError, setFormulaError] = useState('');
  const [numberPrefix, setNumberPrefix] = useState(
    (field?.config.numbering as { prefix?: string })?.prefix ?? '',
  );
  const [saving, setSaving] = useState(false);

  const { data: picklists } = useQuery({ queryKey: ['picklists'], queryFn: () => api.picklists() });

  const spec = UITYPE_LIST.find((u) => u.uitype === uitype);
  const needsPicklist = spec?.requiresConfig?.includes('picklist');
  const needsReference = spec?.requiresConfig?.includes('referenceModules');
  const needsFormula = spec?.requiresConfig?.includes('formula');
  const needsNumbering = spec?.requiresConfig?.includes('numbering');

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
      const config: Record<string, unknown> = {};
      if (needsPicklist) config.picklist = picklist;
      if (needsReference) config.referenceModules = referenceModules;
      if (needsFormula) config.formula = { expression: formula };
      if (needsNumbering) config.numbering = { prefix: numberPrefix, digits: 5, start: 1 };

      const payload = {
        label, name, uitype, blockId, isMandatory, isUnique,
        quickCreate, searchable, helpText: helpText || undefined, config,
      };

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
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
            />
            {isEdit && <p className="mt-1 text-2xs text-muted">The API name cannot be changed.</p>}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Field type</label>
            <select
              className="input"
              value={uitype}
              onChange={(e) => setUitype(e.target.value as typeof uitype)}
              disabled={isEdit && !field?.isCustom}
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

        {needsPicklist && (
          <div>
            <label className="label">Dropdown options</label>
            <Select
              value={picklist}
              onChange={setPicklist}
              placeholder="— Choose an option set —"
              options={Object.keys(picklists ?? {}).map((p) => ({ value: p, label: p.replace(/_/g, ' ') }))}
            />
            <p className="mt-1 text-2xs text-muted">
              Manage option sets under Admin → Dropdowns.
            </p>
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

        <div className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-700">
          <Toggle checked={isMandatory} onChange={setIsMandatory} label="Required" />
          <Toggle checked={isUnique} onChange={setIsUnique} label="Must be unique" />
          <Toggle checked={quickCreate} onChange={setQuickCreate} label="Show in quick create" />
          <Toggle checked={searchable} onChange={setSearchable} label="Include in search" />
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
