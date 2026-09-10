import type { Tx } from '../pool.js';
import type { FieldConfig, FilterGroup, UIType } from '@ipropy/shared';
import { COLUMN_TYPES } from '../../core/metadata/fieldTypes.js';

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
  /**
   * Module-level rules that are not structure. Filled in only when absent, so
   * an admin's change survives a cold start.
   */
  settings?: Record<string, unknown>;
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
  /**
   * The sequence below is the meaning — a pipeline, a scale, a ranking — and
   * must not be sorted A–Z. Everything else is alphabetised on the way out of
   * the registry (migration 114). Written on insert only, like every other
   * admin control here: Admin → Dropdowns is where it is changed afterwards.
   */
  ordered?: boolean;
  values: (string | { value: string; label?: string; color?: string; isDefault?: boolean; meta?: Record<string, unknown> })[];
}

/**
 * Dropdowns and dropdown options an administrator deleted for good (migration 049).
 *
 * Same device, and same reason, as `tombstonedFields` below: this function
 * recreates every seeded dropdown on each run, and the seed runs on every cold
 * start. Without consulting the tombstones, "delete Lost" survives until the
 * next restart — which on a free-tier instance is about an hour, and looks
 * exactly like a broken button.
 *
 * A row with `value = ''` tombstones the whole dropdown.
 */
async function tombstonedValues(conn: Tx, picklistName: string): Promise<Set<string>> {
  const rows = await conn.query<{ value: string }>(
    `SELECT value FROM ipy_picklist_tombstone WHERE picklist_name = $1`,
    [picklistName],
  );
  return new Set(rows.rows.map((r) => r.value));
}

