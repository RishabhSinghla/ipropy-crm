/**
 * Dynamic record form.
 *
 * Reads the module's layout (blocks → fields) and renders inputs via
 * FieldRenderer. Handles mandatory validation, dependent picklists, conditional
 * visibility, live duplicate detection and server-side field errors.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FieldMeta, ModuleMeta, RecordEnvelope } from '@ipropy/shared';
import { collectFieldErrors } from '@ipropy/shared';
import { AlertTriangle, ChevronDown, Save, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { invalidateRecordQueries } from '../lib/invalidate';
import { cn, deepEqual } from '../lib/utils';
import { FieldInput } from './FieldRenderer';
import { Spinner } from './ui';

interface LayoutBlock {
  key: string;
  label: string;
  columns: number;
  collapsed?: boolean;
  fields: string[];
}

/**
 * The existing record, shown right under the field that matched it.
 *
 * The banner at the top of the form is easy to scroll past while typing. This
 * puts "you already have this person" beside the number that proves it, with a
 * link to open them — which is almost always what the user actually wanted.
 */
function DuplicateHint({
  matches, module, label,
}: {
  matches: { id: string; label: string; matchedOn: string[] }[] | undefined;
  module: string;
  label: string;
}): JSX.Element | null {
  if (!matches?.length) return null;
  return (
    <div className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950/50">
      <p className="text-2xs font-medium text-amber-900 dark:text-amber-200">
        This {label.toLowerCase()} is already on {matches.length === 1 ? 'a record' : 'other records'}:
      </p>
      <ul className="mt-0.5 space-y-0.5">
        {matches.slice(0, 3).map((m) => (
          <li key={m.id}>
            <Link
              to={`/${module}/${m.id}`}
              className="text-xs font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700 dark:text-amber-200"
            >
              {m.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RecordForm({
  module, record, mode = 'edit', onSaved, onCancel, initialValues,
}: {
  module: ModuleMeta & { picklistDependencies?: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[] };
  record?: RecordEnvelope;
  mode?: 'edit' | 'quick_create';
  onSaved: (record: RecordEnvelope) => void;
  onCancel?: () => void;
  initialValues?: Record<string, unknown>;
}): JSX.Element {
  const isCreate = !record;
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...(record?.values ?? {}),
    ...(initialValues ?? {}),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [duplicates, setDuplicates] = useState<{ id: string; label: string; matchedOn: string[] }[]>([]);

  const { data: layout } = useQuery({
    queryKey: ['layout', module.name, mode],
    queryFn: () => api.layout(module.name, mode === 'quick_create' ? 'quick_create' : 'edit'),
    retry: false,
  });

  const fieldMap = useMemo(() => new Map(module.fields.map((f) => [f.name, f])), [module.fields]);

  // Fall back to the module's own block structure when no layout is configured.
  const blocks: LayoutBlock[] = useMemo(() => {
    const configured = (layout?.config as { blocks?: LayoutBlock[] } | undefined)?.blocks;
    if (configured?.length) return configured;
    return module.blocks.map((b) => ({
      key: b.name, label: b.label, columns: b.columns, collapsed: b.isCollapsed,
      fields: b.fields.map((f) => f.name),
    }));
  }, [layout, module.blocks]);

  useEffect(() => {
    setCollapsed(new Set(blocks.filter((b) => b.collapsed).map((b) => b.key)));
  }, [blocks.length]);

  // Live duplicate probe on the module's declared duplicate-check fields.
  useEffect(() => {
    if (!module.duplicateCheckFields?.length) return;
    const relevant = Object.fromEntries(
      module.duplicateCheckFields
        .filter((name) => values[name])
        .map((name) => [name, values[name]]),
    );
    if (!Object.keys(relevant).length) { setDuplicates([]); return; }

    const timer = setTimeout(() => {
      void api.checkDuplicates(module.name, relevant, record?.id)
        .then(setDuplicates)
        .catch(() => setDuplicates([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [module.duplicateCheckFields?.join(','), ...(module.duplicateCheckFields ?? []).map((f) => values[f])]);

  /**
   * Duplicates grouped by the field that matched.
   *
   * Shown under the input rather than only in a banner at the top: someone
   * typing a number they have already saved should see the existing person
   * right there, next to what they typed, while they can still change course.
   */
  const duplicatesByField = useMemo(() => {
    const out = new Map<string, typeof duplicates>();
    for (const dup of duplicates) {
      for (const name of dup.matchedOn) {
        out.set(name, [...(out.get(name) ?? []), dup]);
      }
    }
    return out;
  }, [duplicates]);

  const setValue = (name: string, value: unknown): void => {
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      // Clear a dependent picklist when its parent changes to an incompatible value.
      for (const dep of module.picklistDependencies ?? []) {
        if (dep.sourceField !== name) continue;
        const allowed = dep.mapping[String(value)] ?? [];
        const current = next[dep.targetField];
        if (Array.isArray(current)) {
          next[dep.targetField] = current.filter((v) => allowed.includes(String(v)));
        } else if (current && !allowed.includes(String(current))) {
          next[dep.targetField] = null;
        }
      }
      return next;
    });
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const restrictionFor = (fieldName: string): string[] | undefined => {
    const dep = (module.picklistDependencies ?? []).find((d) => d.targetField === fieldName);
    if (!dep) return undefined;
    const sourceValue = values[dep.sourceField];
    if (!sourceValue) return undefined;
    return dep.mapping[String(sourceValue)] ?? [];
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};

    for (const block of blocks) {
      for (const name of block.fields) {
        const field = fieldMap.get(name);
        if (!field || !field.isMandatory || field.isReadonly) continue;
        if (field.displayType === 'hidden' || field.displayType === 'detail_only') continue;
        const v = values[name];
        const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
        if (empty) next[name] = `${field.label} is required`;
      }
    }

    // Format, range and cross-field rules — the same code the server runs, so
    // the form can never accept something the API will reject, or vice versa.
    for (const err of collectFieldErrors(module.fields, values, { ...(record?.values ?? {}), ...values })) {
      next[err.field] ??= err.message;
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError('');
    if (!validate()) {
      setFormError('Please fill in the highlighted fields.');
      return;
    }

    setSaving(true);
    try {
      // Only send fields the form actually rendered, plus the owner.
      const rendered = new Set(blocks.flatMap((b) => b.fields));
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (rendered.has(key) || key === 'owner_id') payload[key] = value;
      }
      // On update, only send what changed — keeps the audit trail meaningful.
      const body = record
        ? Object.fromEntries(Object.entries(payload).filter(([k, v]) => !deepEqual(v, record.values[k])))
        : payload;

      if (record && Object.keys(body).length === 0) {
        onSaved(record);
        return;
      }

      const saved = record
        ? await api.update(module.name, record.id, body)
        : await api.create(module.name, body);

      // Invalidate here rather than in each caller: the record was previously
      // written without any caller refreshing the cache, so the page navigated
      // to after a save showed the pre-edit values until a manual reload.
      invalidateRecordQueries(queryClient, module.name, saved.id);
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as { fields?: { field: string; message: string }[] } | undefined;
        if (details?.fields?.length) {
          setErrors(Object.fromEntries(details.fields.map((f) => [f.field, f.message])));
        }
        const single = err.details as { field?: string } | undefined;
        if (single?.field) setErrors((prev) => ({ ...prev, [single.field!]: err.message }));
        setFormError(err.message);
      } else {
        setFormError('Could not save. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {duplicates.length > 0 && isCreate && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Possible duplicate{duplicates.length > 1 ? 's' : ''}
              </p>
              <ul className="mt-1 space-y-0.5">
                {duplicates.map((d) => (
                  <li key={d.id} className="text-xs text-amber-800 dark:text-amber-300">
                    <Link to={`/${module.name}/${d.id}`} className="font-medium underline">{d.label}</Link>
                    <span className="ml-1 opacity-70">— same {d.matchedOn.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {blocks.map((block) => {
        const isCollapsed = collapsed.has(block.key);
        const fields = block.fields
          .map((name) => fieldMap.get(name))
          .filter((f): f is FieldMeta => Boolean(f))
          .filter((f) => f.isActive && f.displayType !== 'hidden' && f.displayType !== 'detail_only')
          .filter((f) => !(isCreate && f.displayType === 'readonly' && !f.defaultValue));

        if (!fields.length) return null;

        return (
          <div key={block.key} className="card overflow-hidden">
            <button
              type="button"
              onClick={() => {
                const next = new Set(collapsed);
                if (isCollapsed) next.delete(block.key); else next.add(block.key);
                setCollapsed(next);
              }}
              className="flex w-full items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 text-left dark:border-slate-800 dark:bg-slate-800/40"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 transition-transform', isCollapsed && '-rotate-90')} />
              <span className="text-sm font-medium">{block.label}</span>
            </button>

            {!isCollapsed && (
              <div className={cn(
                'grid gap-x-4 gap-y-3 p-4',
                block.columns === 1 ? 'grid-cols-1' : block.columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
              )}>
                {fields.map((field) => (
                  <div
                    key={field.name}
                    className={cn(field.config.fullWidth && (block.columns === 3 ? 'sm:col-span-3' : 'sm:col-span-2'))}
                  >
                    <label className="label" htmlFor={`f_${field.name}`}>
                      {field.label}
                      {field.isMandatory && <span className="ml-0.5 text-negative">*</span>}
                    </label>
                    <FieldInput
                      id={`f_${field.name}`}
                      field={field}
                      value={values[field.name]}
                      onChange={(v) => setValue(field.name, v)}
                      error={errors[field.name]}
                      formValues={values}
                      restrictTo={restrictionFor(field.name)}
                      recordId={record?.id}
                      moduleName={module.name}
                    />
                    {errors[field.name] && (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors[field.name]}</p>
                    )}
                    <DuplicateHint
                      matches={duplicatesByField.get(field.name)}
                      module={module.name}
                      label={field.label}
                    />
                    {!errors[field.name] && field.helpText && field.uitype !== 'boolean' && (
                      <p className="mt-1 text-xs text-muted">{field.helpText}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {formError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {formError}
        </div>
      )}

      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-slate-200 bg-white py-3 dark:border-slate-800 dark:bg-slate-900">
        {onCancel && (
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
            <X className="h-4 w-4" /> Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? <Spinner /> : <Save className="h-4 w-4" />}
          {isCreate ? `Create ${module.singularLabel}` : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
