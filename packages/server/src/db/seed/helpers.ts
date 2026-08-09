import type { Tx } from '../pool.js';
import type { FieldConfig, FilterGroup, UIType } from '@ipropy/shared';

/**
 * Declarative seed helpers. The module definitions read like a schema DSL so
 * the real-estate model stays legible instead of drowning in INSERT statements.
 */

export interface FieldDef {
  name: string;
  label: string;
  uitype: UIType;
  /** defaults to 'column' when `column` is given, else 'json' */
  storage?: 'column' | 'json';
  column?: string;
  mandatory?: boolean;
  readonly?: boolean;
  unique?: boolean;
  displayType?: 'default' | 'readonly' | 'hidden' | 'detail_only' | 'create_only';
  default?: unknown;
  maxLength?: number;
  help?: string;
  config?: FieldConfig;
  quickCreate?: boolean;
  massEditable?: boolean;
  searchable?: boolean;
}

export interface BlockDef {
  name: string;
  label: string;
  columns?: number;
  collapsed?: boolean;
  fields: FieldDef[];
}

export interface ModuleDef {
  name: string;
  label: string;
  singular: string;
  table: string;
  icon: string;
  color: string;
  sequence: number;
  menuGroup?: string;
  showInMenu?: boolean;
  labelFields: string[];
  pipelineField?: string;
  duplicateCheckFields?: string[];
  supportsConversion?: boolean;
  blocks: BlockDef[];
  relations?: RelationDef[];
  views?: ViewDef[];
}

export interface RelationDef {
  name: string;
  label: string;
  target: string;
  type: 'one_to_many' | 'many_to_many' | 'many_to_one';
  foreignField?: string;
  actions?: ('add' | 'select' | 'remove')[];
  columns?: string[];
}

export interface ViewDef {
  name: string;
  columns: string[];
  filter?: unknown;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  isDefault?: boolean;
  displayMode?: string;
  groupBy?: string;
  showMetrics?: boolean;
}

export interface PicklistDef {
  name: string;
  label: string;
  global?: boolean;
  values: (string | { value: string; label?: string; color?: string; isDefault?: boolean; meta?: Record<string, unknown> })[];
}

export async function upsertPicklist(conn: Tx, def: PicklistDef): Promise<string> {
  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_picklist (name, label, is_global, is_system)
     VALUES ($1,$2,$3,true)
     ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [def.name, def.label, def.global ?? true],
  );
  const picklistId = row!.id;

  let seq = 0;
  for (const v of def.values) {
    const item = typeof v === 'string' ? { value: v } : v;
    await conn.query(
      `INSERT INTO ipy_picklist_value (picklist_id, value, label, color, sequence, is_default, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (picklist_id, value) DO UPDATE
         SET label = EXCLUDED.label, color = EXCLUDED.color,
             sequence = EXCLUDED.sequence, meta = EXCLUDED.meta`,
      [
        picklistId,
        item.value,
        (item as { label?: string }).label ?? item.value,
        (item as { color?: string }).color ?? null,
        seq++,
        (item as { isDefault?: boolean }).isDefault ?? false,
        JSON.stringify((item as { meta?: Record<string, unknown> }).meta ?? {}),
      ],
    );
  }
  return picklistId;
}

/**
 * Fields an administrator deleted for good (migration 032).
 *
 * The seed is the reason a "delete" on a built-in field could not previously
 * stick: this function rebuilds every module from the definitions below, so a
 * deleted row came straight back on the next run. Consulting the tombstones
 * makes the deletion durable across re-seeds and redeploys.
 */
async function tombstonedFields(conn: Tx, moduleName: string): Promise<Set<string>> {
  const rows = await conn.query<{ field_name: string }>(
    `SELECT field_name FROM ipy_field_tombstone WHERE module_name = $1`,
    [moduleName],
  );
  return new Set(rows.rows.map((r) => r.field_name));
}

/**
 * SQL type behind each column-backed uitype.
 *
 * Mirrors what migrations 002 onwards actually created — verified against the
 * live schema, not guessed. Only used to re-create a column that metadata says
 * should exist but the database is missing.
 */
const COLUMN_TYPES: Record<string, string> = {
  string: 'TEXT', textarea: 'TEXT', richtext: 'TEXT', email: 'TEXT', phone: 'TEXT',
  url: 'TEXT', autonumber: 'TEXT', image: 'TEXT', time: 'TEXT',
  integer: 'INTEGER', score: 'INTEGER',
  decimal: 'NUMERIC', currency: 'NUMERIC', percent: 'NUMERIC', area: 'NUMERIC',
  boolean: 'BOOLEAN', date: 'DATE', datetime: 'TIMESTAMPTZ',
  reference: 'UUID', owner: 'UUID', user: 'UUID',
  json: 'JSONB', address: 'JSONB', multipicklist: 'JSONB', multireference: 'JSONB', tags: 'JSONB',
  picklist: 'TEXT',
};

