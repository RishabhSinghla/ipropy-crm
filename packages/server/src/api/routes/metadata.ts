import { Router } from 'express';
import { invalidatePublicFields } from './public.js';
import { z } from 'zod';
import { UITYPE_LIST, UITYPES } from '@ipropy/shared';
import { db, transaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { registry } from '../../core/metadata/registry.js';
import {
  countRecordsWithValue, fieldsThatCannotBeCleared, fieldsUsingPicklist,
  PICKLISTS_USED_IN_CODE, replaceValueInRecords, valueUsedInCode,
} from '../../core/metadata/picklists.js';
import { interchangeableTypes } from '../../core/metadata/fieldTypes.js';
import { FIELDS_USED_IN_CODE, removeFieldEverywhere, renameFieldEverywhere } from '../../core/metadata/fieldRename.js';
import { assertCapability, canAccessModule, getFieldPermissions, getModulePermission, hasCapability, invalidatePermissions } from '../../core/permissions/index.js';
import { FORMULA_FUNCTIONS, validateFormula } from '../../core/entity/formula.js';
import { quoteIdent } from '../../core/query/builder.js';
import { previewNumber } from '../../core/entity/numbering.js';
import { convertFieldValue, type ConversionPlan } from '../../core/metadata/fieldConversion.js';

export const metadataRouter = Router();
metadataRouter.use(requireAuth);
/**
 * A connected app needs to *read* the schema — an assistant cannot fill in a
 * lead without knowing the module's fields. Reshaping it is a different act
 * entirely, and one nobody should be able to do with a string in a config
 * file, so every write here stays behind a signed-in session.
 */
metadataRouter.use((req, res, next) => (req.method === 'GET' ? next() : blockApiKey(req, res, next)));

/** Reload metadata + permission caches after any admin change. */
function invalidateAll(): void {
  registry.invalidate();
  invalidatePermissions();
  // The public website's field list is worked out from the columns that exist,
  // so a field deleted here changes it. Without this the site keeps asking for
  // a column that has just gone and answers 400 until the next restart.
  invalidatePublicFields();
}

// ---------------------------------------------------------------------------
// Describe (read paths — available to every signed-in user)
// ---------------------------------------------------------------------------

/** The app shell: modules the user can see, grouped for the nav. */
metadataRouter.get('/modules', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const modules = await registry.getModules({ entityOnly: false });
  const out = [];
  for (const m of modules) {
    const perm = await getModulePermission(user, m.name);
    if (!perm.view) continue;
    out.push({
      id: m.id, name: m.name, label: m.label, singularLabel: m.singularLabel,
      icon: m.icon, color: m.color, sequence: m.sequence,
      isEntity: m.isEntity, isCustom: m.isCustom,
      pipelineField: m.pipelineField,
      supportsComments: m.supportsComments,
      supportsAttachments: m.supportsAttachments,
      supportsTags: m.supportsTags,
      supportsConversion: m.supportsConversion ?? false,
      menuGroup: m.menuGroup ?? 'CRM',
      showInMenu: m.showInMenu ?? true,
      // Modules naming the same `settings.tabGroup` render as tabs of one
      // another — one menu entry for Properties and Projects, say. The UI reads
      // this generically, so an admin can group custom modules the same way.
      settings: m.settings ?? {},
      permissions: perm,
    });
  }
  res.json(out);
}));

/**
 * Every module including disabled ones, with record counts — the admin
 * enable/disable screen. Deliberately separate from GET /modules, which powers
 * the nav and must never surface a module that is switched off.
 */
metadataRouter.get('/modules/all', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.modules');
  const modules = await registry.getModules({ activeOnly: false });

  const counts = await db.query<{ module_id: string; count: number }>(
    `SELECT module_id, COUNT(*)::int AS count FROM ipy_record WHERE is_deleted = false GROUP BY module_id`,
  );
  const countByModule = new Map(counts.rows.map((c) => [c.module_id, c.count]));

  // A module other modules point at cannot be disabled without breaking their
  // lookups, so surface the dependency rather than letting the admin find out later.
  const dependents = new Map<string, string[]>();
  for (const m of modules) {
    for (const f of m.fields) {
      if (f.uitype !== 'reference' && f.uitype !== 'multireference') continue;
      for (const target of f.config.referenceModules ?? []) {
        if (target === m.name) continue;
        const list = dependents.get(target) ?? [];
        if (!list.includes(m.label)) list.push(m.label);
        dependents.set(target, list);
      }
    }
  }

  res.json(modules.map((m) => {
    return {
      id: m.id, name: m.name, label: m.label, singularLabel: m.singularLabel,
      icon: m.icon, color: m.color, sequence: m.sequence,
      isActive: m.isActive, isCustom: m.isCustom, isEntity: m.isEntity,
      isCore: m.isCore ?? false,
      disabledReason: m.disabledReason ?? null,
      menuGroup: m.menuGroup ?? 'CRM',
      showInMenu: m.showInMenu ?? true,
      fieldCount: m.fields.length,
      recordCount: countByModule.get(m.id) ?? 0,
      dependents: dependents.get(m.name) ?? [],
    };
  }));
}));

/** Minimal all-module index for the field builder, including disabled modules. */
metadataRouter.get('/modules/field-builder', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const modules = await registry.getModules({ activeOnly: false });

  res.json(modules.map((m) => ({
    id: m.id,
    name: m.name,
    label: m.label,
    icon: m.icon,
    color: m.color,
    isActive: m.isActive,
    isCustom: m.isCustom,
    isEntity: m.isEntity,
    fieldCount: m.fields.length,
  })));
}));

/** Enable or disable a module. Data is retained either way. */
metadataRouter.post('/modules/:name/toggle', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.modules');

  const { isActive, reason } = z.object({
    isActive: z.boolean(),
    reason: z.string().max(280).optional(),
  }).parse(req.body);

  const module = await registry.requireModule(req.params.name, { allowDisabled: true });
  const isCore = (module as unknown as { isCore?: boolean }).isCore;

  if (!isActive && isCore) {
    throw new BadRequestError(
      `${module.label} is a core module and cannot be disabled — the rest of the CRM depends on it.`,
    );
  }

  // Do NOT touch show_in_menu here. The nav (GET /meta/modules) already filters
  // by is_active, so a disabled module is hidden regardless. Clobbering
  // show_in_menu on disable left it false forever — re-enabling never restored
  // it, so a module that had been switched off once stayed missing from the
  // sidebar even after being turned back on. Menu visibility is edited
  // separately (ModuleBuilder), so leave the admin's choice intact.
  await db.query(
    `UPDATE ipy_module
     SET is_active = $2,
         disabled_reason = CASE WHEN $2 THEN NULL ELSE $3 END,
         disabled_at = CASE WHEN $2 THEN NULL ELSE now() END,
         disabled_by = CASE WHEN $2 THEN NULL ELSE $4::uuid END,
         updated_at = now()
     WHERE id = $1`,
    [module.id, isActive, reason ?? null, user.id],
  );

  invalidateAll();

  // Disabling hides the module and its data everywhere; nothing is deleted, so
  // re-enabling restores the records exactly as they were.
  res.json({
    ok: true,
    module: module.name,
    isActive,
    message: isActive
      ? `${module.label} is enabled and back in the navigation.`
      : `${module.label} is hidden. Its ${module.label.toLowerCase()} records are retained and return when you re-enable it.`,
  });
}));

/** Full describe for one module: blocks, fields, options, relations, layouts. */
metadataRouter.get('/modules/:name', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const includeInactive = req.query.includeInactive === 'true' && await hasCapability(user, 'admin.fields');
  const module = await registry.requireModule(req.params.name, { allowDisabled: includeInactive });
  if (!includeInactive && !(await canAccessModule(user, module.name, 'view'))) {
    throw new NotFoundError(`Unknown module '${req.params.name}'`);
  }

  // The field builder needs to see hidden/inactive fields to manage them —
  // every other screen must not, or a field an admin hid is still fetchable
  // by name/label/config one API call away even though its value is stripped.
  const fieldPerms = includeInactive
    ? new Map(module.fields.map((f) => [f.name, f.isReadonly ? 'readonly' as const : 'editable' as const]))
    : await getFieldPermissions(user, module.name);
  const visible = (f: { name: string; isActive: boolean; displayType: string }): boolean =>
    includeInactive || (fieldPerms.get(f.name) !== 'hidden' && f.isActive && f.displayType !== 'hidden');

  const [layouts, dependencies] = await Promise.all([
    db.query<{ id: string; name: string; type: string; is_default: boolean; config: unknown }>(
      `SELECT id, name, type, is_default, config FROM ipy_layout
       WHERE module_id = $1 AND is_active ORDER BY type, sequence`,
      [module.id],
    ),
    registry.getPicklistDependencies(module.name),
  ]);

  res.json({
    ...module,
    fields: module.fields
      .filter(visible)
      .map((f) => ({ ...f, permission: fieldPerms.get(f.name) ?? 'editable' })),
    blocks: module.blocks.map((b) => ({
      ...b,
      fields: b.fields.filter(visible).map((f) => ({ ...f, permission: fieldPerms.get(f.name) ?? 'editable' })),
    })),
    layouts: layouts.rows,
    picklistDependencies: dependencies,
    permissions: await getModulePermission(user, module.name),
    supportsConversion: (module as unknown as { supportsConversion?: boolean }).supportsConversion ?? false,
  });
}));

