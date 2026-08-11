import { Router } from 'express';
import { z } from 'zod';
import { UITYPE_LIST, UITYPES } from '@ipropy/shared';
import { db, transaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors.js';
import { registry } from '../../core/metadata/registry.js';
import { assertCapability, canAccessModule, getFieldPermissions, getModulePermission, hasCapability, invalidatePermissions } from '../../core/permissions/index.js';
import { FORMULA_FUNCTIONS, validateFormula } from '../../core/entity/formula.js';
import { quoteIdent } from '../../core/query/builder.js';
import { previewNumber } from '../../core/entity/numbering.js';

export const metadataRouter = Router();
metadataRouter.use(requireAuth);

/** Reload metadata + permission caches after any admin change. */
function invalidateAll(): void {
  registry.invalidate();
  invalidatePermissions();
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
      supportsConversion: (m as unknown as { supportsConversion?: boolean }).supportsConversion ?? false,
      menuGroup: (m as unknown as { menuGroup?: string }).menuGroup ?? 'CRM',
      showInMenu: (m as unknown as { showInMenu?: boolean }).showInMenu ?? true,
      // Modules naming the same `settings.tabGroup` render as tabs of one
      // another — one menu entry for Properties and Projects, say. The UI reads
      // this generically, so an admin can group custom modules the same way.
      settings: (m as unknown as { settings?: Record<string, unknown> }).settings ?? {},
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
    const extra = m as unknown as {
      isCore?: boolean; disabledReason?: string | null;
      menuGroup?: string; showInMenu?: boolean;
    };
    return {
      id: m.id, name: m.name, label: m.label, singularLabel: m.singularLabel,
      icon: m.icon, color: m.color, sequence: m.sequence,
      isActive: m.isActive, isCustom: m.isCustom, isEntity: m.isEntity,
      isCore: extra.isCore ?? false,
      disabledReason: extra.disabledReason ?? null,
      menuGroup: extra.menuGroup ?? 'CRM',
      showInMenu: extra.showInMenu ?? true,
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

/** Everything the field builder needs to render its type picker. */
metadataRouter.get('/uitypes', asyncHandler(async (_req, res) => {
  res.json({ uitypes: UITYPE_LIST, formulaFunctions: FORMULA_FUNCTIONS });
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
  if (sets.length) await db.query(`UPDATE ipy_block SET ${sets.join(', ')} WHERE id = $1`, params);
  invalidateAll();
  res.json({ ok: true });
}));

metadataRouter.delete('/blocks/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const fields = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_field WHERE block_id = $1`, [req.params.id],
  );
  if ((fields?.count ?? 0) > 0) {
    throw new ConflictError('Move or delete the fields in this block first.');
  }
  await db.query(`DELETE FROM ipy_block WHERE id = $1 AND is_custom = true`, [req.params.id]);
  invalidateAll();
  res.json({ ok: true });
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

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_field
      (module_id, block_id, name, label, uitype, storage, column_name, sequence,
       is_mandatory, is_readonly, is_unique, is_custom, display_type, default_value,
       max_length, help_text, config, quick_create, mass_editable, searchable)
     VALUES ($1,$2,$3,$4,$5,'json',$3,$6,$7,$8,$9,true,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      module.id, blockId, input.name, input.label, input.uitype, seq,
      input.isMandatory, input.isReadonly, input.isUnique, input.displayType,
      input.defaultValue !== undefined ? JSON.stringify(input.defaultValue) : null,
      input.maxLength ?? null, input.helpText ?? null, JSON.stringify(input.config),
      input.quickCreate, input.massEditable, input.searchable,
    ],
  );

  // Custom fields start editable for the Administrator profile only; other
  // profiles opt in explicitly so nothing sensitive leaks by default.
  await db.query(
    `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission)
     SELECT id, $1, 'hidden' FROM ipy_profile WHERE name <> 'Administrator'
     ON CONFLICT DO NOTHING`,
    [row!.id],
  );

  invalidateAll();
  res.status(201).json(await registry.getField(module.name, input.name));
}));