/**
 * Put back a column the metadata expects but the table does not have.
 *
 * Permanently deleting a built-in field drops its column; if the tombstone is
 * later removed, the seed restores the metadata row and the field would
 * otherwise point at nothing — every read and write against it erroring. The
 * metadata is the source of truth here, so the schema is made to match it.
 *
 * Deliberately additive only: `ADD COLUMN IF NOT EXISTS`, always nullable,
 * never altering or dropping anything. Migrations remain the only thing that
 * changes an existing column.
 */
async function ensureColumn(conn: Tx, table: string, column: string, field: FieldDef): Promise<void> {
  // Some fields are stored on `ipy_record`, not on the module's payload table
  // — `owner_id` above all. Creating a same-named column on the payload table
  // does not fail; it shadows the real one in `SELECT r.*, p.*` and every
  // record silently reads back as unassigned.
  if (field.config?.__record) return;

  const type = COLUMN_TYPES[field.uitype];
  if (!type) return;
  const exists = await conn.queryOne<{ one: number }>(
    `SELECT 1 AS one FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (exists) return;
  await conn.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${column}" ${type}`);
}

export async function upsertModule(conn: Tx, def: ModuleDef): Promise<string> {
  const deleted = await tombstonedFields(conn, def.name);
  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_module
      (name, label, singular_label, table_name, icon, color, sequence, menu_group,
       show_in_menu, label_fields, pipeline_field, duplicate_check_fields, supports_conversion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (name) DO UPDATE SET
       label = EXCLUDED.label, singular_label = EXCLUDED.singular_label,
       icon = EXCLUDED.icon, color = EXCLUDED.color, sequence = EXCLUDED.sequence,
       menu_group = EXCLUDED.menu_group, show_in_menu = EXCLUDED.show_in_menu,
       label_fields = EXCLUDED.label_fields, pipeline_field = EXCLUDED.pipeline_field,
       duplicate_check_fields = EXCLUDED.duplicate_check_fields,
       supports_conversion = EXCLUDED.supports_conversion, updated_at = now()
     RETURNING id`,
    [
      def.name, def.label, def.singular, def.table, def.icon, def.color, def.sequence,
      def.menuGroup ?? 'CRM', def.showInMenu ?? true,
      JSON.stringify(def.labelFields), def.pipelineField ?? null,
      JSON.stringify(def.duplicateCheckFields ?? []), def.supportsConversion ?? false,
    ],
  );
  const moduleId = row!.id;

  let blockSeq = 0;
  for (const block of def.blocks) {
    const blockRow = await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_block (module_id, name, label, sequence, columns, is_collapsed)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (module_id, name) DO UPDATE SET
         label = EXCLUDED.label, sequence = EXCLUDED.sequence,
         columns = EXCLUDED.columns, is_collapsed = EXCLUDED.is_collapsed
       RETURNING id`,
      [moduleId, block.name, block.label, blockSeq++, block.columns ?? 2, block.collapsed ?? false],
    );
    const blockId = blockRow!.id;

    let fieldSeq = 0;
    for (const f of block.fields) {
      if (deleted.has(f.name)) continue;
      const storage = f.storage ?? (f.column ? 'column' : 'json');
      if (storage === 'column') await ensureColumn(conn, def.table, f.column ?? f.name, f);
      await conn.query(
        `INSERT INTO ipy_field
          (module_id, block_id, name, label, uitype, storage, column_name, sequence,
           is_mandatory, is_readonly, is_unique, display_type, default_value, max_length,
           help_text, config, quick_create, mass_editable, searchable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (module_id, name) DO UPDATE SET
           block_id = EXCLUDED.block_id, label = EXCLUDED.label, uitype = EXCLUDED.uitype,
           storage = EXCLUDED.storage, column_name = EXCLUDED.column_name,
           sequence = EXCLUDED.sequence, is_mandatory = EXCLUDED.is_mandatory,
           is_readonly = EXCLUDED.is_readonly, is_unique = EXCLUDED.is_unique,
           display_type = EXCLUDED.display_type, default_value = EXCLUDED.default_value,
           max_length = EXCLUDED.max_length, help_text = EXCLUDED.help_text,
           config = EXCLUDED.config, quick_create = EXCLUDED.quick_create,
           mass_editable = EXCLUDED.mass_editable, searchable = EXCLUDED.searchable,
           updated_at = now()`,
        [
          moduleId, blockId, f.name, f.label, f.uitype, storage,
          f.column ?? f.name, fieldSeq++,
          f.mandatory ?? false, f.readonly ?? false, f.unique ?? false,
          f.displayType ?? 'default',
          f.default !== undefined ? JSON.stringify(f.default) : null,
          f.maxLength ?? null, f.help ?? null,
          JSON.stringify(f.config ?? {}),
          f.quickCreate ?? false, f.massEditable ?? true, f.searchable ?? false,
        ],
      );
    }
  }

  return moduleId;
}