metadataRouter.get('/picklists', asyncHandler(async (_req, res) => {
  res.json(await registry.getAllPicklists());
}));

metadataRouter.get('/picklists/:name', asyncHandler(async (req, res) => {
  const values = await registry.getPicklist(req.params.name);
  if (!values.length) {
    const exists = await db.queryOne(`SELECT 1 FROM ipy_picklist WHERE name = $1`, [req.params.name]);
    if (!exists) throw new NotFoundError(`Unknown picklist '${req.params.name}'`);
  }
  res.json(values);
}));

/** Shared master data for every area and budget/demand field. */
metadataRouter.get('/masters/units/:kind', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const kind = z.enum(['area', 'budget_demand']).parse(req.params.kind);
  const rows = await db.query(
    `SELECT id, kind, value, label, factor_sqft AS "factorSqft", sequence,
            is_active AS "isActive", is_default AS "isDefault"
       FROM ipy_unit_master WHERE kind = $1 ORDER BY sequence, label`,
    [kind],
  );
  res.json(rows.rows);
}));

metadataRouter.put('/masters/units/:kind', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.fields');
  const kind = z.enum(['area', 'budget_demand']).parse(req.params.kind);
  const units = z.array(z.object({
    id: z.string().uuid().optional(),
    value: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    label: z.string().min(1).max(80),
    factorSqft: z.number().positive().nullable().optional(),
    isActive: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  })).min(1).parse(req.body.units);
  if (units.filter((u) => u.isDefault).length > 1) throw new BadRequestError('Choose only one default unit.');
  await transaction(async (tx) => {
    for (const [sequence, unit] of units.entries()) {
      await tx.query(
        `INSERT INTO ipy_unit_master (id, kind, value, label, factor_sqft, sequence, is_active, is_default, updated_at)
         VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (kind, value) DO UPDATE SET label = EXCLUDED.label, factor_sqft = EXCLUDED.factor_sqft,
           sequence = EXCLUDED.sequence, is_active = EXCLUDED.is_active, is_default = EXCLUDED.is_default, updated_at = now()`,
        [unit.id ?? null, kind, unit.value, unit.label, unit.factorSqft ?? null, sequence, unit.isActive, unit.isDefault],
      );
    }
  });
  invalidateAll();
  res.json({ ok: true });
}));

/** Everything the field builder needs to render its type picker. */
metadataRouter.get('/uitypes', asyncHandler(async (_req, res) => {
  res.json({ uitypes: UITYPE_LIST, formulaFunctions: FORMULA_FUNCTIONS });
}));

