import { Router } from 'express';
import { z } from 'zod';
import { db, transaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { blockApiKey, getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { assertCapability, assertModuleAccess, canAccessRecord } from '../../core/permissions/index.js';
import { recordService } from '../../core/entity/recordService.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';

/** Dedicated Project-only data APIs. These masters never read or mutate CRM picklists. */
export const projectWorkspaceRouter = Router();
projectWorkspaceRouter.use(requireAuth);

const MASTER_KEYS = new Set([
  'category', 'project_type', 'project_status', 'developer', 'state', 'city', 'locality',
  'area_unit', 'accommodation', 'facing', 'furnishing', 'amenities', 'approvals', 'possession',
]);

const profileSchema = z.object({
  projectCode: z.string().max(100).nullable().optional(),
  developer: z.string().max(200).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  projectType: z.string().max(100).nullable().optional(),
  reraNumber: z.string().max(200).nullable().optional(),
  reraExpiry: z.string().date().nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  sector: z.string().max(150).nullable().optional(),
  locality: z.string().max(150).nullable().optional(),
  address: z.string().max(2000).nullable().optional(),
  pincode: z.string().max(20).nullable().optional(),
  landmark: z.string().max(300).nullable().optional(),
  googleMapsUrl: z.string().url().max(2000).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  projectStatus: z.string().max(100).nullable().optional(),
  launchDate: z.string().date().nullable().optional(),
  possessionDate: z.string().date().nullable().optional(),
  constructionProgress: z.number().min(0).max(100).nullable().optional(),
  totalLandArea: z.number().nonnegative().nullable().optional(),
  areaUnit: z.string().max(30).optional(),
  towerCount: z.number().int().nonnegative().nullable().optional(),
  blockCount: z.number().int().nonnegative().nullable().optional(),
  floorCount: z.number().int().nonnegative().nullable().optional(),
  unitCount: z.number().int().nonnegative().nullable().optional(),
  startingPrice: z.number().nonnegative().nullable().optional(),
  maximumPrice: z.number().nonnegative().nullable().optional(),
  bookingAmount: z.number().nonnegative().nullable().optional(),
  paymentPlans: z.array(z.string().max(200)).max(40).optional(),
  approvals: z.array(z.string().max(200)).max(40).optional(),
  amenities: z.array(z.string().max(200)).max(100).optional(),
  highlights: z.string().max(10000).nullable().optional(),
  description: z.string().max(30000).nullable().optional(),
  assignedAgentId: z.string().uuid().nullable().optional(),
  projectManagerId: z.string().uuid().nullable().optional(),
  lifecycle: z.enum(['draft', 'published', 'archived']).optional(),
});

const PROFILE_COLUMNS: Record<string, string> = {
  projectCode: 'project_code', developer: 'developer', category: 'category', projectType: 'project_type',
  reraNumber: 'rera_number', reraExpiry: 'rera_expiry', state: 'state', city: 'city', sector: 'sector',
  locality: 'locality', address: 'address', pincode: 'pincode', landmark: 'landmark', googleMapsUrl: 'google_maps_url',
  latitude: 'latitude', longitude: 'longitude', projectStatus: 'project_status', launchDate: 'launch_date',
  possessionDate: 'possession_date', constructionProgress: 'construction_progress', totalLandArea: 'total_land_area',
  areaUnit: 'area_unit', towerCount: 'tower_count', blockCount: 'block_count', floorCount: 'floor_count',
  unitCount: 'unit_count', startingPrice: 'starting_price', maximumPrice: 'maximum_price', bookingAmount: 'booking_amount',
  paymentPlans: 'payment_plans', approvals: 'approvals', amenities: 'amenities', highlights: 'highlights',
  description: 'description', assignedAgentId: 'assigned_agent_id', projectManagerId: 'project_manager_id', lifecycle: 'lifecycle',
};

projectWorkspaceRouter.get('/masters', asyncHandler(async (_req, res) => {
  const result = await db.query<{ master_key: string; value: string; label: string; sort_order: number; is_active: boolean }>(
    `SELECT master_key, value, label, sort_order, is_active FROM ipy_project_master_values ORDER BY master_key, sort_order, label`,
  );
  const masters: Record<string, { value: string; label: string; sortOrder: number; isActive: boolean }[]> = {};
  for (const row of result.rows) {
    (masters[row.master_key] ??= []).push({ value: row.value, label: row.label, sortOrder: row.sort_order, isActive: row.is_active });
  }
  res.json(masters);
}));

projectWorkspaceRouter.put('/masters/:key', blockApiKey, asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.picklists');
  const key = req.params.key;
  if (!MASTER_KEYS.has(key)) throw new NotFoundError('Project dropdown not found');
  const body = z.object({ values: z.array(z.string().trim().min(1).max(150)).max(300) }).parse(req.body);
  const normalized = body.values.map((label) => ({ label, value: label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') }));
  if (new Set(normalized.map((item) => item.value)).size !== normalized.length) throw new BadRequestError('Dropdown values must be unique');
  await transaction(async (tx) => {
    await tx.query(`UPDATE ipy_project_master_values SET is_active=false, updated_at=now() WHERE master_key=$1`, [key]);
    for (const [index, item] of normalized.entries()) {
      await tx.query(
        `INSERT INTO ipy_project_master_values (master_key,value,label,sort_order,is_active,updated_at)
         VALUES ($1,$2,$3,$4,true,now())
         ON CONFLICT (master_key,value) DO UPDATE SET label=EXCLUDED.label,sort_order=EXCLUDED.sort_order,is_active=true,updated_at=now()`,
        [key, item.value, item.label, (index + 1) * 10],
      );
    }
  });
  res.json({ ok: true, count: normalized.length });
}));

projectWorkspaceRouter.get('/:id/profile', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  await recordService.getRecord(scope, 'projects', req.params.id);
  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT * FROM ipy_project_profiles WHERE project_id=$1`, [req.params.id],
  );
  if (!row) { res.json({ projectId: req.params.id, profile: null }); return; }
  const profile: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(PROFILE_COLUMNS)) profile[key] = row[column];
  res.json({ projectId: req.params.id, profile });
}));

projectWorkspaceRouter.put('/:id/profile', blockApiKey, asyncHandler(async (req, res) => {
  const scope = getScope(req);
  await assertModuleAccess(scope.user, 'projects', 'edit');
  await recordService.getRecord(scope, 'projects', req.params.id);
  if (!(await canAccessRecord(scope, 'projects', req.params.id, 'edit'))) throw new NotFoundError('Project not found');
  const profile = profileSchema.parse(req.body);
  const entries = Object.entries(profile).filter(([key]) => PROFILE_COLUMNS[key]);
  const columns = ['project_id', ...entries.map(([key]) => PROFILE_COLUMNS[key]), 'updated_by', 'updated_at'];
  const jsonFields = new Set(['paymentPlans', 'approvals', 'amenities']);
  const values: unknown[] = [
    req.params.id,
    ...entries.map(([key, value]) => jsonFields.has(key) && value != null ? JSON.stringify(value) : value),
    scope.user.id,
  ];
  const placeholders = values.map((_, index) => `$${index + 1}`);
  const updates = entries.map(([key]) => {
    const column = PROFILE_COLUMNS[key];
    return `${column}=EXCLUDED.${column}`;
  });
  updates.push('updated_by=EXCLUDED.updated_by', 'updated_at=now()');
  const saved = await transaction(async (tx) => {
    const previous = await tx.queryOne<Record<string, unknown>>(`SELECT * FROM ipy_project_profiles WHERE project_id=$1 FOR UPDATE`, [req.params.id]);
    const row = await tx.queryOne<Record<string, unknown>>(
      `INSERT INTO ipy_project_profiles (${columns.join(',')}) VALUES (${placeholders.join(',')},now())
       ON CONFLICT (project_id) DO UPDATE SET ${updates.join(',')} RETURNING *`, values,
    );
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, column] of Object.entries(PROFILE_COLUMNS)) {
      if (!(key in profile)) continue;
      const before = previous?.[column] ?? null;
      const after = row?.[column] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes[key] = { from: before, to: after };
    }
    if (Object.keys(changes).length) {
      await tx.query(`INSERT INTO ipy_project_audit (project_id,user_id,action,changes) VALUES ($1,$2,'profile_updated',$3::jsonb)`, [req.params.id, scope.user.id, JSON.stringify(changes)]);
    }
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(PROFILE_COLUMNS)) out[key] = row?.[column] ?? null;
    return out;
  });
  res.json({ projectId: req.params.id, profile: saved });
}));

projectWorkspaceRouter.get('/:id/audit', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  await recordService.getRecord(scope, 'projects', req.params.id);
  const rows = await db.query(
    `SELECT a.id,a.action,a.changes,a.created_at,u.first_name,u.last_name
     FROM ipy_project_audit a LEFT JOIN ipy_user u ON u.id=a.user_id
     WHERE a.project_id=$1 ORDER BY a.created_at DESC LIMIT 200`, [req.params.id],
  );
  res.json(rows.rows);
}));

const accommodationSchema = z.object({
  configuration: z.string().trim().min(1).max(150),
  bedrooms: z.number().min(0).max(20).nullable().optional(),
  bathrooms: z.number().int().min(0).max(30).nullable().optional(),
  balconies: z.number().int().min(0).max(30).nullable().optional(),
  kitchens: z.number().int().min(0).max(10).nullable().optional(),
  studyRooms: z.number().int().min(0).max(10).nullable().optional(),
  servantRooms: z.number().int().min(0).max(10).nullable().optional(),
  parkingSpaces: z.number().int().min(0).max(30).nullable().optional(),
  facing: z.string().max(100).nullable().optional(),
  furnishing: z.string().max(100).nullable().optional(),
  floorPreference: z.string().max(100).nullable().optional(),
  carpetArea: z.number().nonnegative().nullable().optional(),
  builtUpArea: z.number().nonnegative().nullable().optional(),
  superBuiltUpArea: z.number().nonnegative().nullable().optional(),
  plotArea: z.number().nonnegative().nullable().optional(),
  areaUnit: z.string().min(1).max(30),
  priceMin: z.number().nonnegative().nullable().optional(),
  priceMax: z.number().nonnegative().nullable().optional(),
});

const accommodationColumns: Record<string, string> = {
  configuration: 'configuration', bedrooms: 'bedrooms', bathrooms: 'bathrooms', balconies: 'balconies',
  kitchens: 'kitchens', studyRooms: 'study_rooms', servantRooms: 'servant_rooms', parkingSpaces: 'parking_spaces',
  facing: 'facing', furnishing: 'furnishing', floorPreference: 'floor_preference', carpetArea: 'carpet_area',
  builtUpArea: 'built_up_area', superBuiltUpArea: 'super_built_up_area', plotArea: 'plot_area', areaUnit: 'area_unit',
  priceMin: 'price_min', priceMax: 'price_max',
};

const assetSchema = z.object({
  category: z.enum(['layout_plan','floor_plan','cluster_plan','elevation','gallery','video','document','brochure','virtual_tour']),
  title: z.string().trim().min(1).max(200),
  url: z.string().url().max(2000),
  mimeType: z.string().max(150).nullable().optional(),
  caption: z.string().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  isCover: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const nodeSchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  nodeType: z.enum(['phase','tower','block','floor','unit','plot']),
  name: z.string().trim().min(1).max(200),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  availability: z.enum(['available','reserved','booked','sold','not_for_sale']).nullable().optional(),
  price: z.number().nonnegative().nullable().optional(),
  area: z.number().nonnegative().nullable().optional(),
  areaUnit: z.string().max(30).nullable().optional(),
  inventoryRecordId: z.string().uuid().nullable().optional(),
  attributes: z.record(z.unknown()).optional(),
});

async function getProject(req: Parameters<Parameters<typeof asyncHandler>[0]>[0], edit = false): Promise<void> {
  const scope = getScope(req);
  await assertModuleAccess(scope.user, 'projects', edit ? 'edit' : 'view');
  const projectId = z.string().uuid().parse(req.params.id);
  const project = await recordService.getRecord(scope, 'projects', projectId);
  if (edit && !(await canAccessRecord(scope, 'projects', projectId, 'edit'))) throw new NotFoundError('Project not found');
}

projectWorkspaceRouter.get('/:id/accommodations', asyncHandler(async (req, res) => {
  await getProject(req);
  const rows = await db.query(
    `SELECT id,configuration,bedrooms,bathrooms,balconies,kitchens,study_rooms AS "studyRooms",
      servant_rooms AS "servantRooms",parking_spaces AS "parkingSpaces",facing,furnishing,
      floor_preference AS "floorPreference",carpet_area AS "carpetArea",built_up_area AS "builtUpArea",
      super_built_up_area AS "superBuiltUpArea",plot_area AS "plotArea",area_unit AS "areaUnit",
      price_min AS "priceMin",price_max AS "priceMax"
     FROM ipy_project_accommodations WHERE project_id=$1 AND is_active=true ORDER BY configuration,carpet_area`,
    [req.params.id],
  );
  res.json(rows.rows);
}));

projectWorkspaceRouter.post('/:id/accommodations', blockApiKey, asyncHandler(async (req, res) => {
  await getProject(req, true);
  const value = accommodationSchema.parse(req.body);
  const entries = Object.entries(value);
  const columns = ['project_id', ...entries.map(([key]) => accommodationColumns[key])];
  const params = [req.params.id, ...entries.map(([, item]) => item ?? null)];
  const sqlValues = params.map((_, index) => `$${index + 1}`);
  const row = await db.queryOne(
    `INSERT INTO ipy_project_accommodations (${columns.join(',')}) VALUES (${sqlValues.join(',')}) RETURNING id`, params,
  );
  res.status(201).json({ id: row?.id });
}));

projectWorkspaceRouter.delete('/:id/accommodations/:itemId', blockApiKey, asyncHandler(async (req, res) => {
  await getProject(req, true);
  const result = await db.query(
    `UPDATE ipy_project_accommodations SET is_active=false,updated_at=now() WHERE id=$1 AND project_id=$2 AND is_active=true`,
    [req.params.itemId, req.params.id],
  );
  if (!result.rowCount) throw new NotFoundError('Accommodation option not found');
  res.json({ ok: true });
}));

projectWorkspaceRouter.get('/:id/assets', asyncHandler(async (req, res) => {
  await getProject(req);
  const rows = await db.query(
    `SELECT id,category,title,url,mime_type AS "mimeType",caption,sort_order AS "sortOrder",is_cover AS "isCover",metadata
     FROM ipy_project_assets WHERE project_id=$1 AND is_active=true ORDER BY category,sort_order,title`,
    [req.params.id],
  );
  res.json(rows.rows);
}));

projectWorkspaceRouter.post('/:id/assets', blockApiKey, asyncHandler(async (req, res) => {
  await getProject(req, true);
  const asset = assetSchema.parse(req.body);
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_project_assets (project_id,category,title,url,mime_type,caption,sort_order,is_cover,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
    [req.params.id, asset.category, asset.title, asset.url, asset.mimeType ?? null, asset.caption ?? null,
      asset.sortOrder ?? 0, asset.isCover ?? false, JSON.stringify(asset.metadata ?? {})],
  );
  res.status(201).json({ id: row?.id });
}));

projectWorkspaceRouter.delete('/:id/assets/:assetId', blockApiKey, asyncHandler(async (req, res) => {
  await getProject(req, true);
  const result = await db.query(
    `UPDATE ipy_project_assets SET is_active=false,updated_at=now() WHERE id=$1 AND project_id=$2 AND is_active=true`,
    [req.params.assetId, req.params.id],
  );
  if (!result.rowCount) throw new NotFoundError('Project media not found');
  res.json({ ok: true });
}));

projectWorkspaceRouter.get('/:id/hierarchy', asyncHandler(async (req, res) => {
  await getProject(req);
  const rows = await db.query(
    `SELECT id,parent_id AS "parentId",node_type AS "nodeType",name,sort_order AS "sortOrder",
      availability,price,area,area_unit AS "areaUnit",inventory_record_id AS "inventoryRecordId",attributes
     FROM ipy_project_nodes WHERE project_id=$1 AND is_active=true ORDER BY node_type,sort_order,name`,
    [req.params.id],
  );
  res.json(rows.rows);
}));

projectWorkspaceRouter.post('/:id/hierarchy', blockApiKey, asyncHandler(async (req, res) => {
  await getProject(req, true);
  const node = nodeSchema.parse(req.body);
  if (node.inventoryRecordId) {
    const inventory = await recordService.getRecord(getScope(req), 'properties', node.inventoryRecordId);
    if (!inventory.can?.view) throw new NotFoundError('Inventory record not found');
  }
  if (node.parentId) {
    const parent = await db.queryOne<{ project_id: string }>(`SELECT project_id FROM ipy_project_nodes WHERE id=$1 AND is_active=true`, [node.parentId]);
    if (parent?.project_id !== req.params.id) throw new BadRequestError('Choose a parent inside this project');
  }
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_project_nodes (project_id,parent_id,node_type,name,sort_order,availability,price,area,area_unit,inventory_record_id,attributes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id`,
    [req.params.id,node.parentId ?? null,node.nodeType,node.name,node.sortOrder ?? 0,node.availability ?? null,
      node.price ?? null,node.area ?? null,node.areaUnit ?? null,node.inventoryRecordId ?? null,JSON.stringify(node.attributes ?? {})],
  );
  res.status(201).json({ id: row?.id });
}));