export async function upsertRelations(conn: Tx, moduleName: string, relations: RelationDef[]): Promise<void> {
  const src = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [moduleName]);
  if (!src) return;
  let seq = 0;
  for (const rel of relations) {
    const tgt = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [rel.target]);
    if (!tgt) continue;
    await conn.query(
      `INSERT INTO ipy_relation
        (name, label, source_module_id, target_module_id, type, foreign_field, sequence, actions, columns)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (source_module_id, name) DO UPDATE SET
         label = EXCLUDED.label, target_module_id = EXCLUDED.target_module_id,
         type = EXCLUDED.type, foreign_field = EXCLUDED.foreign_field,
         sequence = EXCLUDED.sequence, actions = EXCLUDED.actions, columns = EXCLUDED.columns`,
      [
        rel.name, rel.label, src.id, tgt.id, rel.type, rel.foreignField ?? null, seq++,
        JSON.stringify(rel.actions ?? ['add', 'select', 'remove']),
        rel.columns ? JSON.stringify(rel.columns) : null,
      ],
    );
  }
}

export async function upsertViews(conn: Tx, moduleName: string, views: ViewDef[]): Promise<void> {
  const mod = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [moduleName]);
  if (!mod) return;

  // Drop system views that a previous seed created but the current definition no
  // longer includes (e.g. renamed), so re-seeding doesn't leave duplicates.
  // Only touches is_system views — a user's saved views are never removed.
  const keep = views.map((v) => v.name);
  await conn.query(
    `DELETE FROM ipy_view WHERE module_id = $1 AND is_system = true AND NOT (name = ANY($2::text[]))`,
    [mod.id, keep],
  );

  let seq = 0;
  for (const v of views) {
    const existing = await conn.queryOne<{ id: string }>(
      `SELECT id FROM ipy_view WHERE module_id = $1 AND name = $2 AND is_system = true`,
      [mod.id, v.name],
    );
    const params = [
      mod.id, v.name,
      JSON.stringify(v.columns),
      JSON.stringify(v.filter ?? { logic: 'AND', conditions: [] }),
      v.sortBy ?? null, v.sortDir ?? 'desc',
      v.isDefault ?? false, v.displayMode ?? 'table',
      v.groupBy ?? null, v.showMetrics ?? false, seq++,
    ];
    if (existing) {
      // Only the columns being updated are bound here — reusing the insert
      // params would leave $1/$2 unreferenced, which Postgres can't type.
      await conn.query(
        `UPDATE ipy_view SET columns = $1, filter = $2, sort_by = $3, sort_dir = $4,
           is_default = $5, display_mode = $6, group_by = $7, show_metrics = $8,
           sequence = $9, updated_at = now()
         WHERE id = $10`,
        [...params.slice(2), existing.id],
      );
    } else {
      await conn.query(
        `INSERT INTO ipy_view
          (module_id, name, columns, filter, sort_by, sort_dir, is_default,
           display_mode, group_by, show_metrics, sequence, is_public, is_system)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,true)`,
        params,
      );
    }
  }
}

/**
 * Build a default detail layout from the module's blocks.
 *
 * Skips any layout an administrator has edited (`is_customised`). Sections,
 * header fields and the default tab are all admin controls now, so re-running
 * the seed after a schema change must not quietly undo somebody's arrangement
 * — which is exactly what the unconditional UPDATE here used to do.
 */