/** Structural history stays with the Field ID, even after an API-name rename. */
metadataRouter.get('/fields/:id/history', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const field = await db.queryOne<{ internal_id: string }>(`SELECT internal_id FROM ipy_field WHERE id = $1`, [req.params.id]);
  if (!field) throw new NotFoundError('Field not found');
  const rows = await db.query(
    `SELECT c.action, c.before_value AS "beforeValue", c.after_value AS "afterValue", c.created_at AS "createdAt",
            u.name AS "userName"
       FROM ipy_field_change c LEFT JOIN ipy_user u ON u.id = c.user_id
      WHERE c.field_internal_id = $1 ORDER BY c.created_at DESC LIMIT 100`, [field.internal_id],
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// Module builder (admin)
// ---------------------------------------------------------------------------

const MODULE_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

const moduleSchema = z.object({
  name: z.string().regex(MODULE_NAME_RE, 'Use lower case letters, numbers and underscores'),
  label: z.string().min(1),
  singularLabel: z.string().min(1),
  icon: z.string().default('box'),
  color: z.string().default('#6366f1'),
  menuGroup: z.string().default('Custom'),
  showInMenu: z.boolean().default(true),
  labelFields: z.array(z.string()).default([]),
  pipelineField: z.string().nullable().optional(),
  duplicateCheckFields: z.array(z.string()).default([]),
});

metadataRouter.post('/modules', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.modules');
  const input = moduleSchema.parse(req.body);

  const existing = await db.queryOne(`SELECT 1 FROM ipy_module WHERE name = $1`, [input.name]);
  if (existing) throw new ConflictError(`A module named '${input.name}' already exists`);

  const tableName = `ipy_c_${input.name}`;

  await transaction(async (tx) => {
    // Custom modules get their own payload table with only the JSONB bag —
    // every field an admin adds lands there, so no further DDL is ever needed.
    await tx.query(`
      CREATE TABLE ${tableName} (
        record_id     UUID PRIMARY KEY REFERENCES ipy_record(id) ON DELETE CASCADE,
        custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await tx.query(`CREATE INDEX ${tableName}_cf_idx ON ${tableName} USING GIN(custom_fields)`);

    const maxSeq = await tx.queryOne<{ max: number }>(`SELECT COALESCE(MAX(sequence),0) + 10 AS max FROM ipy_module`);

    const mod = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_module
        (name, label, singular_label, table_name, icon, color, sequence, menu_group,
         show_in_menu, is_custom, label_fields, pipeline_field, duplicate_check_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12)
       RETURNING id`,
      [
        input.name, input.label, input.singularLabel, tableName, input.icon, input.color,
        maxSeq?.max ?? 999, input.menuGroup, input.showInMenu,
        JSON.stringify(input.labelFields.length ? input.labelFields : ['name']),
        input.pipelineField ?? null, JSON.stringify(input.duplicateCheckFields),
      ],
    );

    // Seed a default block plus a name field so the module is usable immediately.
    const block = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_block (module_id, name, label, sequence, columns)
       VALUES ($1,'general','General Information',0,2) RETURNING id`,
      [mod!.id],
    );
    await tx.query(
      `INSERT INTO ipy_field
        (module_id, block_id, name, label, uitype, storage, column_name, sequence,
         is_mandatory, is_custom, quick_create, searchable)
       VALUES ($1,$2,'name','Name','string','json','name',0,true,true,true,true)`,
      [mod!.id, block!.id],
    );

    await tx.query(`INSERT INTO ipy_module_sharing (module_id, access) VALUES ($1,'private')`, [mod!.id]);

    // Grant the admin profile access straight away.
    await tx.query(
      `INSERT INTO ipy_profile_module_perm (profile_id, module_id, can_view, can_create, can_edit, can_delete, can_export, can_import)
       SELECT id, $1, true, true, true, true, true, true FROM ipy_profile WHERE name = 'Administrator'`,
      [mod!.id],
    );

    // Default layouts.
    const config = {
      blocks: [{ key: 'general', label: 'General Information', columns: 2, fields: ['name'] }],
      tabs: [
        { key: 'overview', label: 'Overview', icon: 'layout-dashboard' },
        { key: 'timeline', label: 'Timeline', icon: 'activity' },
      ],
    };
    for (const type of ['detail', 'edit', 'quick_create']) {
      await tx.query(
        `INSERT INTO ipy_layout (module_id, name, type, is_default, config) VALUES ($1,$2,$3,true,$4)`,
        [mod!.id, `Default ${type} layout`, type, JSON.stringify(config)],
      );
    }
    await tx.query(
      `INSERT INTO ipy_view (module_id, name, columns, is_default, is_public, is_system, sort_by)
       VALUES ($1,'All Records',$2,true,true,true,'created_at')`,
      [mod!.id, JSON.stringify(['name', 'owner_id', 'created_at'])],
    );
  });

  invalidateAll();
  res.status(201).json(await registry.getModule(input.name));
}));

metadataRouter.patch('/modules/:name', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.modules');
  const module = await registry.requireModule(req.params.name);
  const input = moduleSchema.partial().omit({ name: true }).parse(req.body);

  const map: Record<string, string> = {
    label: 'label', singularLabel: 'singular_label', icon: 'icon', color: 'color',
    menuGroup: 'menu_group', showInMenu: 'show_in_menu', pipelineField: 'pipeline_field',
  };
  const sets: string[] = [];
  const params: unknown[] = [module.id];
  for (const [key, value] of Object.entries(input)) {
    if (key === 'labelFields' || key === 'duplicateCheckFields') {
      params.push(JSON.stringify(value));
      sets.push(`${key === 'labelFields' ? 'label_fields' : 'duplicate_check_fields'} = $${params.length}`);
      continue;
    }
    const col = map[key];
    if (!col) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_module SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  invalidateAll();
  res.json(await registry.getModule(req.params.name));
}));

metadataRouter.delete('/modules/:name', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.modules');
  const module = await registry.requireModule(req.params.name);
  if (!module.isCustom) {
    throw new BadRequestError('Built-in modules cannot be deleted. Deactivate it instead.');
  }
  const count = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_record WHERE module_id = $1 AND is_deleted = false`,
    [module.id],
  );
  if ((count?.count ?? 0) > 0 && req.query.force !== 'true') {
    throw new ConflictError(
      `${module.label} still has ${count?.count} records. Pass ?force=true to delete the module and its data.`,
    );
  }
  await transaction(async (tx) => {
    await tx.query(`DELETE FROM ipy_module WHERE id = $1`, [module.id]);
    await tx.query(`DROP TABLE IF EXISTS ${module.tableName}`);
  });
  invalidateAll();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const blockSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  label: z.string().min(1),
  sequence: z.number().int().optional(),
  columns: z.number().int().min(1).max(3).default(2),
  isCollapsed: z.boolean().default(false),
});

metadataRouter.post('/modules/:name/blocks', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const module = await registry.requireModule(req.params.name, { allowDisabled: true });
  const input = blockSchema.parse(req.body);
  const seq = input.sequence ?? module.blocks.length;
  // Adding a section back lifts its tombstone, the same way re-adding a deleted
  // dropdown option does. That is somebody changing their mind, not an accident.
  await db.query(
    `DELETE FROM ipy_block_tombstone WHERE module_name = $1 AND block_name = $2`,
    [module.name, input.name],
  );
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_block (module_id, name, label, sequence, columns, is_collapsed, is_custom)
     VALUES ($1,$2,$3,$4,$5,$6,true)
     ON CONFLICT (module_id, name) DO UPDATE SET label = EXCLUDED.label, sequence = EXCLUDED.sequence
     RETURNING id`,
    [module.id, input.name, input.label, seq, input.columns, input.isCollapsed],
  );
  invalidateAll();
  res.status(201).json({ id: row?.id });
}));

metadataRouter.patch('/blocks/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const input = blockSchema.partial().parse(req.body);
  const map: Record<string, string> = { label: 'label', sequence: 'sequence', columns: 'columns', isCollapsed: 'is_collapsed' };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [k, v] of Object.entries(input)) {
    const col = map[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    // Claim it as admin-owned, or the next cold start puts the template's name
    // back — the same contract ipy_field.is_customised has.
    sets.push('is_customised = true');
    await db.query(`UPDATE ipy_block SET ${sets.join(', ')} WHERE id = $1`, params);
  }
  invalidateAll();
  res.json({ ok: true });
}));

/**
 * Delete a section.
 *
 * Two things used to make this impossible and both looked like a bug. It only
 * deleted `is_custom` rows, so the sections that came with the CRM — KYC,
 * Communication Preferences — could never be removed no matter how empty they
 * were; and the Layout Designer's own delete only ever edited a layout, so a
 * section removed there stayed in the Section dropdown and kept showing on this
 * page as "No fields in this block". One section, two lists, and neither was
 * the truth.
 *
 * Now there is one: the section itself goes, and it comes off every layout that
 * placed it. A section with fields still in it is refused with the count,
 * because a delete that quietly moved somebody's fields elsewhere is worse than
 * one that says what is in the way.
 */
metadataRouter.delete('/blocks/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const block = await db.queryOne<{ id: string; name: string; label: string; module_id: string }>(
    `SELECT id, name, label, module_id FROM ipy_block WHERE id = $1`, [req.params.id],
  );
  if (!block) throw new NotFoundError('Section not found');

  const fields = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_field WHERE block_id = $1`, [req.params.id],
  );
  const count = fields?.count ?? 0;
  if (count > 0) {
    throw new ConflictError(
      `“${block.label}” still holds ${count} field${count === 1 ? '' : 's'}. `
      + 'Move them to another section, or delete them, and this section can go.',
    );
  }

  const siblings = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_block WHERE module_id = $1`, [block.module_id],
  );
  if ((siblings?.count ?? 0) <= 1) {
    throw new ConflictError('A module needs at least one section — fields have to live somewhere.');
  }

  const moduleRow = await registry.getModuleById(block.module_id);
  await transaction(async (tx) => {
    // Durable, or the seed rebuilds it on the next cold start and the section
    // is back within the hour with nothing to show what happened.
    await tx.query(
      `INSERT INTO ipy_block_tombstone (module_name, block_name, deleted_by, label)
       VALUES ($1,$2,$3,$4) ON CONFLICT (module_name, block_name) DO NOTHING`,
      [moduleRow?.name ?? '', block.name, getUser(req).id, block.label],
    );
    await tx.query(`DELETE FROM ipy_block WHERE id = $1`, [block.id]);
    // Layouts name their sections by the block's `name`, not its id.
    await tx.query(
      `UPDATE ipy_layout
          SET config = jsonb_set(config, '{blocks}', COALESCE((
                SELECT jsonb_agg(b) FROM jsonb_array_elements(config -> 'blocks') AS b
                 WHERE b ->> 'key' <> $2
              ), '[]'::jsonb))
        WHERE module_id = $1 AND jsonb_typeof(config -> 'blocks') = 'array'`,
      [block.module_id, block.name],
    );
  });
  invalidateAll();
  res.json({ ok: true, deleted: block.name });
}));

// ---------------------------------------------------------------------------
// Field builder
// ---------------------------------------------------------------------------

const fieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,50}$/, 'Use lower case letters, numbers and underscores'),
  label: z.string().min(1),
  uitype: z.string(),
  blockId: z.string().uuid().optional(),
  sequence: z.number().int().optional(),
  isMandatory: z.boolean().default(false),
  isReadonly: z.boolean().default(false),
  isUnique: z.boolean().default(false),
  isActive: z.boolean().optional(),
  displayType: z.enum(['default', 'readonly', 'hidden', 'detail_only', 'create_only']).default('default'),
  defaultValue: z.unknown().optional(),
  maxLength: z.number().int().positive().optional(),
  helpText: z.string().optional(),
  config: z.record(z.unknown()).default({}),
  quickCreate: z.boolean().default(false),
  massEditable: z.boolean().default(true),
  searchable: z.boolean().default(false),
});

/** Reject configurations that would produce a field the engine can't run. */
function validateFieldConfig(uitype: string, config: Record<string, unknown>): void {
  const spec = UITYPES[uitype as keyof typeof UITYPES];
  if (!spec) throw new BadRequestError(`Unknown field type '${uitype}'`);
  for (const key of spec.requiresConfig ?? []) {
    if (config[key as string] === undefined) {
      throw new BadRequestError(`${spec.label} fields need '${String(key)}' in their configuration`);
    }
  }
  if (uitype === 'formula') {
    const expr = (config.formula as { expression?: string } | undefined)?.expression;
    if (!expr) throw new BadRequestError('Formula fields need an expression');
    const check = validateFormula(expr);
    if (!check.valid) throw new BadRequestError(`Formula error: ${check.error}`);
  }
  if (uitype === 'rollup') {
    const rollup = config.rollup as
      | { relation?: string; aggregate?: string; field?: string; filter?: unknown }
      | undefined;
    if (!rollup?.relation) throw new BadRequestError('Rollup fields need a related list (`relation`)');
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(rollup.aggregate ?? '')) {
      throw new BadRequestError(`Unknown rollup aggregate '${rollup.aggregate}'`);
    }
    if (rollup.aggregate !== 'count' && !rollup.field) {
      throw new BadRequestError(`'${rollup.aggregate}' rollups need the field to aggregate`);
    }
  }
}

metadataRouter.post('/modules/:name/fields', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const module = await registry.requireModule(req.params.name, { allowDisabled: true });
  const input = fieldSchema.parse(req.body);
  validateFieldConfig(input.uitype, input.config);

  if (module.fields.some((f) => f.name === input.name)) {
    throw new ConflictError(`${module.label} already has a field named '${input.name}'`);
  }

  const blockId = input.blockId ?? module.blocks[module.blocks.length - 1]?.id;
  if (!blockId) throw new BadRequestError('Create a block before adding fields');

  const seq = input.sequence
    ?? (module.fields.filter((f) => f.blockId === blockId).length);

  const row = await db.queryOne<{ id: string; internal_id: string }>(
    `INSERT INTO ipy_field
      (module_id, block_id, name, label, uitype, storage, column_name, sequence,
       is_mandatory, is_readonly, is_unique, is_custom, display_type, default_value,
       max_length, help_text, config, quick_create, mass_editable, searchable)
     VALUES ($1,$2,$3,$4,$5,'json',$3,$6,$7,$8,$9,true,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id, internal_id`,
    [
      module.id, blockId, input.name, input.label, input.uitype, seq,
      input.isMandatory, input.isReadonly, input.isUnique, input.displayType,
      input.defaultValue !== undefined ? JSON.stringify(input.defaultValue) : null,
      input.maxLength ?? null, input.helpText ?? null, JSON.stringify(input.config),
      input.quickCreate, input.massEditable, input.searchable,
    ],
  );

  // An amount without its unit is ambiguous. Creating a field linked to either
  // reusable unit master automatically creates the hidden companion value the
  // combined control stores. It is still metadata (not a hardcoded module
  // column), therefore Required Area, Terrace Area and any future field all
  // work the same way.
  const unitMaster = input.config.unitMaster;
  const unitField = typeof input.config.unitField === 'string' ? input.config.unitField : null;
  if ((unitMaster === 'area' || unitMaster === 'budget_demand') && unitField && !module.fields.some((f) => f.name === unitField)) {
    await db.query(
      `INSERT INTO ipy_field (module_id, block_id, name, label, uitype, storage, column_name, sequence,
         is_custom, display_type, default_value, config, quick_create, mass_editable, searchable)
       VALUES ($1,$2,$3,$4,'string','json',$3,$5,true,'hidden',$6,'{}',false,false,false)`,
      [module.id, blockId, unitField, `${input.label} Unit`, seq + 1, JSON.stringify(unitMaster === 'area' ? 'sqft' : 'total')],
    );
  }

  // Custom fields start editable for the Administrator profile only; other
  // profiles opt in explicitly so nothing sensitive leaks by default.
  await db.query(
    `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
     SELECT id, $1, 'hidden' FROM ipy_profile WHERE name <> 'Administrator'
     ON CONFLICT DO NOTHING`,
    [row!.id],
  );
  await db.query(
    `INSERT INTO ipy_field_change (module_id, field_internal_id, action, after_value, user_id)
     VALUES ($1,$2,'created',$3,$4)`,
    [module.id, row!.internal_id, JSON.stringify({ label: input.label, name: input.name, uitype: input.uitype }), getUser(req).id],
  );

  invalidateAll();
  res.status(201).json(await registry.getField(module.name, input.name));
}));

metadataRouter.patch('/fields/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const input = fieldSchema.partial().parse(req.body);

  const current = await db.queryOne<{
    internal_id: string; name: string; label: string; uitype: string; config: Record<string, unknown>;
    is_custom: boolean; storage: string; module_id: string; display_type: string;
  }>(
    `SELECT internal_id, name, label, uitype, config, is_custom, storage, module_id, display_type
       FROM ipy_field WHERE id = $1`,
    [req.params.id],
  );
  if (!current) throw new NotFoundError('Field not found');
  const module = await registry.getModuleById(current.module_id);
  if (!module) throw new NotFoundError('Field not found');

  /**
   * Changing a field's type.
   *
   * This used to refuse outright for anything the admin had not created, which
   * made "metadata-driven" a promise the admin panel did not keep — a Text
   * field seeded as Text stayed Text for ever. What actually constrains it is
   * storage, not who created it: an admin-created field lives in a JSONB
   * document that holds any shape, while a built-in field is a real column with
   * a real type. Email → Text is free; Date → Text is a write that fails on the
   * row rather than on the form.
   */
  if (input.uitype && input.uitype !== current.uitype && current.storage === 'column') {
    const allowed = interchangeableTypes(current.uitype);
    if (!allowed.includes(input.uitype)) {
      const names = allowed
        .filter((u) => u !== current.uitype)
        .map((u) => UITYPES[u as keyof typeof UITYPES]?.label ?? u);
      throw new BadRequestError(
        `“${current.label}” is stored as ${current.uitype}, so it can only become ${
          names.length ? names.join(', ') : 'the same type'
        }. To make it ${input.uitype}, add a new field of that type and delete this one.`,
      );
    }
  }

  /**
   * Changing a field's API name.
   *
   * Safe in a way that is not obvious: records are stored under `column_name`,
   * never under `name`, so a rename moves no data and can lose no value. What
   * it does break is every reference by name — saved views, filters, layouts,
   * workflows, widgets, reports, formulas — and `renameFieldEverywhere` is what
   * puts those back. Without it the rename appears to work and a view quietly
   * renders a blank column.
   */
  let renamed: { from: string; to: string; references: number } | null = null;
  if (input.name && input.name !== current.name) {
    const taken = module.fields.some((f) => f.name === input.name);
    if (taken) throw new ConflictError(`${module.label} already has a field named '${input.name}'`);
    /*
     * Renaming one of these used to be refused, and no longer is.
     *
     * The refusal was based on a real risk that had already been designed out:
     * a rename never touches `column_name`, so the data does not move, and
     * `renameFieldEverywhere` below rewrites every view, filter, layout,
     * workflow and widget that names it. What actually broke was a handful of
     * features holding a literal field name in the source. Those now find their
     * field by its storage column instead — see `fieldPlaying` in the registry —
     * so they follow a rename by themselves.
     *
     * Deleting one is still refused, and that distinction is the whole point:
     * a rename changes what a field is called, a delete removes the thing the
     * engine runs on. An admin can call Lead Status anything they like.
     */
    // `record_id` is the join between a record and its payload row, not a
    // field anybody filled in. Everything else the module reads by name —
    // the naming fields, the pipeline field — is rewritten by the pass below.
    if (current.name === 'record_id') {
      throw new BadRequestError('“record_id” is the record identifier itself and cannot be renamed.');
    }
    const { references } = await transaction((tx) =>
      renameFieldEverywhere(current.module_id, module.name, current.name, input.name!, tx));
    await db.query(
      `INSERT INTO ipy_field_api_alias (module_id, field_internal_id, api_name)
       VALUES ($1,$2,$3) ON CONFLICT (module_id, api_name) DO NOTHING`,
      [current.module_id, current.internal_id, current.name],
    );
    renamed = { from: current.name, to: input.name, references };
  }

  const nextType = input.uitype ?? current.uitype;
  /**
   * Config is merged, not replaced — a caller patching only `label` must not
   * wipe a field's validation. That leaves no way to *remove* a setting, so an
   * explicit `null` means "delete this key". The field editor relies on it to
   * clear a rule; without it, unsetting a format silently did nothing.
   */
  const nextConfig: Record<string, unknown> = { ...current.config, ...(input.config ?? {}) };
  for (const [key, value] of Object.entries(input.config ?? {})) {
    if (value === null) delete nextConfig[key];
  }
  if (input.uitype || input.config) validateFieldConfig(nextType, nextConfig);

  // Re-activating a field that was hidden via the "Hide field" action must
  // also clear display_type='hidden', or the field stays invisible on every
  // screen (the web app filters on isActive AND displayType !== 'hidden') —
  // the toggle would silently do nothing from the admin's point of view.
  if (input.isActive === true && current.display_type === 'hidden' && input.displayType === undefined) {
    input.displayType = 'default';
  }

  const map: Record<string, string> = {
    name: 'name',
    label: 'label', uitype: 'uitype', blockId: 'block_id', sequence: 'sequence',
    isMandatory: 'is_mandatory', isReadonly: 'is_readonly', isUnique: 'is_unique', isActive: 'is_active',
    displayType: 'display_type', maxLength: 'max_length', helpText: 'help_text',
    quickCreate: 'quick_create', massEditable: 'mass_editable', searchable: 'searchable',
  };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [k, v] of Object.entries(input)) {
    if (k === 'config') { params.push(JSON.stringify(nextConfig)); sets.push(`config = $${params.length}`); continue; }
    if (k === 'defaultValue') { params.push(v === undefined ? null : JSON.stringify(v)); sets.push(`default_value = $${params.length}`); continue; }
    const col = map[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    // Claim the field as admin-owned so the seed stops rewriting its label,
    // validation and visibility rules on the next deploy or cold start — the
    // same contract ipy_layout.is_customised has (see seed/helpers.ts).
    sets.push('is_customised = true');
    await db.query(`UPDATE ipy_field SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    const action = input.uitype && input.uitype !== current.uitype ? 'type_changed'
      : input.name && input.name !== current.name ? 'renamed' : 'updated';
    await db.query(
      `INSERT INTO ipy_field_change (module_id, field_internal_id, action, before_value, after_value, user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [current.module_id, current.internal_id, action,
        JSON.stringify({ label: current.label, name: current.name, uitype: current.uitype, config: current.config }),
        JSON.stringify({ ...input, config: nextConfig }), getUser(req).id],
    );
  }
  invalidateAll();

  const stored = await db.queryOne<{ name: string }>(`SELECT name FROM ipy_field WHERE id = $1`, [req.params.id]);
  const saved = await registry.getField(module.name, stored!.name);
  // The rename count goes back so the editor can say what moved with it —
  // "renamed, and 6 views, layouts and rules followed" is the difference
  // between a change somebody trusts and one they undo out of caution.
  res.json(renamed ? { ...saved, renamed } : saved);
}));

const conversionSchema = z.object({
  targetType: z.string(), valueMap: z.record(z.string()).optional(),
  invalidStrategy: z.enum(['blank', 'default', 'keep']).default('blank'), defaultValue: z.unknown().optional(),
});

async function conversionField(id: string): Promise<{ id: string; internal_id: string; module_id: string; storage: string; column_name: string; uitype: string; config: Record<string, unknown> }> {
  const field = await db.queryOne<{ id: string; internal_id: string; module_id: string; storage: string; column_name: string; uitype: string; config: Record<string, unknown> }>(
    `SELECT id, internal_id, module_id, storage, column_name, uitype, config FROM ipy_field WHERE id = $1`, [id],
  );
  if (!field) throw new NotFoundError('Field not found');
  return field;
}

/** Count and sample conversion outcomes before an administrator changes data. */
metadataRouter.post('/fields/:id/type-conversion/preview', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const input = conversionSchema.parse(req.body);
  if (!UITYPES[input.targetType as keyof typeof UITYPES]) throw new BadRequestError('Unknown field type');
  const field = await conversionField(req.params.id);
  const module = await registry.getModuleById(field.module_id);
  if (!module) throw new NotFoundError('Module not found');
  if (field.storage !== 'json') throw new BadRequestError('This field is stored in a protected system column; create a replacement field for this conversion.');
  const rows = await db.query<{ record_id: string; value: unknown }>(
    `SELECT record_id, custom_fields -> $1 AS value FROM ${module.tableName} WHERE custom_fields ? $1`, [field.column_name],
  );
  const plan: ConversionPlan = { targetType: input.targetType as import('@ipropy/shared').UIType, valueMap: input.valueMap, invalidStrategy: input.invalidStrategy, defaultValue: input.defaultValue };
  const invalid = rows.rows.filter((r) => !convertFieldValue(r.value, plan).ok);
  res.json({ totalRecords: rows.rows.length, convertibleRecords: rows.rows.length - invalid.length,
    invalidRecords: invalid.length, invalidSamples: invalid.slice(0, 20).map((r) => ({ recordId: r.record_id, value: r.value })) });
}));

/** Convert all custom-field values atomically; any error rolls back every row. */
metadataRouter.post('/fields/:id/type-conversion', asyncHandler(async (req, res) => {
  const user = getUser(req); await assertCapability(user, 'admin.fields');
  const input = conversionSchema.parse(req.body);
  if (!UITYPES[input.targetType as keyof typeof UITYPES]) throw new BadRequestError('Unknown field type');
  const field = await conversionField(req.params.id);
  const module = await registry.getModuleById(field.module_id);
  if (!module) throw new NotFoundError('Module not found');
  if (field.storage !== 'json') throw new BadRequestError('This field is stored in a protected system column; create a replacement field for this conversion.');
  const plan: ConversionPlan = { targetType: input.targetType as import('@ipropy/shared').UIType, valueMap: input.valueMap, invalidStrategy: input.invalidStrategy, defaultValue: input.defaultValue };
  const result = await transaction(async (tx) => {
    const rows = await tx.query<{ record_id: string; value: unknown }>(`SELECT record_id, custom_fields -> $1 AS value FROM ${module.tableName} WHERE custom_fields ? $1 FOR UPDATE`, [field.column_name]);
    let invalid = 0;
    for (const row of rows.rows) {
      const converted = convertFieldValue(row.value, plan);
      const value = converted.ok ? converted.value : (invalid++, input.invalidStrategy === 'default' ? input.defaultValue : input.invalidStrategy === 'keep' ? row.value : null);
      await tx.query(`UPDATE ${module.tableName} SET custom_fields = jsonb_set(custom_fields, ARRAY[$1], $2::jsonb, true) WHERE record_id = $3`, [field.column_name, JSON.stringify(value), row.record_id]);
    }
    await tx.query(`UPDATE ipy_field SET uitype = $2, config = $3, is_customised = true, updated_at = now() WHERE id = $1`, [field.id, input.targetType, JSON.stringify(field.config)]);
    await tx.query(`INSERT INTO ipy_field_change (module_id, field_internal_id, action, before_value, after_value, user_id) VALUES ($1,$2,'type_changed',$3,$4,$5)`, [field.module_id, field.internal_id, JSON.stringify({ uitype: field.uitype }), JSON.stringify({ uitype: input.targetType, invalidRecords: invalid }), user.id]);
    return { convertedRecords: rows.rows.length - invalid, invalidRecords: invalid };
  });
  invalidateAll(); res.json({ ok: true, ...result });
}));

/** Bulk reorder after a drag in the layout designer. */
metadataRouter.post('/fields/reorder', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.layouts');
  const { fields } = z.object({
    fields: z.array(z.object({
      id: z.string().uuid(),
      blockId: z.string().uuid(),
      sequence: z.number().int(),
    })),
  }).parse(req.body);

  await transaction(async (tx) => {
    for (const f of fields) {
      await tx.query(`UPDATE ipy_field SET block_id = $2, sequence = $3 WHERE id = $1`, [f.id, f.blockId, f.sequence]);
    }
  });
  invalidateAll();
  res.json({ ok: true });
}));

/** Duplicate metadata only — records keep their existing values until the new field is filled. */
metadataRouter.post('/fields/:id/duplicate', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const source = await db.queryOne<{
    module_id: string; block_id: string | null; name: string; label: string; uitype: string; sequence: number;
    is_mandatory: boolean; is_readonly: boolean; is_unique: boolean; display_type: string; default_value: unknown;
    max_length: number | null; help_text: string | null; config: Record<string, unknown>; quick_create: boolean; mass_editable: boolean; searchable: boolean;
  }>(`SELECT module_id, block_id, name, label, uitype, sequence, is_mandatory, is_readonly, is_unique, display_type, default_value, max_length, help_text, config, quick_create, mass_editable, searchable FROM ipy_field WHERE id = $1`, [req.params.id]);
  if (!source) throw new NotFoundError('Field not found');
  const module = await registry.getModuleById(source.module_id); if (!module) throw new NotFoundError('Module not found');
  let number = 2; let name = `${source.name}_copy`;
  while (module.fields.some((f) => f.name === name)) name = `${source.name}_copy_${number++}`;
  const row = await db.queryOne<{ id: string; internal_id: string }>(
    `INSERT INTO ipy_field (module_id, block_id, name, label, uitype, storage, column_name, sequence, is_mandatory, is_readonly, is_unique, is_custom, display_type, default_value, max_length, help_text, config, quick_create, mass_editable, searchable)
     VALUES ($1,$2,$3,$4,$5,'json',$3,$6,$7,$8,false,true,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, internal_id`,
    [source.module_id, source.block_id, name, `${source.label} Copy`, source.uitype, source.sequence + 1,
      source.is_mandatory, source.is_readonly, source.display_type, JSON.stringify(source.default_value), source.max_length, source.help_text, JSON.stringify(source.config), source.quick_create, source.mass_editable, source.searchable],
  );
  await db.query(`INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission) SELECT id, $1, 'hidden' FROM ipy_profile WHERE name <> 'Administrator' ON CONFLICT DO NOTHING`, [row!.id]);
  await db.query(`INSERT INTO ipy_field_change (module_id, field_internal_id, action, after_value, user_id) VALUES ($1,$2,'created',$3,$4)`, [source.module_id, row!.internal_id, JSON.stringify({ duplicatedFrom: req.params.id, name }), getUser(req).id]);
  invalidateAll(); res.status(201).json(await registry.getField(module.name, name));
}));

/**
 * Fields the engine reads by name. Deleting one does not hide a column, it
 * breaks the module: without a label field a record has no title anywhere in
 * the app, and without `record_id` the payload row cannot be joined at all.
 * Refused with the reason and the setting to change first, rather than
 * accepted and discovered later.
 */
async function structuralBlocker(
  moduleName: string,
  fieldName: string,
): Promise<string | null> {
  const module = await registry.getModule(moduleName);
  if (!module) return null;
  if (fieldName === 'record_id') return 'it is the record identifier itself';
  if (module.labelFields.includes(fieldName)) {
    return `it forms this module's record name — change the naming fields first`;
  }
  if (module.pipelineField === fieldName) {
    return `it is this module's pipeline field — pick a different one first`;
  }
  return null;
}

metadataRouter.delete('/fields/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.fields');
  const permanent = req.query.permanent === 'true';

  const field = await db.queryOne<{ internal_id: string; name: string; label: string; is_custom: boolean; storage: string; column_name: string; module_id: string }>(
    `SELECT internal_id, name, label, is_custom, storage, column_name, module_id FROM ipy_field WHERE id = $1`, [req.params.id],
  );
  if (!field) throw new NotFoundError('Field not found');

  const module = await registry.getModuleById(field.module_id);

  // Hide: reversible, keeps the data, the default for a seeded field.
  if (!field.is_custom && !permanent) {
    await db.query(`UPDATE ipy_field SET is_active = false, display_type = 'hidden' WHERE id = $1`, [req.params.id]);
    invalidateAll();
    res.json({ ok: true, deactivated: true });
    return;
  }

  if (module) {
    const blocker = await structuralBlocker(module.name, field.name);
    if (blocker) {
      throw new BadRequestError(`“${field.label}” cannot be deleted because ${blocker}.`);
    }

    /**
     * The same list the rename above refuses on, applied to deleting.
     *
     * Renaming one of these was already blocked and deleting one was not, which
     * is the wider hole of the two: a rename at least leaves a column behind.
     * Two of these had been deleted on his own CRM before anyone noticed, and
     * property matching had been answering 400 on every lead since.
     *
     * Hiding is offered rather than nothing, because it does what he actually
     * wants — the field leaves every screen — while the column stays where the
     * engine can still read it.
     */
    const usedInCode = FIELDS_USED_IN_CODE[`${module.name}.${field.name}`];
    if (usedInCode) {
      throw new BadRequestError(
        `“${field.label}” cannot be deleted because the CRM reads it directly: ${usedInCode}. `
        + `Hide it instead and it disappears from every screen while the CRM can still use it. `
        + `Its Label can be changed to anything you like.`,
      );
    }
  }

  /**
   * Delete: the field and its stored values both go.
   *
   * A seeded field also gets a tombstone. `db:seed` rebuilds every module from
   * db/seed/templates/realEstate.ts, so without one the row would be recreated on the next
   * run — the delete would appear to work and then quietly undo itself.
   */
  let hadValues = 0;
  if (module) {
    const counted = await db.queryOne<{ count: string }>(
      field.storage === 'json'
        ? `SELECT COUNT(*)::text AS count FROM ${module.tableName} WHERE custom_fields ? $1`
        : `SELECT COUNT(*)::text AS count FROM ${module.tableName} WHERE ${quoteIdent(field.column_name)} IS NOT NULL`,
      field.storage === 'json' ? [field.column_name] : [],
    ).catch(() => null);
    hadValues = Number(counted?.count ?? 0);
  }

  await transaction(async (tx) => {
    if (!field.is_custom && module) {
      await tx.query(
        `INSERT INTO ipy_field_tombstone (module_name, field_name, deleted_by, storage, column_name, had_values)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (module_name, field_name) DO UPDATE
           SET deleted_at = now(), deleted_by = EXCLUDED.deleted_by, had_values = EXCLUDED.had_values`,
        [module.name, field.name, user.id, field.storage, field.column_name, hadValues],
      );
    }

    await tx.query(`DELETE FROM ipy_field WHERE id = $1`, [req.params.id]);
    await tx.query(
      `INSERT INTO ipy_field_change (module_id, field_internal_id, action, before_value, user_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [field.module_id, field.internal_id, permanent ? 'permanently_deleted' : 'deleted',
        JSON.stringify({ label: field.label, name: field.name }), user.id],
    );

    if (module && field.storage === 'json') {
      // Reclaim the stored values so the JSONB doesn't accumulate dead keys.
      await tx.query(`UPDATE ${module.tableName} SET custom_fields = custom_fields - $1`, [field.column_name]);
    } else if (module && field.storage === 'column') {
      // The column has to go too, not just its metadata: several are NOT NULL
      // with no default, so leaving one behind with nothing to populate it
      // makes every subsequent insert fail.
      await tx.query(`ALTER TABLE ${module.tableName} DROP COLUMN IF EXISTS ${quoteIdent(field.column_name)}`);
    }

    // Everything that named this field, cleaned out: view filters, workflow
    // conditions, reports, assignment rules, dashboard tiles, workflow actions.
    //
    // This used to be the two statements below and nothing else — view columns
    // and layout blocks. A view that *filtered* on the field kept pointing at
    // it, and the query builder answers `Unknown field` for ever after, which
    // reads as the CRM being broken rather than as a field somebody deleted
    // last week.
    if (module) {
      await removeFieldEverywhere(field.module_id, module.name, field.name, tx);
    }

    await tx.query(
      `UPDATE ipy_layout SET config = jsonb_set(config, '{blocks}', COALESCE((
         SELECT jsonb_agg(b || jsonb_build_object('fields', COALESCE((
           SELECT jsonb_agg(f) FROM jsonb_array_elements_text(b->'fields') AS f WHERE f <> $2
         ), '[]'::jsonb)))
         FROM jsonb_array_elements(config->'blocks') AS b
       ), '[]'::jsonb))
       WHERE module_id = $1 AND config ? 'blocks'`,
      [field.module_id, field.name],
    );
  });

  invalidateAll();
  res.json({ ok: true, deleted: true, hadValues });
}));

metadataRouter.post('/fields/validate-formula', asyncHandler(async (req, res) => {
  // Formula validation belongs to the field editor, gated like it — it is
  // also an oracle for which module fields exist, for anyone signed in.
  await assertCapability(getUser(req), 'admin.fields');
  const { expression } = z.object({ expression: z.string() }).parse(req.body);
  res.json(validateFormula(expression));
}));

metadataRouter.get('/fields/:id/preview-number', asyncHandler(async (req, res) => {
  // Same editor, same gate.
  await assertCapability(getUser(req), 'admin.fields');
  const field = await db.queryOne<{ name: string; config: { numbering?: Record<string, unknown> }; module_id: string }>(
    `SELECT name, config, module_id FROM ipy_field WHERE id = $1`, [req.params.id],
  );
  if (!field) throw new NotFoundError('Field not found');
  const module = await registry.getModuleById(field.module_id);
  res.json({ next: await previewNumber(module?.name ?? '', field.name, field.config.numbering ?? {}) });
}));

// ---------------------------------------------------------------------------
// Picklist editor
// ---------------------------------------------------------------------------

const picklistValueSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  color: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  meta: z.record(z.unknown()).optional(),
  /**
   * The value this row used to be stored as, when the admin edited it.
   *
   * Without it a rename is indistinguishable from "delete one, add another",
   * and every record holding the old string is orphaned: still stored, no
   * longer offered, matched by no filter. With it, the records come too.
   */
  previousValue: z.string().min(1).optional(),
});

const PICKLIST_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;

/** Reads the catalogue, one entry per dropdown, for the admin editor. */
metadataRouter.get('/picklist-catalogue', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.picklists');
  const rows = await db.query<{ name: string; label: string; is_system: boolean; allow_adhoc: boolean }>(
    `SELECT name, label, is_system, allow_adhoc FROM ipy_picklist ORDER BY label`,
  );
  const all = await registry.getAllPicklists();

  const out = [];
  for (const row of rows.rows) {
    const usedBy = await fieldsUsingPicklist(row.name);
    out.push({
      name: row.name,
      label: row.label,
      isSystem: row.is_system,
      allowAdhoc: row.allow_adhoc,
      // Each option carries what depends on it by name, so the editor can warn
      // the moment somebody types over one rather than after they save.
      values: (all[row.name] ?? []).map((v) => ({
        ...v,
        usedInCode: valueUsedInCode(row.name, v.value),
      })),
      usedBy: usedBy.map((u) => ({
        module: u.module, moduleLabel: u.moduleLabel, field: u.field, fieldLabel: u.fieldLabel,
      })),
      // Whether the whole list can go. A built-in with nothing pointing at it —
      // and there are 25 of those, left behind by the modules that were removed
      // — is an admin's to tidy up; one the application reads by name is not.
      canDelete: usedBy.length === 0 && !PICKLISTS_USED_IN_CODE[row.name],
      usedInCode: PICKLISTS_USED_IN_CODE[row.name] ?? null,
    });
  }
  res.json(out);
}));

/**
 * How many records hold one option — what the delete dialog asks before it acts.
 *
 * The option travels in the query string, not the path: a stored value is free
 * text an admin typed ("Hoarding/OOH"), and a slash in a path segment is a
 * routing decision in some proxies no matter how it was encoded.
 */
metadataRouter.get('/picklists/:name/value-usage', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.picklists');
  const value = z.string().min(1).parse(req.query.value);
  const [usage, blocked] = await Promise.all([
    countRecordsWithValue(req.params.name, value),
    fieldsThatCannotBeCleared(req.params.name),
  ]);
  // `canClear` lets the dialog stop offering "leave the field empty" on a
  // required field, rather than offering it and then refusing.
  //
  // `usedInCode` is the other half: renaming an option moves every record and
  // every saved filter, and cannot move a string literal in a query. The admin
  // keeps the decision; they stop making it blind.
  res.json({
    ...usage,
    canClear: blocked.length === 0,
    usedInCode: valueUsedInCode(req.params.name, value),
  });
}));

metadataRouter.post('/picklists', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.picklists');
  const { name, label, values } = z.object({
    name: z.string().regex(PICKLIST_NAME_RE, 'Use lower case letters, numbers and underscores'),
    label: z.string().min(1),
    values: z.array(picklistValueSchema).default([]),
  }).parse(req.body);

  await transaction(async (tx) => {
    const row = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_picklist (name, label, is_global) VALUES ($1,$2,true)
       ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label RETURNING id`,
      [name, label],
    );
    for (const [i, v] of values.entries()) {
      await tx.query(
        `INSERT INTO ipy_picklist_value (picklist_id, value, label, color, sequence, is_active, is_default, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (picklist_id, value) DO UPDATE SET label = EXCLUDED.label, color = EXCLUDED.color`,
        [row!.id, v.value, v.label, v.color ?? null, i, v.isActive, v.isDefault, JSON.stringify(v.meta ?? {})],
      );
    }
    // Recreating something previously deleted is a decision, so it clears the
    // tombstone — otherwise the seed would delete it again on the next boot.
    await tx.query(`DELETE FROM ipy_picklist_tombstone WHERE picklist_name = $1`, [name]);
  });
  invalidateAll();
  res.status(201).json(await registry.getPicklist(name));
}));