projectWorkspaceRouter.get('/:id/inventory-links', asyncHandler(async (req, res) => {
  await getProject(req);
  const links = await db.query<{ inventory_record_id: string }>(
    `SELECT inventory_record_id FROM ipy_project_inventory_links WHERE project_id=$1 ORDER BY linked_at DESC`, [req.params.id],
  );
  const records = await Promise.all(links.rows.map(async ({ inventory_record_id }) => {
    try { return await recordService.getRecord(getScope(req), 'properties', inventory_record_id); }
    catch { return null; }
  }));
  res.json(records.filter(Boolean));
}));

projectWorkspaceRouter.post('/:id/inventory-links', blockApiKey, asyncHandler(async (req, res) => {
  await getProject(req, true);
  const body = z.object({ inventoryRecordIds: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body);
  for (const inventoryId of body.inventoryRecordIds) {
    const inventory = await recordService.getRecord(getScope(req), 'properties', inventoryId);
    if (!inventory.can?.view) throw new NotFoundError('An Inventory record was not found');
  }
  const added: string[] = [];
  await transaction(async (tx) => {
    for (const inventoryId of body.inventoryRecordIds) {
      const inserted = await tx.query(
        `INSERT INTO ipy_project_inventory_links (project_id,inventory_record_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.params.id, inventoryId],
      );
      if (inserted.rowCount) added.push(inventoryId);
    }
  });
  res.status(201).json({ added });
}));

projectWorkspaceRouter.delete('/:id/inventory-links/:inventoryId', blockApiKey, asyncHandler(async (req, res) => {
  await getProject(req, true);
  const result = await db.query(
    `DELETE FROM ipy_project_inventory_links WHERE project_id=$1 AND inventory_record_id=$2`,
    [req.params.id, req.params.inventoryId],
  );
  if (!result.rowCount) throw new NotFoundError('Project inventory link not found');
  res.json({ ok: true });
}));
