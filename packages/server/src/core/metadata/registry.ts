/**
 * Metadata registry — the in-memory mirror of ipy_module / ipy_block /
 * ipy_field / ipy_picklist / ipy_relation.
 *
 * Everything downstream (query builder, record service, validation, the API's
 * describe endpoints, the React renderer) reads metadata through here rather
 * than hitting the DB, because it is read on essentially every request.
 * `invalidate()` is called by the admin endpoints whenever metadata changes.
 */
import {
  UITYPES,
  type BlockMeta,
  type FieldConfig,
  type FieldMeta,
  type ModuleMeta,
  type PicklistOption,
  type RelationMeta,
  type UIType,
} from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { NotFoundError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

interface RegistryCache {
  modules: Map<string, ModuleMeta>;     // by name
  modulesById: Map<string, ModuleMeta>;
  picklists: Map<string, PicklistOption[]>; // by picklist name
  dependencies: Map<string, PicklistDependency[]>; // by module name
  loadedAt: number;
}

export interface PicklistDependency {
  sourceField: string;
  targetField: string;
  mapping: Record<string, string[]>;
}

let cache: RegistryCache | null = null;
let loading: Promise<RegistryCache> | null = null;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ModuleRow {
  id: string;
  name: string;
  label: string;
  singular_label: string;
  table_name: string;
  icon: string;
  color: string;
  sequence: number;
  is_entity: boolean;
  is_custom: boolean;
  is_active: boolean;
  show_in_menu: boolean;
  menu_group: string;
  label_fields: string[];
  pipeline_field: string | null;
  duplicate_check_fields: string[];
  supports_comments: boolean;
  supports_attachments: boolean;
  supports_workflow: boolean;
  supports_tags: boolean;
  supports_conversion: boolean;
  settings: Record<string, unknown>;
  is_core: boolean;
  disabled_reason: string | null;
  disabled_at: string | null;
}

interface BlockRow {
  id: string;
  module_id: string;
  name: string;
  label: string;
  sequence: number;
  is_collapsed: boolean;
  columns: number;
  visible_when: unknown;
}

interface FieldRow {
  id: string;
  module_id: string;
  block_id: string | null;
  name: string;
  label: string;
  uitype: string;
  storage: 'column' | 'json';
  column_name: string;
  sequence: number;
  is_mandatory: boolean;
  is_readonly: boolean;
  is_unique: boolean;
  is_custom: boolean;
  is_active: boolean;
  display_type: FieldMeta['displayType'];
  default_value: unknown;
  max_length: number | null;
  help_text: string | null;
  config: FieldConfig;
  quick_create: boolean;
  mass_editable: boolean;
  searchable: boolean;
}

interface RelationRow {
  id: string;
  name: string;
  label: string;
  source_module: string;
  target_module: string;
  type: RelationMeta['type'];
  foreign_field: string | null;
  sequence: number;
  actions: RelationMeta['actions'];
  columns: string[] | null;
  is_active: boolean;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(conn: Tx = db): Promise<RegistryCache> {
  const [moduleRes, blockRes, fieldRes, relationRes, picklistRes, depRes] = await Promise.all([
    conn.query<ModuleRow>(`SELECT * FROM ipy_module ORDER BY sequence, label`),
    conn.query<BlockRow>(`SELECT * FROM ipy_block WHERE is_active ORDER BY sequence`),
    conn.query<FieldRow>(`SELECT * FROM ipy_field ORDER BY sequence`),
    conn.query<RelationRow>(`
      SELECT r.id, r.name, r.label, r.type, r.foreign_field, r.sequence, r.actions,
             r.columns, r.is_active,
             sm.name AS source_module, tm.name AS target_module
      FROM ipy_relation r
      JOIN ipy_module sm ON sm.id = r.source_module_id
      JOIN ipy_module tm ON tm.id = r.target_module_id
      WHERE r.is_active
      ORDER BY r.sequence
    `),
    conn.query<{ picklist_name: string; value: string; label: string; color: string | null; sequence: number; is_active: boolean; is_default: boolean; meta: Record<string, unknown> }>(`
      SELECT p.name AS picklist_name, v.value, v.label, v.color, v.sequence,
             v.is_active, v.is_default, v.meta
      FROM ipy_picklist p
      JOIN ipy_picklist_value v ON v.picklist_id = p.id
      ORDER BY p.name, v.sequence, v.label
    `),
    conn.query<{ module_name: string; source_field: string; target_field: string; mapping: Record<string, string[]> }>(`
      SELECT m.name AS module_name, d.source_field, d.target_field, d.mapping
      FROM ipy_picklist_dependency d
      JOIN ipy_module m ON m.id = d.module_id
      WHERE d.is_active
    `),
  ]);

  // picklists
  const picklists = new Map<string, PicklistOption[]>();
  for (const row of picklistRes.rows) {
    const list = picklists.get(row.picklist_name) ?? [];
    list.push({
      value: row.value,
      label: row.label,
      color: row.color,
      sequence: row.sequence,
      isActive: row.is_active,
      isDefault: row.is_default,
      ...(row.meta && Object.keys(row.meta).length ? { meta: row.meta } : {}),
    } as PicklistOption);
    picklists.set(row.picklist_name, list);
  }

  // dependencies
  const dependencies = new Map<string, PicklistDependency[]>();
  for (const row of depRes.rows) {
    const list = dependencies.get(row.module_name) ?? [];
    list.push({ sourceField: row.source_field, targetField: row.target_field, mapping: row.mapping });
    dependencies.set(row.module_name, list);
  }

  // group blocks + fields by module
  const blocksByModule = new Map<string, BlockRow[]>();
  for (const b of blockRes.rows) {
    const list = blocksByModule.get(b.module_id) ?? [];
    list.push(b);
    blocksByModule.set(b.module_id, list);
  }

  const fieldsByModule = new Map<string, FieldRow[]>();
  for (const f of fieldRes.rows) {
    const list = fieldsByModule.get(f.module_id) ?? [];
    list.push(f);
    fieldsByModule.set(f.module_id, list);
  }

  const relationsBySource = new Map<string, RelationRow[]>();
  for (const r of relationRes.rows) {
    const list = relationsBySource.get(r.source_module) ?? [];
    list.push(r);
    relationsBySource.set(r.source_module, list);
  }   const modules = new Map<string, ModuleMeta>();
  const modulesById = new Map<string, ModuleMeta>();

  for (const m of moduleRes.rows) {
    const rawFields = fieldsByModule.get(m.id) ?? [];
    const fields: FieldMeta[] = rawFields.map((f) => toFieldMeta(f, m.name, picklists));
    syncCountryCodes(fields);

    const fieldsByBlock = new Map<string, FieldMeta[]>();
    for (const f of fields) {
      if (!f.blockId) continue;
      const list = fieldsByBlock.get(f.blockId) ?? [];
      list.push(f);
      fieldsByBlock.set(f.blockId, list);
    }

    const blockOrder = new Map<string, number>();
    for (const b of (blocksByModule.get(m.id) ?? [])) blockOrder.set(b.id, b.sequence);

    /*
      The flat `fields` list follows the layout: block order first, then the
      field's own sequence inside its block. `ipy_field.sequence` restarts at
      zero in every block, so ordering by it alone leaves fields from different
      blocks tied and Postgres free to return them in any physical order —
      the same seed produced "first currency field = Base Price" on one
      database and "Monthly Rent" on another, and every consumer that asks
      for the first of a uitype (the reports builder's default money column)
      picks whichever the database happened to return. Fields with no block
      sort after every block, by sequence, so they stay stable too.
    */
    const layoutOrdered = [...fields].sort((a, z) => {
      const ba = a.blockId ? blockOrder.get(a.blockId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      const bz = z.blockId ? blockOrder.get(z.blockId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      return ba !== bz ? ba - bz : a.sequence - z.sequence;
    });

    const blocks: BlockMeta[] = (blocksByModule.get(m.id) ?? []).map((b) => ({
      id: b.id,
      moduleId: b.module_id,
      name: b.name,
      label: b.label,
      sequence: b.sequence,
      isCollapsed: b.is_collapsed,
      columns: b.columns,
      ...(b.visible_when ? { visibleWhen: b.visible_when as BlockMeta['visibleWhen'] } : {}),
      fields: (fieldsByBlock.get(b.id) ?? []).sort((a, z) => a.sequence - z.sequence),
    }));

    const relations: RelationMeta[] = (relationsBySource.get(m.name) ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      sourceModule: r.source_module,
      targetModule: r.target_module,
      type: r.type,
      foreignField: r.foreign_field,
      sequence: r.sequence,
      actions: r.actions,
      columns: r.columns ?? undefined,
      isActive: r.is_active,
    }));

    const meta: ModuleMeta = {
      id: m.id,
      name: m.name,
      label: m.label,
      singularLabel: m.singular_label,
      tableName: m.table_name,
      icon: m.icon,
      color: m.color,
      sequence: m.sequence,
      isEntity: m.is_entity,
      isCustom: m.is_custom,
      isActive: m.is_active,
      labelFields: m.label_fields ?? [],
      pipelineField: m.pipeline_field,
      duplicateCheckFields: m.duplicate_check_fields ?? [],
      duplicateCheckMode: m.settings?.duplicateCheckMode === 'all' ? 'all' : 'any',
      requireOneOf: Array.isArray(m.settings?.requireOneOf)
        ? (m.settings.requireOneOf as string[][]).filter((g) => Array.isArray(g) && g.length > 1)
        : [],
      supportsComments: m.supports_comments,
      supportsAttachments: m.supports_attachments,
      supportsWorkflow: m.supports_workflow,
      supportsTags: m.supports_tags,
      blocks,
      fields: layoutOrdered,
      relations,
    };
    // extra server-only bits ride along on the object without widening the shared type
    Object.assign(meta, {
      showInMenu: m.show_in_menu,
      menuGroup: m.menu_group,
      supportsConversion: m.supports_conversion,
      settings: m.settings ?? {},
      isCore: m.is_core,
      disabledReason: m.disabled_reason,
      disabledAt: m.disabled_at,
    });

    modules.set(m.name, meta);
    modulesById.set(m.id, meta);
  }

  return { modules, modulesById, picklists, dependencies, loadedAt: Date.now() };
}

/**
 * Make the phone control's country dropdown *be* the country picklist.
 *
 * A mobile field carries `config.countryCodes` — the list the little dropdown
 * welded to the left of the number renders — and `config.digitsFrom`, naming
 * the picklist field that stores the chosen code. Those were two separate
 * lists that happened to be seeded with the same contents, and only one of
 * them is the one an admin edits.
 *
 * So: delete every code except +91 in Admin → Dropdowns, and the dropdown on
 * every lead form goes on offering eleven countries, because it was reading
 * the copy. The seeded config even says it "mirrors the picklist", which it
 * did exactly once, at seed time. Deriving it here means the admin's edit is
 * the only list there is, it survives a restart, and it needs no migration —
 * the registry is rebuilt on every metadata write.
 */
function syncCountryCodes(fields: FieldMeta[]): void {
  const byName = new Map(fields.map((f) => [f.name, f]));

  for (const field of fields) {
    if (field.uitype !== 'phone' || !field.config.digitsFrom) continue;

    const source = byName.get(String(field.config.digitsFrom));
    if (!source?.options) continue;

    field.config = {
      ...field.config,
      countryCodes: source.options.map((o) => ({ value: o.value, label: o.label })),
    };
  }
}

function toFieldMeta(f: FieldRow, moduleName: string, picklists: Map<string, PicklistOption[]>): FieldMeta {
  const config = (f.config ?? {}) as FieldConfig;
  const meta: FieldMeta = {
    id: f.id,
    moduleId: f.module_id,
    moduleName,
    blockId: f.block_id,
    name: f.name,
    label: f.label,
    uitype: f.uitype as UIType,
    storage: f.storage,
    columnName: f.column_name,
    sequence: f.sequence,
    isMandatory: f.is_mandatory,
    isReadonly: f.is_readonly,
    isUnique: f.is_unique,
    isCustom: f.is_custom,
    isActive: f.is_active,
    displayType: f.display_type,
    defaultValue: f.default_value,
    maxLength: f.max_length,
    helpText: f.help_text,
    config,
    quickCreate: f.quick_create,
    massEditable: f.mass_editable,
    searchable: f.searchable,
  };
  if ((f.uitype === 'picklist' || f.uitype === 'multipicklist') && config.picklist) {
    meta.options = (picklists.get(config.picklist) ?? []).filter((o) => o.isActive);
  }
  return meta;
}

async function getCache(): Promise<RegistryCache> {
  if (cache) return cache;
  if (loading) return loading;
  loading = load()
    .then((c) => {
      cache = c;
      loading = null;
      logger.debug({ modules: c.modules.size }, 'metadata registry loaded');
      return c;
    })
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** Drop the cache so the next read reloads from the DB. */
export function invalidate(): void {
  cache = null;
}

/** Eagerly warm the registry at boot so the first request isn't slow. */
export async function warmup(): Promise<void> {
  invalidate();
  await getCache();
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export async function getModules(opts: { activeOnly?: boolean; entityOnly?: boolean } = {}): Promise<ModuleMeta[]> {
  const c = await getCache();
  let list = [...c.modules.values()];
  if (opts.activeOnly !== false) list = list.filter((m) => m.isActive);
  if (opts.entityOnly) list = list.filter((m) => m.isEntity);
  return list.sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label));
}

export async function getModule(name: string): Promise<ModuleMeta | null> {
  const c = await getCache();
  return c.modules.get(name) ?? null;
}

/**
 * Same as getModule but throws a 404 — the common case in route handlers.
 * A disabled module is treated as absent so no data leaks through an API route
 * after an admin switches it off.
 */
export async function requireModule(name: string, opts: { allowDisabled?: boolean } = {}): Promise<ModuleMeta> {
  const m = await getModule(name);
  if (!m) throw new NotFoundError(`Unknown module '${name}'`);
  if (!m.isActive && !opts.allowDisabled) {
    throw new NotFoundError(`${m.label} is currently disabled. An administrator can re-enable it in Admin → Modules.`);
  }
  return m;
}

export async function getModuleById(id: string): Promise<ModuleMeta | null> {
  const c = await getCache();
  return c.modulesById.get(id) ?? null;
}

export async function getField(moduleName: string, fieldName: string): Promise<FieldMeta | null> {
  const m = await getModule(moduleName);
  if (!m) return null;
  return m.fields.find((f) => f.name === fieldName) ?? null;
}

export async function requireField(moduleName: string, fieldName: string): Promise<FieldMeta> {
  const f = await getField(moduleName, fieldName);
  if (!f) throw new NotFoundError(`Unknown field '${fieldName}' on module '${moduleName}'`);
  return f;
}

/**
 * The field playing a known role, found by where its data lives rather than by
 * what it is currently called.
 *
 * An admin can rename any field's API name. That rewrites every view, filter,
 * layout and workflow that mentions it, and it deliberately leaves
 * `column_name` alone — the data does not move. So the column is the stable
 * identity and the name is not, and any code holding a literal field name is
 * holding the half that changes.
 *
 * That is what made "Lead Status" un-renameable: a handful of features looked
 * for a field *named* `status`, so renaming it to `lead_status` would have left
 * them looking for something that no longer existed. Anchored here instead,
 * they follow the rename by themselves and the admin can call it whatever they
 * like.
 *
 * Use this wherever the field is decided by the code. Keep `getField` for a
 * name that came from a saved view, a filter or a request — there the name is
 * genuinely what was asked for.
 */
export function fieldPlaying(module: ModuleMeta, column: string): FieldMeta | null {
  return module.fields.find((f) => f.columnName === column) ?? null;
}

/** Fields that actually hold data — excludes inactive and pure-UI entries. */
export async function getWritableFields(moduleName: string): Promise<FieldMeta[]> {
  const m = await requireModule(moduleName);
  return m.fields.filter(
    (f) => f.isActive && !f.isReadonly && f.displayType !== 'hidden' && !UITYPES[f.uitype]?.computed,
  );
}

export async function getPicklist(name: string): Promise<PicklistOption[]> {
  const c = await getCache();
  return c.picklists.get(name) ?? [];
}

export async function getAllPicklists(): Promise<Record<string, PicklistOption[]>> {
  const c = await getCache();
  return Object.fromEntries(c.picklists);
}

export async function getPicklistDependencies(moduleName: string): Promise<PicklistDependency[]> {
  const c = await getCache();
  return c.dependencies.get(moduleName) ?? [];
}

export async function getRelation(moduleName: string, relationName: string): Promise<RelationMeta | null> {
  const m = await getModule(moduleName);
  if (!m) return null;
  return m.relations.find((r) => r.name === relationName) ?? null;
}

/**
 * Modules that hold a reference field pointing at `moduleName`. Used to build
 * "related lists" automatically and to cascade label changes.
 */
export async function getInboundReferences(
  moduleName: string,
): Promise<{ module: ModuleMeta; field: FieldMeta }[]> {
  const modules = await getModules({ entityOnly: true });
  const out: { module: ModuleMeta; field: FieldMeta }[] = [];
  for (const m of modules) {
    for (const f of m.fields) {
      if (f.uitype !== 'reference' && f.uitype !== 'multireference') continue;
      const targets = f.config.referenceModules ?? [];
      if (targets.includes(moduleName)) out.push({ module: m, field: f });
    }
  }
  return out;
}

/** Field-name → FieldMeta map, handy in hot loops. */
export async function getFieldMap(moduleName: string): Promise<Map<string, FieldMeta>> {
  const m = await requireModule(moduleName);
  return new Map(m.fields.map((f) => [f.name, f]));
}

export const registry = {
  getModules,
  getModule,
  requireModule,
  getModuleById,
  getField,
  requireField,
  fieldPlaying,
  getWritableFields,
  getFieldMap,
  getPicklist,
  getAllPicklists,
  getPicklistDependencies,
  getRelation,
  getInboundReferences,
  invalidate,
  warmup,
};