/** Rename a dropdown, or let non-admins add values to it on the fly. */
metadataRouter.patch('/picklists/:name', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.picklists');
  const { label, allowAdhoc } = z.object({
    label: z.string().min(1).optional(),
    allowAdhoc: z.boolean().optional(),
  }).parse(req.body);

  const row = await db.queryOne<{ id: string }>(
    `UPDATE ipy_picklist
        SET label = COALESCE($2, label), allow_adhoc = COALESCE($3, allow_adhoc)
      WHERE name = $1 RETURNING id`,
    [req.params.name, label ?? null, allowAdhoc ?? null],
  );
  if (!row) throw new NotFoundError(`Unknown picklist '${req.params.name}'`);
  invalidateAll();
  res.json({ ok: true });
}));

/**
 * Delete a whole dropdown.
 *
 * Refused while any field still draws its options from it — deleting it there
 * would leave that field a text box with no choices, which is not what "delete
 * this dropdown" means to anyone. Remove or repoint the field first.
 */
metadataRouter.delete('/picklists/:name', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.picklists');
  const name = req.params.name;

  const picklist = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_picklist WHERE name = $1`, [name]);
  if (!picklist) throw new NotFoundError(`Unknown picklist '${name}'`);

  const uses = await fieldsUsingPicklist(name);
  if (uses.length) {
    throw new ConflictError(
      `${uses.length === 1 ? 'A field uses' : `${uses.length} fields use`} this dropdown: `
      + `${uses.map((u) => `${u.moduleLabel} → ${u.fieldLabel}`).join(', ')}. `
      + 'Point those fields at another dropdown first, or delete them.',
    );
  }
  if (PICKLISTS_USED_IN_CODE[name]) {
    throw new ConflictError(
      `iPropy itself uses this dropdown — it is ${PICKLISTS_USED_IN_CODE[name]}. `
      + 'Its options are yours to change, but the list has to stay.',
    );
  }

  await transaction(async (tx) => {
    await tx.query(`DELETE FROM ipy_picklist WHERE id = $1`, [picklist.id]);
    await tx.query(
      `INSERT INTO ipy_picklist_tombstone (picklist_name, value, deleted_by)
       VALUES ($1,'',$2) ON CONFLICT (picklist_name, value) DO NOTHING`,
      [name, user.id],
    );
  });
  invalidateAll();
  res.json({ ok: true });
}));

/**
 * Delete one option, for good.
 *
 * `replaceWith` is what makes this safe on an option records already hold: the
 * records are moved to the replacement (or cleared) *before* the option goes,
 * so nothing is left storing a value the dropdown no longer offers. Without it
 * the delete is refused while anything still uses the option — silently
 * stranding a thousand leads is not a thing a delete button should do.
 */
metadataRouter.delete('/picklists/:name/values', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.picklists');
  const name = req.params.name;
  const value = z.string().min(1).parse(req.query.value);
  const replaceWith = typeof req.query.replaceWith === 'string' && req.query.replaceWith
    ? req.query.replaceWith
    : null;
  const clear = req.query.clear === 'true';

  const picklist = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_picklist WHERE name = $1`, [name]);
  if (!picklist) throw new NotFoundError(`Unknown picklist '${name}'`);

  const usage = await countRecordsWithValue(name, value);
  if (usage.total > 0 && !replaceWith && !clear) {
    throw new ConflictError(
      `${usage.total} record${usage.total === 1 ? '' : 's'} still ${usage.total === 1 ? 'has' : 'have'} this value. `
      + 'Choose what those records should say instead, or clear the field on them.',
      { recordCount: usage.total, byField: usage.byField },
    );
  }
  if (replaceWith) {
    const exists = await db.queryOne(
      `SELECT 1 FROM ipy_picklist_value WHERE picklist_id = $1 AND value = $2`,
      [picklist.id, replaceWith],
    );
    if (!exists) throw new BadRequestError(`'${replaceWith}' is not an option in this dropdown`);
  } else if (usage.total > 0) {
    // "Leave the field empty" is not available on a required column, and finding
    // that out from a constraint violation halfway through is the worst way to
    // learn it.
    const blocked = await fieldsThatCannotBeCleared(name);
    if (blocked.length) {
      throw new ConflictError(
        `${blocked.map((b) => `${b.moduleLabel} → ${b.fieldLabel}`).join(', ')} cannot be left empty, `
        + 'so choose which option those records should move to instead.',
        { mustReplace: true },
      );
    }
  }

  await transaction(async (tx) => {
    if (usage.total > 0) await replaceValueInRecords(name, value, replaceWith, tx);
    await tx.query(
      `DELETE FROM ipy_picklist_value WHERE picklist_id = $1 AND value = $2`,
      [picklist.id, value],
    );
    await tx.query(
      `INSERT INTO ipy_picklist_tombstone (picklist_name, value, deleted_by, had_records, replaced_with)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (picklist_name, value) DO UPDATE SET
         deleted_at = now(), deleted_by = EXCLUDED.deleted_by,
         had_records = EXCLUDED.had_records, replaced_with = EXCLUDED.replaced_with`,
      [name, value, user.id, usage.total, replaceWith],
    );
  });
  invalidateAll();
  res.json({ ok: true, movedRecords: usage.total, replacedWith: replaceWith });
}));