metadataRouter.patch('/fields/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.fields');
  const input = fieldSchema.partial().omit({ name: true }).parse(req.body);

  const current = await db.queryOne<{ uitype: string; config: Record<string, unknown>; is_custom: boolean; module_id: string; display_type: string }>(
    `SELECT uitype, config, is_custom, module_id, display_type FROM ipy_field WHERE id = $1`, [req.params.id],
  );
  if (!current) throw new NotFoundError('Field not found');

  if (input.uitype && input.uitype !== current.uitype && !current.is_custom) {
    throw new BadRequestError('The type of a built-in field cannot be changed.');
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
  }
  invalidateAll();

  const module = await registry.getModuleById(current.module_id);
  res.json(module ? await registry.getField(module.name, (await db.queryOne<{ name: string }>(`SELECT name FROM ipy_field WHERE id = $1`, [req.params.id]))!.name) : { ok: true });
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

  const field = await db.queryOne<{ name: string; label: string; is_custom: boolean; storage: string; column_name: string; module_id: string }>(
    `SELECT name, label, is_custom, storage, column_name, module_id FROM ipy_field WHERE id = $1`, [req.params.id],
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

    if (module && field.storage === 'json') {
      // Reclaim the stored values so the JSONB doesn't accumulate dead keys.
      await tx.query(`UPDATE ${module.tableName} SET custom_fields = custom_fields - $1`, [field.column_name]);
    } else if (module && field.storage === 'column') {
      // The column has to go too, not just its metadata: several are NOT NULL
      // with no default, so leaving one behind with nothing to populate it
      // makes every subsequent insert fail.
      await tx.query(`ALTER TABLE ${module.tableName} DROP COLUMN IF EXISTS ${quoteIdent(field.column_name)}`);
    }

    // Saved views, layouts and dashboard widgets naming it would render a
    // blank column or an empty section from here on.
    await tx.query(
      `UPDATE ipy_view SET columns = COALESCE((
         SELECT jsonb_agg(c) FROM jsonb_array_elements_text(columns) AS c WHERE c <> $2
       ), '[]'::jsonb)
       WHERE module_id = $1 AND columns ? $2`,
      [field.module_id, field.name],
    );
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
  const { expression } = z.object({ expression: z.string() }).parse(req.body);
  res.json(validateFormula(expression));
}));

metadataRouter.get('/fields/:id/preview-number', asyncHandler(async (req, res) => {
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
});

metadataRouter.post('/picklists', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.picklists');
  const { name, label, values } = z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
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
  });
  invalidateAll();
  res.status(201).json(await registry.getPicklist(name));
}));

/** Replace the whole option list — how the picklist editor saves. */
metadataRouter.put('/picklists/:name/values', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.picklists');
  const { values } = z.object({ values: z.array(picklistValueSchema) }).parse(req.body);

  const picklist = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_picklist WHERE name = $1`, [req.params.name]);
  if (!picklist) throw new NotFoundError(`Unknown picklist '${req.params.name}'`);

  await transaction(async (tx) => {
    const keep = values.map((v) => v.value);
    // Deactivate rather than delete: existing records may still hold the value.
    await tx.query(
      `UPDATE ipy_picklist_value SET is_active = false
       WHERE picklist_id = $1 AND NOT (value = ANY($2::text[]))`,
      [picklist.id, keep],
    );
    for (const [i, v] of values.entries()) {
      await tx.query(
        `INSERT INTO ipy_picklist_value (picklist_id, value, label, color, sequence, is_active, is_default, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (picklist_id, value) DO UPDATE SET
           label = EXCLUDED.label, color = EXCLUDED.color, sequence = EXCLUDED.sequence,
           is_active = EXCLUDED.is_active, is_default = EXCLUDED.is_default, meta = EXCLUDED.meta`,
        [picklist.id, v.value, v.label, v.color ?? null, i, v.isActive, v.isDefault, JSON.stringify(v.meta ?? {})],
      );
    }
    // Only one default per picklist.
    const def = values.find((v) => v.isDefault);
    if (def) {
      await tx.query(
        `UPDATE ipy_picklist_value SET is_default = (value = $2) WHERE picklist_id = $1`,
        [picklist.id, def.value],
      );
    }
  });
  invalidateAll();
  res.json(await registry.getPicklist(req.params.name));
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