export async function seedDefaultLayouts(conn: Tx, def: ModuleDef): Promise<void> {
  const mod = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [def.name]);
  if (!mod) return;

  const deleted = await tombstonedFields(conn, def.name);
  const visible = (fields: FieldDef[]): FieldDef[] =>
    fields.filter((f) => f.displayType !== 'hidden' && !deleted.has(f.name));

  const layoutConfig = {
    blocks: def.blocks.map((b) => ({
      key: b.name,
      label: b.label,
      columns: (b.columns ?? 2) as 1 | 2 | 3,
      collapsed: b.collapsed ?? false,
      fields: visible(b.fields).map((f) => f.name),
    })),
    headerFields: visible(def.blocks[0]?.fields ?? []).slice(0, 4).map((f) => f.name),
    relatedLists: (def.relations ?? []).map((r) => r.name),
    /** Which tab a record opens on. Admin-settable in the Layout Designer. */
    defaultTab: 'overview',
    sidebar: [
      { type: 'notes', title: 'Notes' },
      { type: 'ai_insights', title: 'AI Insights' },
    ],
  };

  for (const type of ['detail', 'edit'] as const) {
    const existing = await conn.queryOne<{ id: string; is_customised: boolean }>(
      `SELECT id, is_customised FROM ipy_layout WHERE module_id = $1 AND type = $2 AND is_default = true`,
      [mod.id, type],
    );
    if (existing?.is_customised) continue;
    if (existing) {
      await conn.query(`UPDATE ipy_layout SET config = $2, updated_at = now() WHERE id = $1`, [
        existing.id, JSON.stringify(layoutConfig),
      ]);
    } else {
      await conn.query(
        `INSERT INTO ipy_layout (module_id, name, type, is_default, config)
         VALUES ($1,$2,$3,true,$4)`,
        [mod.id, `Default ${type} layout`, type, JSON.stringify(layoutConfig)],
      );
    }
  }

  // Quick-create shows only the fields flagged for it.
  const quickFields = def.blocks.flatMap((b) => b.fields)
    .filter((f) => f.quickCreate && !deleted.has(f.name)).map((f) => f.name);
  if (quickFields.length) {
    const quickConfig = {
      blocks: [{ key: 'quick', label: `New ${def.singular}`, columns: 2 as const, fields: quickFields }],
    };
    const existing = await conn.queryOne<{ id: string }>(
      `SELECT id FROM ipy_layout WHERE module_id = $1 AND type = 'quick_create' AND is_default = true`,
      [mod.id],
    );
    if (existing) {
      await conn.query(`UPDATE ipy_layout SET config = $2 WHERE id = $1`, [existing.id, JSON.stringify(quickConfig)]);
    } else {
      await conn.query(
        `INSERT INTO ipy_layout (module_id, name, type, is_default, config)
         VALUES ($1,'Quick create','quick_create',true,$2)`,
        [mod.id, JSON.stringify(quickConfig)],
      );
    }
  }
}

/**
 * Merge a builder's own config with the caller's.
 *
 * `{ ...extra }` replaces `config` wholesale, so `F.money('x','X',{config:{min:0}})`
 * silently dropped `currency: 'INR'` and the field stopped formatting as rupees.
 * Every builder that sets a config of its own goes through here instead.
 */
function withConfig(base: FieldConfig, extra: Partial<FieldDef>): Partial<FieldDef> {
  return { ...extra, config: { ...base, ...(extra.config ?? {}) } };
}

/** Convenience builders so field definitions stay one-liners. */
export const F = {
  text: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'string', column: name, ...extra }),
  area: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'area', column: name, ...withConfig({ unit: 'sqft' }, extra) }),
  money: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'currency', column: name, ...withConfig({ currency: 'INR' }, extra) }),
  pick: (name: string, label: string, picklist: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'picklist', column: name, ...withConfig({ picklist, colored: true }, extra) }),
  multipick: (name: string, label: string, picklist: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'multipicklist', column: name, ...withConfig({ picklist }, extra) }),
  ref: (name: string, label: string, modules: string[], extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'reference', column: name, ...withConfig({ referenceModules: modules }, extra) }),
  num: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'integer', column: name, ...extra }),
  rollup: (
    name: string,
    label: string,
    relation: string,
    aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max',
    extra: Partial<FieldDef> & { field?: string; filter?: FilterGroup } = {},
  ): FieldDef => {
    const { field, filter, ...rest } = extra;
    return {
      name, label, uitype: 'rollup', column: name, readonly: true, ...rest,
      config: { rollup: { relation, aggregate, field, filter } },
    };
  },
  dec: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'decimal', column: name, ...extra }),
  pct: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'percent', column: name, ...extra }),
  date: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'date', column: name, ...extra }),
  datetime: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'datetime', column: name, ...extra }),
  bool: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'boolean', column: name, default: false, ...extra }),
  email: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'email', column: name, searchable: true, ...extra }),
  phone: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'phone', column: name, searchable: true, ...extra }),
  url: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'url', column: name, ...extra }),
  textarea: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'textarea', column: name, ...withConfig({ fullWidth: true, rows: 4 }, extra) }),
  address: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'address', column: name, ...withConfig({ fullWidth: true }, extra) }),
  json: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'json', column: name, ...extra }),
  tags: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'tags', column: name, ...extra }),
  score: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'score', column: name, readonly: true, ...extra }),
  autonum: (name: string, label: string, prefix: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({
      name, label, uitype: 'autonumber', column: name, readonly: true, searchable: true,
      ...withConfig({ numbering: { prefix, digits: 5, start: 1 } }, extra),
    }),
  owner: (): FieldDef =>
    ({ name: 'owner_id', label: 'Assigned To', uitype: 'owner', column: 'owner_id', storage: 'column', config: { __record: true } as FieldConfig, quickCreate: true }),
  image: (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef =>
    ({ name, label, uitype: 'image', column: name, ...extra }),
};