export async function upsertPicklist(conn: Tx, def: PicklistDef): Promise<string | null> {
  const tombstones = await tombstonedValues(conn, def.name);
  if (tombstones.has('')) return null;

  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_picklist (name, label, is_global, is_system, is_ordered)
     VALUES ($1,$2,$3,true,$4)
     ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [def.name, def.label, def.global ?? true, def.ordered ?? false],
  );
  const picklistId = row!.id;

  let seq = 0;
  for (const v of def.values) {
    const item = typeof v === 'string' ? { value: v } : v;
    if (tombstones.has(item.value)) { seq++; continue; }
    // Create-only. Label, colour and order are admin controls in Settings →
    // Picklists, so overwriting them here undid every rename and re-colour on
    // the next seed run — and the seed runs on every cold start, not just on
    // deploy. New values still appear; existing ones are the admin's.
    await conn.query(
      `INSERT INTO ipy_picklist_value (picklist_id, value, label, color, sequence, is_default, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (picklist_id, value) DO NOTHING`,
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
/**
 * Sections an administrator deleted (migration 066).
 *
 * Third instance of the same trap: this function recreates every section on
 * each run, and the seed runs on every cold start, so "delete KYC" held until
 * the container next restarted and then quietly undid itself.
 */
async function tombstonedBlocks(conn: Tx, moduleName: string): Promise<Set<string>> {
  const rows = await conn.query<{ block_name: string }>(
    `SELECT block_name FROM ipy_block_tombstone WHERE module_name = $1`,
    [moduleName],
  );
  return new Set(rows.rows.map((r) => r.block_name));
}

async function tombstonedFields(conn: Tx, moduleName: string): Promise<Set<string>> {
  const rows = await conn.query<{ field_name: string }>(
    `SELECT field_name FROM ipy_field_tombstone WHERE module_name = $1`,
    [moduleName],
  );
  return new Set(rows.rows.map((r) => r.field_name));
}

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

/**
 * One field, upserted into one section.
 *
 * Its own function only because a field whose section has been deleted still
 * needs a home — see `fallbackBlockId` in `upsertModule`.
 */
async function upsertField(
  conn: Tx, def: ModuleDef, moduleId: string, blockId: string, f: FieldDef, fieldSeq: number,
): Promise<void> {
  const storage = f.storage ?? (f.column ? 'column' : 'json');
  const column = f.column ?? f.name;

  /*
    A field somebody renamed must not come back under its old name.

    The upsert below conflicts on `(module_id, name)`, and a rename changes the
    name while never touching `column_name` — records are stored under the
    column. So a renamed field is invisible to that conflict, the template
    inserts a *fresh* row with the original name, and the module ends up with
    two fields writing the same column. Production has four such pairs on
    Properties alone: full_name and name, assigned_to and owner_id, block_tower
    and tower, demand and base_price. Whatever a rep types into one appears in
    the other, and each edit overwrites the last.

    This is the answer to "why does the CRM keep bringing those fields back
    somewhere or the other" — they were never deleted, they were renamed, and
    the seed put the old name back beside the new one on the next cold start.

    So: if some other field on this module already owns the column, that field
    *is* this one under a name the admin chose. Leave it alone entirely — its
    label, type and rules are theirs, and `is_customised` would not protect it
    because this would be an INSERT rather than an UPDATE.
  */
  if (storage === 'column') {
    const claimed = await conn.queryOne<{ name: string }>(
      `SELECT name FROM ipy_field
        WHERE module_id = $1 AND column_name = $2 AND name <> $3 LIMIT 1`,
      [moduleId, column, f.name],
    );
    if (claimed) return;
  }

  if (storage === 'column') await ensureColumn(conn, def.table, column, f);
  await conn.query(
    `INSERT INTO ipy_field AS f
      (module_id, block_id, name, label, uitype, storage, column_name, sequence,
       is_mandatory, is_readonly, is_unique, display_type, default_value, max_length,
       help_text, config, quick_create, mass_editable, searchable)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (module_id, name) DO UPDATE SET
       -- Plumbing, always refreshed: neither is exposed by the field editor
       -- (see the map in api/routes/metadata.ts), and the query builder
       -- breaks if metadata disagrees with where the value actually lives.
       storage = EXCLUDED.storage, column_name = EXCLUDED.column_name,
       -- Everything below is an admin control. Once the field editor has
       -- touched this field, the seed must not have an opinion about it —
       -- otherwise a validation rule or a relabelled field is undone on the
       -- next cold start. Same contract as ipy_layout.is_customised.
       block_id = CASE WHEN f.is_customised THEN f.block_id ELSE EXCLUDED.block_id END,
       label = CASE WHEN f.is_customised THEN f.label ELSE EXCLUDED.label END,
       uitype = CASE WHEN f.is_customised THEN f.uitype ELSE EXCLUDED.uitype END,
       sequence = CASE WHEN f.is_customised THEN f.sequence ELSE EXCLUDED.sequence END,
       is_mandatory = CASE WHEN f.is_customised THEN f.is_mandatory ELSE EXCLUDED.is_mandatory END,
       is_readonly = CASE WHEN f.is_customised THEN f.is_readonly ELSE EXCLUDED.is_readonly END,
       is_unique = CASE WHEN f.is_customised THEN f.is_unique ELSE EXCLUDED.is_unique END,
       display_type = CASE WHEN f.is_customised THEN f.display_type ELSE EXCLUDED.display_type END,
       default_value = CASE WHEN f.is_customised THEN f.default_value ELSE EXCLUDED.default_value END,
       max_length = CASE WHEN f.is_customised THEN f.max_length ELSE EXCLUDED.max_length END,
       help_text = CASE WHEN f.is_customised THEN f.help_text ELSE EXCLUDED.help_text END,
       config = CASE WHEN f.is_customised THEN f.config ELSE EXCLUDED.config END,
       quick_create = CASE WHEN f.is_customised THEN f.quick_create ELSE EXCLUDED.quick_create END,
       mass_editable = CASE WHEN f.is_customised THEN f.mass_editable ELSE EXCLUDED.mass_editable END,
       searchable = CASE WHEN f.is_customised THEN f.searchable ELSE EXCLUDED.searchable END,
       updated_at = now()`,
    [
      moduleId, blockId, f.name, f.label, f.uitype, storage,
      column, fieldSeq,
      f.mandatory ?? false, f.readonly ?? false, f.unique ?? false,
      f.displayType ?? 'default',
      f.default !== undefined ? JSON.stringify(f.default) : null,
      f.maxLength ?? null, f.help ?? null,
      JSON.stringify(f.config ?? {}),
      f.quickCreate ?? false, f.massEditable ?? true, f.searchable ?? false,
    ],
  );
}

export async function upsertModule(conn: Tx, def: ModuleDef): Promise<string> {
  const deleted = await tombstonedFields(conn, def.name);
  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_module
      (name, label, singular_label, table_name, icon, color, sequence, menu_group,
       show_in_menu, label_fields, pipeline_field, duplicate_check_fields, supports_conversion,
       settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (name) DO UPDATE SET
       label = EXCLUDED.label, singular_label = EXCLUDED.singular_label,
       icon = EXCLUDED.icon, color = EXCLUDED.color, sequence = EXCLUDED.sequence,
       menu_group = EXCLUDED.menu_group, show_in_menu = EXCLUDED.show_in_menu,
       label_fields = EXCLUDED.label_fields, pipeline_field = EXCLUDED.pipeline_field,
       duplicate_check_fields = EXCLUDED.duplicate_check_fields,
       supports_conversion = EXCLUDED.supports_conversion,
       -- Structure upserts; settings do not. An admin who changes a validation
       -- rule must not have it undone by the next cold start, so each key is
       -- filled in only when it is absent. Same reasoning as is_customised on
       -- a field.
       settings = EXCLUDED.settings || ipy_module.settings,
       updated_at = now()
     RETURNING id`,
    [
      def.name, def.label, def.singular, def.table, def.icon, def.color, def.sequence,
      def.menuGroup ?? 'CRM', def.showInMenu ?? true,
      JSON.stringify(def.labelFields), def.pipelineField ?? null,
      JSON.stringify(def.duplicateCheckFields ?? []), def.supportsConversion ?? false,
      JSON.stringify(def.settings ?? {}),
    ],
  );
  const moduleId = row!.id;

  const removedBlocks = await tombstonedBlocks(conn, def.name);
  let blockSeq = 0;
  /**
   * Somewhere for a field to go when its section has been deleted.
   *
   * A section can only be deleted once it is empty, so in practice its fields
   * were already moved (which marks them customised, and the upsert below then
   * keeps where they were put) or deleted themselves. This is the safety net
   * for the remaining case: a field added to the template *after* somebody
   * deleted the section it was written into.
   */
  let fallbackBlockId: string | null = null;

  for (const block of def.blocks) {
    if (removedBlocks.has(block.name)) {
      blockSeq++;
      if (fallbackBlockId) {
        for (const f of block.fields) {
          if (deleted.has(f.name)) continue;
          await upsertField(conn, def, moduleId, fallbackBlockId, f, 0);
        }
      }
      continue;
    }
    const blockRow = await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_block AS b (module_id, name, label, sequence, columns, is_collapsed)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (module_id, name) DO UPDATE SET
         -- Order stays the template's; the rest is the admin's once they have
         -- touched it, the same contract ipy_field.is_customised has. Without
         -- this a renamed section reverted on the next cold start.
         label = CASE WHEN b.is_customised THEN b.label ELSE EXCLUDED.label END,
         sequence = EXCLUDED.sequence,
         columns = CASE WHEN b.is_customised THEN b.columns ELSE EXCLUDED.columns END,
         is_collapsed = CASE WHEN b.is_customised THEN b.is_collapsed ELSE EXCLUDED.is_collapsed END
       RETURNING id`,
      [moduleId, block.name, block.label, blockSeq++, block.columns ?? 2, block.collapsed ?? false],
    );
    const blockId = blockRow!.id;
    fallbackBlockId ??= blockId;

    let fieldSeq = 0;
    for (const f of block.fields) {
      if (deleted.has(f.name)) continue;
      await upsertField(conn, def, moduleId, blockId, f, fieldSeq++);
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
      // Create-only. A system view's columns, filter, sort and display mode are
      // all editable from the list view, so re-running the seed used to throw
      // away whatever the admin had arranged. Views added to the template still
      // appear; ones already in the database belong to the admin.
      continue;
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

  // A section an admin deleted must not come back through the layout either.
  //
  // Half of this was already right: `seedBlocks` skips tombstoned sections, so
  // the section itself stayed deleted. The layout was rebuilt from the template
  // regardless, so its `blocks` list kept naming a section that no longer
  // existed. Nothing threw, and the Layout Designer showed a section the admin
  // had already removed, which is the same bug the tombstone was added to fix
  // wearing a different hat.
  const goneBlocks = await tombstonedBlocks(conn, def.name);
  const liveBlocks = def.blocks.filter((b) => !goneBlocks.has(b.name));

  const layoutConfig = {
    blocks: liveBlocks.map((b) => ({
      key: b.name,
      label: b.label,
      columns: (b.columns ?? 2) as 1 | 2 | 3,
      collapsed: b.collapsed ?? false,
      fields: visible(b.fields).map((f) => f.name),
    })),
    // The auto-number is skipped: it is always the first field of the first
    // block, so it always won a header slot, and "LD-00003" is the least useful
    // thing a salesperson opening a lead could be told. It is still on the
    // record, still searchable, and an admin can put it back in the Layout
    // Designer.
    headerFields: visible(liveBlocks[0]?.fields ?? [])
      .filter((f) => f.uitype !== 'autonumber')
      .slice(0, 4)
      .map((f) => f.name),
    relatedLists: (def.relations ?? []).map((r) => r.name),
    /** Which tab a record opens on. Admin-settable in the Layout Designer. */
    defaultTab: 'overview',
    tabs: [
      { key: 'overview', label: 'Overview', icon: 'layout-dashboard' },
      { key: 'timeline', label: 'Timeline', icon: 'activity' },
      // The two-way Contacts ↔ Properties bridge, right after Timeline. The
      // label mirrors the module: on a contact it lists the units, on a unit
      // it lists the people.
      ...(def.name === 'leads' ? [
        { key: 'matching', label: 'Matching property', icon: 'link-2' },
      ] : []),
      ...(def.name === 'properties' ? [
        { key: 'matching', label: 'Matching contacts', icon: 'link-2' },
      ] : []),
      ...(def.name === 'leads' ? [{ key: 'calls', label: 'Calls', icon: 'phone' }] : []),
      { key: 'files', label: 'Files', icon: 'paperclip' },
      ...(def.relations ?? []).map((relation) => ({
        key: `rel:${relation.name}`, label: relation.label, icon: 'link-2',
      })),
    ],
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
    const existing = await conn.queryOne<{ id: string; is_customised: boolean }>(
      `SELECT id, is_customised FROM ipy_layout WHERE module_id = $1 AND type = 'quick_create' AND is_default = true`,
      [mod.id],
    );
    if (existing?.is_customised) {
      // Same rule the detail and edit layouts follow above. This branch was
      // missing the check, so an admin's quick-create arrangement was the one
      // layout the seed still overwrote.
    } else if (existing) {
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
