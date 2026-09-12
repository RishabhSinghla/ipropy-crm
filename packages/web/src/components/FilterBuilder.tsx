import { type JSX, useMemo, useState } from 'react';
import { type FieldMeta, type FilterCondition, type FilterGroup, type FilterOperator, isFilterGroup, type ModuleMeta, OPERATOR_LABELS, operatorTakesValue, UITYPES } from '@ipropy/shared';
import { Plus, Trash2, X } from 'lucide-react';
import { badgeVars } from '../lib/color';
import { cn } from '../lib/utils';
import { FieldInput } from './FieldRenderer';
import { Select } from './ui';

/** System pseudo-fields available on every module. */
const SYSTEM_FIELDS: FieldMeta[] = ([
  { name: 'owner_id', label: 'Assigned To', uitype: 'owner' },
  { name: 'created_at', label: 'Created At', uitype: 'datetime' },
  { name: 'updated_at', label: 'Modified At', uitype: 'datetime' },
  { name: 'last_activity_at', label: 'Last Activity', uitype: 'datetime' },
  { name: 'created_by', label: 'Created By', uitype: 'user' },
] as const).map((f) => ({
  ...f,
  id: `sys_${f.name}`, internalId: `sys_${f.name}`, moduleId: '', moduleName: '', blockId: null,
  storage: 'column' as const, columnName: f.name, sequence: 999,
  isMandatory: false, isReadonly: true, isUnique: false, isCustom: false, isActive: true,
  displayType: 'default' as const, defaultValue: null, maxLength: null, helpText: null,
  config: {}, quickCreate: false, massEditable: false, searchable: false,
}));

