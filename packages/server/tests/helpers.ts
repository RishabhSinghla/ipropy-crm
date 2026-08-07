/**
 * Test fixtures shared across the server unit tests.
 *
 * These build ModuleMeta/FieldMeta objects the same way `core/metadata/registry.ts`
 * does, so the query builder and permission engine can be exercised without a DB.
 */
import type { FieldMeta, ModuleMeta, UIType } from '@ipropy/shared';

export interface FieldSpec {
  name: string;
  uitype?: UIType;
  storage?: 'column' | 'json';
  columnName?: string;
  isReadonly?: boolean;
  isMandatory?: boolean;
  displayType?: FieldMeta['displayType'];
  /** extra config bag, e.g. `{ __record: true }` for ipy_record-backed fields */
  config?: Record<string, unknown>;
}

/** Build a FieldMeta with the same shape registry.toFieldMeta produces. */
export function field(spec: FieldSpec, moduleName = 'leads'): FieldMeta {
  return {
    id: `f_${moduleName}_${spec.name}`,
    moduleId: `m_${moduleName}`,
    moduleName,
    blockId: null,
    name: spec.name,
    label: spec.name.replace(/_/g, ' '),
    uitype: spec.uitype ?? 'string',
    storage: spec.storage ?? 'column',
    columnName: spec.columnName ?? spec.name,
    sequence: 0,
    isMandatory: spec.isMandatory ?? false,
    isReadonly: spec.isReadonly ?? false,
    isUnique: false,
    isCustom: false,
    isActive: true,
    displayType: spec.displayType ?? 'default',
    defaultValue: null,
    maxLength: null,
    helpText: null,
    config: (spec.config ?? {}) as FieldMeta['config'],
    quickCreate: false,
    massEditable: false,
    searchable: true,
  };
}

export interface ModuleSpec {
  name?: string;
  tableName?: string;
  fields?: FieldMeta[];
  isActive?: boolean;
}

/** Build a ModuleMeta with the standard ipy_record-backed system fields present. */
export function module(spec: ModuleSpec = {}): ModuleMeta {
  const name = spec.name ?? 'leads';
  const base: FieldMeta[] = [
    field(
      { name: 'id', uitype: 'reference', config: { __record: true } },
      name,
    ),
    field({ name: 'owner_id', uitype: 'owner', config: { __record: true } }, name),
    field({ name: 'created_by', uitype: 'user', config: { __record: true } }, name),
    field({ name: 'created_at', uitype: 'datetime', config: { __record: true } }, name),
    field({ name: 'updated_at', uitype: 'datetime', config: { __record: true } }, name),
    field({ name: 'record_number', uitype: 'string', config: { __record: true } }, name),
  ];
  const all = [...base, ...(spec.fields ?? [])];
  return {
    id: `m_${name}`,
    name,
    label: name,
    singularLabel: name,
    tableName: spec.tableName ?? `ipy_e_${name}`,
    icon: '',
    color: '',
    sequence: 0,
    isEntity: true,
    isCustom: false,
    isActive: spec.isActive ?? true,
    labelFields: [],
    pipelineField: null,
    duplicateCheckFields: [],
    supportsComments: false,
    supportsAttachments: false,
    supportsWorkflow: false,
    supportsTags: false,
    blocks: [],
    fields: all,
    relations: [],
  };
}

/** Common user context for builder tests. */
export function ctx(over: Partial<{ userId: string; groupIds: string[]; subordinateIds: string[]; timezone: string }> = {}) {
  return {
    userId: over.userId ?? 'u_1',
    groupIds: over.groupIds ?? [],
    subordinateIds: over.subordinateIds ?? [],
    ...(over.timezone ? { timezone: over.timezone } : {}),
  };
}