/**
 * Save the option list — how the dropdown editor saves.
 *
 * Order, labels, colours, the active flag and which option is the default all
 * come from the list as given. Renames carry `previousValue` and take the
 * records with them. Options the admin removed are *not* handled here: they go
 * through DELETE above, one at a time, because each one needs its own answer to
 * "what happens to the records that hold it?".
 */
metadataRouter.put('/picklists/:name/values', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'admin.picklists');
  const { values } = z.object({ values: z.array(picklistValueSchema) }).parse(req.body);

  const name = req.params.name;
  const picklist = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_picklist WHERE name = $1`, [name]);
  if (!picklist) throw new NotFoundError(`Unknown picklist '${name}'`);

  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v.value)) throw new BadRequestError(`'${v.value}' appears twice — stored values must be unique`);
    seen.add(v.value);
  }

  /*
    A save must never undo a deletion.

    This endpoint takes the whole option list, and it used to clear the
    tombstone of every value in it — the idea being that re-adding an option is
    a decision. But the editor sends its *entire* list on every save, so a list
    loaded before somebody deleted an option, saved after, silently re-created
    that option and wiped the tombstone that was keeping it gone. Delete "New",
    press Save, and "New" is back with no message: reported exactly that way.

    So a tombstoned value is skipped here and reported back, and bringing one
    back is its own explicit action (`restore`) rather than a side effect of
    saving something else.
  */
  const tombstoned = new Set(
    (await db.query<{ value: string }>(
      `SELECT value FROM ipy_picklist_tombstone WHERE picklist_name = $1 AND value <> ''`, [name],
    )).rows.map((r) => r.value),
  );
  const restore = new Set(
    (z.object({ restore: z.array(z.string()).default([]) }).parse(req.body)).restore,
  );
  const skipped = values
    .filter((v) => tombstoned.has(v.value) && !restore.has(v.value))
    .map((v) => v.value);
  const writable = values.filter((v) => !skipped.includes(v.value));

  let renamedRecords = 0;
  let renamedFilters = 0;
  await transaction(async (tx) => {
    for (const [i, v] of writable.entries()) {
      if (v.previousValue && v.previousValue !== v.value) {
        // Move the records first: the option row is what the records are
        // matched against, so renaming it first would leave nothing to find.
        const moved = await replaceValueInRecords(name, v.previousValue, v.value, tx);
        renamedRecords += moved.records;
        renamedFilters += moved.filters;
        await tx.query(
          `UPDATE ipy_picklist_value SET value = $3 WHERE picklist_id = $1 AND value = $2`,
          [picklist.id, v.previousValue, v.value],
        );
      }
      await tx.query(
        `INSERT INTO ipy_picklist_value (picklist_id, value, label, color, sequence, is_active, is_default, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (picklist_id, value) DO UPDATE SET
           label = EXCLUDED.label, color = EXCLUDED.color, sequence = EXCLUDED.sequence,
           is_active = EXCLUDED.is_active, is_default = EXCLUDED.is_default, meta = EXCLUDED.meta`,
        [picklist.id, v.value, v.label, v.color ?? null, i, v.isActive, v.isDefault, JSON.stringify(v.meta ?? {})],
      );
      // Only for a value the caller explicitly asked to restore — see above.
      // Without clearing it the next re-seed would take the option away again.
      if (restore.has(v.value)) {
        await tx.query(
          `DELETE FROM ipy_picklist_tombstone WHERE picklist_name = $1 AND value = $2`,
          [name, v.value],
        );
      }
    }

    // At most one default, and it must be one of the options given. Sending no
    // default clears it rather than leaving a stale one behind.
    const def = writable.find((v) => v.isDefault);
    await tx.query(
      `UPDATE ipy_picklist_value SET is_default = ($2::text IS NOT NULL AND value = $2)
        WHERE picklist_id = $1`,
      [picklist.id, def?.value ?? null],
    );
  });
  invalidateAll();
  res.json({ values: await registry.getPicklist(name), renamedRecords, renamedFilters, skipped });
}));

metadataRouter.put('/modules/:name/picklist-dependency', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.picklists');
  const module = await registry.requireModule(req.params.name);
  const { sourceField, targetField, mapping } = z.object({
    sourceField: z.string(),
    targetField: z.string(),
    mapping: z.record(z.array(z.string())),
  }).parse(req.body);

  await db.query(
    `INSERT INTO ipy_picklist_dependency (module_id, source_field, target_field, mapping)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (module_id, source_field, target_field) DO UPDATE SET mapping = EXCLUDED.mapping, is_active = true`,
    [module.id, sourceField, targetField, JSON.stringify(mapping)],
  );
  invalidateAll();
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Layout designer
// ---------------------------------------------------------------------------

metadataRouter.get('/modules/:name/layouts', asyncHandler(async (req, res) => {
  const module = await registry.requireModule(req.params.name);
  const rows = await db.query(
    `SELECT l.id, l.name, l.type, l.is_default, l.is_active, l.config, l.sequence,
            COALESCE(json_agg(lp.profile_id) FILTER (WHERE lp.profile_id IS NOT NULL), '[]') AS profile_ids
     FROM ipy_layout l
     LEFT JOIN ipy_layout_profile lp ON lp.layout_id = l.id
     WHERE l.module_id = $1
     GROUP BY l.id ORDER BY l.type, l.sequence`,
    [module.id],
  );
  res.json(rows.rows);
}));

const layoutSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['detail', 'edit', 'quick_create', 'summary', 'convert']),
  isDefault: z.boolean().default(false),
  config: z.record(z.unknown()),
  profileIds: z.array(z.string().uuid()).default([]),
});

metadataRouter.post('/modules/:name/layouts', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.layouts');
  const module = await registry.requireModule(req.params.name);
  const input = layoutSchema.parse(req.body);

  const id = await transaction(async (tx) => {
    if (input.isDefault) {
      await tx.query(`UPDATE ipy_layout SET is_default = false WHERE module_id = $1 AND type = $2`, [module.id, input.type]);
    }
    const row = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_layout (module_id, name, type, is_default, config) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [module.id, input.name, input.type, input.isDefault, JSON.stringify(input.config)],
    );
    for (const pid of input.profileIds) {
      await tx.query(`INSERT INTO ipy_layout_profile (layout_id, profile_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [row!.id, pid]);
    }
    return row!.id;
  });
  res.status(201).json({ id });
}));