export function FilterBuilder({
  module, value, onChange,
}: {
  module: ModuleMeta;
  value: FilterGroup;
  onChange: (filter: FilterGroup) => void;
}): JSX.Element {
  /*
    One entry per idea, in alphabetical order.

    Two things were wrong with the old list. It offered **"Assigned To"
    twice** — once as the module's own field and once as the `owner_id`
    pseudo-field below, which are the same column wearing two names, so half
    the time you picked the one that read the same and filtered the same and
    you could not tell which you had. And it came out in `sequence`, the order
    an admin arranged the *form* in, which is the right order on a form and no
    order at all in a list of thirty you are scanning for one word.

    So: drop a system field the module already has a real field for, then sort
    by label. `localeCompare` rather than `<`, for the accented and non-Latin
    labels this CRM carries.
  */
  const fields = useMemo(() => {
    const own = module.fields.filter((f) => f.isActive && f.displayType !== 'hidden' && f.config.filterable !== false);
    const covered = new Set(own.map((f) => f.columnName ?? f.name));
    return [...own, ...SYSTEM_FIELDS.filter((f) => !covered.has(f.name))]
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [module.fields]);

  const update = (index: number, node: FilterCondition | FilterGroup): void => {
    const conditions = [...value.conditions];
    conditions[index] = node;
    onChange({ ...value, conditions });
  };

  const remove = (index: number): void => {
    onChange({ ...value, conditions: value.conditions.filter((_, i) => i !== index) });
  };

  const addCondition = (): void => {
    const first = fields[0];
    onChange({
      ...value,
      conditions: [
        ...value.conditions,
        { field: first.name, operator: defaultOperator(first), value: null },
      ],
    });
  };

  const addGroup = (): void => {
    onChange({
      ...value,
      conditions: [...value.conditions, { logic: 'OR', conditions: [] }],
    });
  };

  return (
    <div className="space-y-2">
      {value.conditions.length > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">Match</span>
          <div className="inline-flex overflow-hidden rounded-md border border-slate-200 dark:border-slate-700">
            {(['AND', 'OR'] as const).map((logic) => (
              <button
                key={logic}
                onClick={() => onChange({ ...value, logic })}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium transition-colors',
                  value.logic === logic
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300',
                )}
              >
                {logic === 'AND' ? 'All' : 'Any'}
              </button>
            ))}
          </div>
          <span className="text-slate-500">of the following</span>
        </div>
      )}

      <div className="space-y-2">
        {value.conditions.map((node, i) => (
          <div key={i} className="flex items-start gap-2">
            {isFilterGroup(node) ? (
              <div className="flex-1 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-2.5 dark:border-slate-700 dark:bg-slate-800/50">
                <FilterBuilder module={module} value={node} onChange={(g) => update(i, g)} />
              </div>
            ) : (
              <ConditionRow
                fields={fields}
                condition={node}
                onChange={(c) => update(i, c)}
              />
            )}
            <button
              onClick={() => remove(i)}
              className="mt-1.5 shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
              title="Remove"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button onClick={addCondition} className="btn-secondary btn-sm">
          <Plus className="h-3 w-3" /> Condition
        </button>
        <button onClick={addGroup} className="btn-ghost btn-sm">
          <Plus className="h-3 w-3" /> Group
        </button>
      </div>
    </div>
  );
}

function ConditionRow({
  fields, condition, onChange,
}: {
  fields: FieldMeta[];
  condition: FilterCondition;
  onChange: (c: FilterCondition) => void;
}): JSX.Element {
  const field = fields.find((f) => f.name === condition.field) ?? fields[0];
  const operators = UITYPES[field.uitype]?.operators ?? ['equals'];

  return (
    <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
      <Select
        value={condition.field}
        onChange={(name) => {
          const next = fields.find((f) => f.name === name)!;
          onChange({ field: name, operator: defaultOperator(next), value: null });
        }}
        options={fields.map((f) => ({ value: f.name, label: f.label }))}
        className="py-1.5 text-xs"
      />

      <Select
        value={condition.operator}
        onChange={(op) => onChange({ ...condition, operator: op as FilterOperator, value: null })}
        options={operators.map((op) => ({ value: op, label: OPERATOR_LABELS[op] ?? op }))}
        className="py-1.5 text-xs"
      />

      {operatorTakesValue(condition.operator) ? (
        <div className="min-w-0">
          {condition.operator === 'between' ? (
            <div className="flex items-center gap-1">
              <ValueEditor field={field} value={condition.value} onChange={(v) => onChange({ ...condition, value: v })} />
              <span className="text-2xs text-muted">and</span>
              <ValueEditor field={field} value={condition.value2} onChange={(v) => onChange({ ...condition, value2: v })} />
            </div>
          ) : ['last_n_days', 'next_n_days', 'older_than_n_days'].includes(condition.operator) ? (
            <input
              type="number"
              className="input py-1.5 text-xs tnum"
              placeholder="days"
              value={String(condition.value ?? '')}
              onChange={(e) => onChange({ ...condition, value: Number(e.target.value) })}
            />
          ) : ['in', 'not_in', 'has_any', 'has_all'].includes(condition.operator) ? (
            <MultiValueEditor field={field} value={condition.value} onChange={(v) => onChange({ ...condition, value: v })} />
          ) : (
            <ValueEditor field={field} value={condition.value} onChange={(v) => onChange({ ...condition, value: v })} />
          )}
        </div>
      ) : (
        <div className="flex items-center px-2 text-xs text-muted">—</div>
      )}
    </div>
  );
}

/**
 * What a generated field's *filter value* is typed into.
 *
 * On a record these render as a disabled "Generated automatically" box, which
 * is right there and wrong here — nobody is editing the record number, they
 * are typing the one they want to find.
 */
const FILTER_INPUT_UITYPE: Partial<Record<FieldMeta['uitype'], FieldMeta['uitype']>> = {
  autonumber: 'string',
  formula: 'string',
  rollup: 'decimal',
};

function ValueEditor({
  field, value, onChange,
}: { field: FieldMeta; value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  /**
   * Reuse the real field editor so filter values match what's stored — but not
   * its read-only-ness.
   *
   * `FieldInput` disables itself for a readonly field, which is correct for a
   * record and nonsense for a filter: an AI Score you cannot type is a score
   * you cannot filter on. It made the value box of every computed and system
   * field dead on arrival — AI Score, Last Scored, Record #, and Created At /
   * Modified At / Last Activity, which are declared readonly right above.
   */
  const editable = useMemo<FieldMeta>(() => ({
    ...field,
    isReadonly: false,
    displayType: 'default',
    uitype: FILTER_INPUT_UITYPE[field.uitype] ?? field.uitype,
  }), [field]);

  return (
    <div className="min-w-0 flex-1 [&_.input]:py-1.5 [&_.input]:text-xs">
      <FieldInput field={editable} value={value} onChange={onChange} />
    </div>
  );
}

function MultiValueEditor({
  field, value, onChange,
}: { field: FieldMeta; value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  const [text, setText] = useState('');

  if (field.options?.length) {
    return (
      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 p-1.5 dark:border-slate-700">
        {field.options.map((o) => {
          const active = list.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(active ? list.filter((v) => v !== o.value) : [...list, o.value])}
              className={cn(
                'rounded px-1.5 py-0.5 text-2xs transition-colors',
                active
                  ? cn('font-medium', o.color && 'badge-solid')
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
              )}
              style={active ? badgeVars(o.color) : undefined}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 p-1.5 dark:border-slate-700">
      {list.map((v) => (
        <span key={String(v)} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-2xs dark:bg-slate-800">
          {String(v)}
          <button onClick={() => onChange(list.filter((x) => x !== v))}><X className="h-2.5 w-2.5" /></button>
        </span>
      ))}
      <input
        className="min-w-[4rem] flex-1 border-0 bg-transparent p-0 text-xs outline-none"
        placeholder="Add value…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            onChange([...list, text.trim()]);
            setText('');
          }
        }}
      />
    </div>
  );
}

function defaultOperator(field: FieldMeta): FilterOperator {
  const ops = UITYPES[field.uitype]?.operators ?? ['equals'];
  if (field.uitype === 'boolean') return 'is_true';
  if (['multipicklist', 'tags', 'multireference'].includes(field.uitype)) return 'has_any';
  if (['string', 'textarea', 'email', 'phone'].includes(field.uitype)) return 'contains';
  return ops[0];
}

/** Human summary of a filter, for the "3 filters applied" chip. */
export function countConditions(filter: FilterGroup | undefined): number {
  if (!filter) return 0;
  return filter.conditions.reduce<number>(
    (n, node) => n + (isFilterGroup(node) ? countConditions(node) : 1),
    0,
  );
}