metadataRouter.put('/layouts/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.layouts');
  const input = layoutSchema.partial().parse(req.body);

  await transaction(async (tx) => {
    const sets: string[] = [];
    const params: unknown[] = [req.params.id];
    if (input.name !== undefined) { params.push(input.name); sets.push(`name = $${params.length}`); }
    if (input.config !== undefined) {
      params.push(JSON.stringify(input.config));
      sets.push(`config = $${params.length}`);
      // Editing a layout takes it out of the seed's hands. `db:seed` rewrites
      // every default layout it owns on each run, which would silently undo
      // the sections, header fields and default tab an admin just arranged.
      sets.push('is_customised = true');
    }
    if (input.isDefault !== undefined) { params.push(input.isDefault); sets.push(`is_default = $${params.length}`); }
    if (sets.length) {
      await tx.query(`UPDATE ipy_layout SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    }
    if (input.profileIds) {
      await tx.query(`DELETE FROM ipy_layout_profile WHERE layout_id = $1`, [req.params.id]);
      for (const pid of input.profileIds) {
        await tx.query(`INSERT INTO ipy_layout_profile (layout_id, profile_id) VALUES ($1,$2)`, [req.params.id, pid]);
      }
    }
  });
  res.json({ ok: true });
}));

metadataRouter.delete('/layouts/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.layouts');
  const layout = await db.queryOne<{ is_default: boolean }>(`SELECT is_default FROM ipy_layout WHERE id = $1`, [req.params.id]);
  if (layout?.is_default) throw new BadRequestError('The default layout cannot be deleted.');
  await db.query(`DELETE FROM ipy_layout WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

/** Resolve the layout a specific user should see for a module + type. */
metadataRouter.get('/modules/:name/layout/:type', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const module = await registry.requireModule(req.params.name);

  const assigned = user.profileId
    ? await db.queryOne<{ config: unknown; id: string; name: string }>(
        `SELECT l.id, l.name, l.config FROM ipy_layout l
         JOIN ipy_layout_profile lp ON lp.layout_id = l.id
         WHERE l.module_id = $1 AND l.type = $2 AND l.is_active AND lp.profile_id = $3
         ORDER BY l.sequence LIMIT 1`,
        [module.id, req.params.type, user.profileId],
      )
    : null;

  const layout = assigned ?? await db.queryOne<{ config: unknown; id: string; name: string }>(
    `SELECT id, name, config FROM ipy_layout
     WHERE module_id = $1 AND type = $2 AND is_active AND is_default = true LIMIT 1`,
    [module.id, req.params.type],
  );

  if (!layout) throw new NotFoundError(`No ${req.params.type} layout configured for ${module.label}`);
  res.json(layout);
}));

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

metadataRouter.post('/modules/:name/relations', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.modules');
  const module = await registry.requireModule(req.params.name);
  const input = z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    label: z.string().min(1),
    target: z.string(),
    type: z.enum(['one_to_many', 'many_to_many', 'many_to_one']),
    foreignField: z.string().optional(),
    columns: z.array(z.string()).optional(),
  }).parse(req.body);

  const target = await registry.requireModule(input.target);
  if (input.type === 'one_to_many' && !input.foreignField) {
    throw new BadRequestError('A one-to-many relation needs the lookup field on the target module');
  }

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_relation (name, label, source_module_id, target_module_id, type, foreign_field, columns, is_custom, sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,(SELECT COALESCE(MAX(sequence),0)+1 FROM ipy_relation WHERE source_module_id = $3))
     RETURNING id`,
    [input.name, input.label, module.id, target.id, input.type, input.foreignField ?? null,
      input.columns ? JSON.stringify(input.columns) : null],
  );
  invalidateAll();
  res.status(201).json({ id: row?.id });
}));

metadataRouter.delete('/relations/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.modules');
  await db.query(`DELETE FROM ipy_relation WHERE id = $1 AND is_custom = true`, [req.params.id]);
  invalidateAll();
  res.json({ ok: true });
}));

metadataRouter.post('/refresh', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.modules');
  invalidateAll();
  await registry.warmup();
  res.json({ ok: true });
}));
