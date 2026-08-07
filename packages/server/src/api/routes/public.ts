/**
 * Public, unauthenticated read API for the customer-facing property website
 * (a separate app — see /Users/rishabhsinghla/Downloads/ipropy-website).
 *
 * Deliberately NOT built on recordService/the metadata engine: this router
 * hand-picks an explicit column whitelist per query so that a field added to
 * `projects`/`properties` later (or a sensitive one already there — owner
 * details, blocked-for-lead, broker commission %) can never leak here just
 * because it exists on the record. Mounted unauthenticated, same pattern as
 * webhooksRouter (see app.ts) — every handler decides its own visibility
 * instead of relying on requireAuth.
 */
import { Router } from 'express';
import { resolve } from 'node:path';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { NotFoundError } from '../../utils/errors.js';
import { getDriver, getStorageSettings } from '../../core/storage/index.js';
import { logger } from '../../utils/logger.js';

export const publicRouter = Router();

// Only records in these statuses are shown to the public, regardless of
// whatever else the query filters on. Matches the CRM's own "Active
// Inventory" / "Available Units" system views (db/seed/modules.ts).
const PUBLIC_PROJECT_STATUSES = ['New Launch', 'Under Construction', 'Nearing Possession', 'Ready To Move'];
const PUBLIC_PROPERTY_STATUS = 'Available';

// publish_to_web (db/seed/modules.ts) is a JSON-storage custom field,
// default true — an admin can hide a specific record from the website
// without changing its status. Absent key (pre-existing records, never
// re-saved since the field was added) is treated as the default: visible.
const publishClause = (alias: string) => `(${alias}.custom_fields->>'publish_to_web' IS NULL OR ${alias}.custom_fields->>'publish_to_web' = 'true')`;

// Never build ORDER BY from raw query input — a fixed whitelist keeps it injection-safe.
const PROJECT_SORTS: Record<string, string> = {
  possession: 'p.possession_date ASC NULLS LAST',
  price_asc: 'p.price_min ASC NULLS LAST',
  price_desc: 'p.price_max DESC NULLS LAST',
  newest: 'p.launch_date DESC NULLS LAST',
};
const PROPERTY_SORTS: Record<string, string> = {
  price_asc: 'u.total_price ASC NULLS LAST',
  price_desc: 'u.total_price DESC NULLS LAST',
  area_desc: 'u.carpet_area DESC NULLS LAST',
  possession: 'u.possession_date ASC NULLS LAST',
};

const PROJECT_FIELDS = `
  p.record_id AS id, p.name, p.status, p.project_type,
  d.name AS developer_name,
  p.city, p.locality, p.micro_market, p.state, p.address, p.latitude, p.longitude,
  p.rera_number, p.rera_expiry,
  p.total_land_area, p.land_area_unit, p.total_towers, p.total_floors, p.total_units,
  p.available_units, p.booked_units, p.open_area_percent,
  p.price_min, p.price_max, p.rate_per_sqft, p.configurations,
  p.launch_date, p.possession_date, p.completion_percent,
  p.amenities, p.usps, p.brochure_url, p.video_url, p.virtual_tour_url,
  p.master_plan_url, p.gallery, p.floor_plans, p.connectivity, p.description
`;

const PROPERTY_FIELDS = `
  u.record_id AS id, u.name, u.project_id, pr.name AS project_name,
  u.status, u.property_type, u.configuration,
  u.tower, u.wing, u.floor, u.facing, u.view_description, u.corner_unit, u.vastu_compliant,
  u.carpet_area, u.built_up_area, u.super_built_up_area, u.plot_area, u.balcony_area, u.terrace_area, u.area_unit,
  u.bedrooms, u.bathrooms, u.balconies, u.parking_slots, u.furnishing,
  u.base_price, u.rate_per_sqft, u.floor_rise_charge, u.plc_charge, u.parking_charge,
  u.club_membership, u.maintenance_deposit, u.other_charges, u.gst_percent, u.total_price,
  u.possession_status, u.possession_date, u.is_resale,
  u.gallery, u.floor_plan_url, u.video_url, u.virtual_tour_url, u.amenities,
  u.city, u.locality, u.latitude, u.longitude, u.description
`;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

publicRouter.get('/projects', asyncHandler(async (req, res) => {
  const conds: string[] = [`p.status = ANY($1)`, publishClause('p')];
  const params: unknown[] = [PUBLIC_PROJECT_STATUSES];

  const push = (sql: string, value: unknown) => { params.push(value); conds.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.city) push(`p.city = ?`, String(req.query.city));
  if (req.query.locality) push(`p.locality = ?`, String(req.query.locality));
  if (req.query.configuration) push(`p.configurations @> ?::jsonb`, JSON.stringify([String(req.query.configuration)]));
  if (req.query.minPrice) push(`p.price_max >= ?`, Number(req.query.minPrice));
  if (req.query.maxPrice) push(`p.price_min <= ?`, Number(req.query.maxPrice));
  if (req.query.possessionBy) push(`p.possession_date <= ?`, String(req.query.possessionBy));

  const limit = Math.min(48, Number(req.query.limit) || 24);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  params.push(limit, offset);

  const sort = PROJECT_SORTS[String(req.query.sort)] ?? PROJECT_SORTS.possession;

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT ${PROJECT_FIELDS}
       FROM ipy_e_projects p
       LEFT JOIN ipy_e_organizations d ON d.record_id = p.developer_id
       WHERE ${conds.join(' AND ')}
       ORDER BY ${sort}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    db.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_e_projects p WHERE ${conds.join(' AND ')}`,
      params.slice(0, -2),
    ),
  ]);
  res.json({ items: rows.rows.map(toPublicMedia), total: count?.count ?? 0 });
}));

publicRouter.get('/projects/:id', asyncHandler(async (req, res) => {
  const project = await db.queryOne(
    `SELECT ${PROJECT_FIELDS}
     FROM ipy_e_projects p
     LEFT JOIN ipy_e_organizations d ON d.record_id = p.developer_id
     WHERE p.record_id = $1 AND p.status = ANY($2) AND ${publishClause('p')}`,
    [req.params.id, PUBLIC_PROJECT_STATUSES],
  );
  if (!project) throw new NotFoundError('Project not found');

  const units = await db.query(
    `SELECT ${PROPERTY_FIELDS}
     FROM ipy_e_properties u
     LEFT JOIN ipy_e_projects pr ON pr.record_id = u.project_id
     WHERE u.project_id = $1 AND u.status = $2 AND ${publishClause('u')}
     ORDER BY u.total_price ASC NULLS LAST`,
    [req.params.id, PUBLIC_PROPERTY_STATUS],
  );

  const similar = await db.query(
    `SELECT ${PROJECT_FIELDS}
     FROM ipy_e_projects p
     LEFT JOIN ipy_e_organizations d ON d.record_id = p.developer_id
     WHERE p.record_id <> $1 AND p.status = ANY($2) AND p.city = $3 AND ${publishClause('p')}
     ORDER BY p.possession_date ASC NULLS LAST
     LIMIT 4`,
    [req.params.id, PUBLIC_PROJECT_STATUSES, (project as { city: string | null }).city],
  );

  res.json({
    project: toPublicMedia(project),
    units: units.rows.map(toPublicMedia),
    similar: similar.rows.map(toPublicMedia),
  });
}));

// ---------------------------------------------------------------------------
// Properties / units
// ---------------------------------------------------------------------------

publicRouter.get('/properties', asyncHandler(async (req, res) => {
  const conds: string[] = [`u.status = $1`, publishClause('u')];
  const params: unknown[] = [PUBLIC_PROPERTY_STATUS];

  const push = (sql: string, value: unknown) => { params.push(value); conds.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.project) push(`u.project_id = ?`, String(req.query.project));
  if (req.query.city) push(`u.city = ?`, String(req.query.city));
  if (req.query.configuration) push(`u.configuration = ?`, String(req.query.configuration));
  if (req.query.bedrooms) push(`u.bedrooms = ?`, Number(req.query.bedrooms));
  if (req.query.minPrice) push(`u.total_price >= ?`, Number(req.query.minPrice));
  if (req.query.maxPrice) push(`u.total_price <= ?`, Number(req.query.maxPrice));

  const limit = Math.min(48, Number(req.query.limit) || 24);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  params.push(limit, offset);

  const sort = PROPERTY_SORTS[String(req.query.sort)] ?? PROPERTY_SORTS.price_asc;

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT ${PROPERTY_FIELDS}
       FROM ipy_e_properties u
       LEFT JOIN ipy_e_projects pr ON pr.record_id = u.project_id
       WHERE ${conds.join(' AND ')}
       ORDER BY ${sort}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    db.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_e_properties u WHERE ${conds.join(' AND ')}`,
      params.slice(0, -2),
    ),
  ]);
  res.json({ items: rows.rows.map(toPublicMedia), total: count?.count ?? 0 });
}));

publicRouter.get('/properties/:id', asyncHandler(async (req, res) => {
  const unit = await db.queryOne(
    `SELECT ${PROPERTY_FIELDS}
     FROM ipy_e_properties u
     LEFT JOIN ipy_e_projects pr ON pr.record_id = u.project_id
     WHERE u.record_id = $1 AND u.status = $2 AND ${publishClause('u')}`,
    [req.params.id, PUBLIC_PROPERTY_STATUS],
  );
  if (!unit) throw new NotFoundError('Property not found');
  res.json(toPublicMedia(unit));
}));

// ---------------------------------------------------------------------------
// Filters — live picklist values, so the site's filter UI never drifts from
// what admins have actually configured.
// ---------------------------------------------------------------------------

publicRouter.get('/filters', asyncHandler(async (_req, res) => {
  const rows = await db.query<{ name: string; value: string; label: string }>(
    `SELECT pl.name, plv.value, plv.label
     FROM ipy_picklist_value plv
     JOIN ipy_picklist pl ON pl.id = plv.picklist_id
     WHERE pl.name IN ('city', 'locality', 'configuration', 'amenities') AND plv.is_active
     ORDER BY plv.sequence`,
  );
  const grouped: Record<string, { value: string; label: string }[]> = { city: [], locality: [], configuration: [], amenities: [] };
  for (const r of rows.rows) grouped[r.name]?.push({ value: r.value, label: r.label });
  res.json(grouped);
}));

// City summaries for the website's /cities landing pages — one aggregate
// query rather than the site looping a `city=` filter per picklist value.
publicRouter.get('/cities', asyncHandler(async (_req, res) => {
  const rows = await db.query<{ city: string; project_count: number; unit_count: number; price_min: number | null; price_max: number | null }>(
    `SELECT p.city,
            COUNT(DISTINCT p.record_id)::int AS project_count,
            COALESCE(SUM(p.available_units), 0)::int AS unit_count,
            MIN(p.price_min) AS price_min,
            MAX(p.price_max) AS price_max
     FROM ipy_e_projects p
     WHERE p.status = ANY($1) AND ${publishClause('p')} AND p.city IS NOT NULL
     GROUP BY p.city
     ORDER BY project_count DESC`,
    [PUBLIC_PROJECT_STATUSES],
  );
  res.json({ items: rows.rows });
}));

// ---------------------------------------------------------------------------
// Media — the CRM's own /api/files/:id requires auth. Gallery/floor-plan
// fields on projects/properties store URLs of that same shape
// (`/api/files/<attachment-id>`), so this serves the same bytes without
// auth, but only for an attachment whose owning record currently passes the
// public-visibility filter above — an id alone isn't enough to fetch it.
// ---------------------------------------------------------------------------

publicRouter.get('/media/:attachmentId', asyncHandler(async (req, res) => {
  const file = await db.queryOne<{ storage_key: string; file_name: string; mime_type: string; record_id: string | null }>(
    `SELECT storage_key, file_name, mime_type, record_id FROM ipy_attachment WHERE id = $1`,
    [req.params.attachmentId],
  );
  if (!file?.record_id) throw new NotFoundError('File not found');

  const visible = await db.queryOne(
    `SELECT 1 FROM ipy_e_projects WHERE record_id = $1 AND status = ANY($2) AND ${publishClause('ipy_e_projects')}
     UNION ALL
     SELECT 1 FROM ipy_e_properties WHERE record_id = $1 AND status = $3 AND ${publishClause('ipy_e_properties')}`,
    [file.record_id, PUBLIC_PROJECT_STATUSES, PUBLIC_PROPERTY_STATUS],
  );
  if (!visible) throw new NotFoundError('File not found');

  const storage = getStorageSettings();
  if (storage.driver === 'local') {
    const path = resolve(storage.localPath, file.storage_key);
    if (!path.startsWith(resolve(storage.localPath))) throw new NotFoundError('File not found');
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path, (err) => {
      if (err) {
        logger.warn({ err, id: req.params.attachmentId }, 'public file stream failed');
        if (!res.headersSent) res.status(404).json({ error: 'not_found' });
      }
    });
    return;
  }

  const data = await getDriver().then((driver) => driver.read(file.storage_key));
  if (!data) throw new NotFoundError('File is missing from storage');
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(data);
}));

// ---------------------------------------------------------------------------
// Normalise stored `/api/files/:id` URLs (gallery, floor plans) into the
// public media route, in whatever field on the row holds them.
// ---------------------------------------------------------------------------

function toPublicUrl(u: string): string {
  const m = /\/api\/files\/([^/?#]+)/.exec(u);
  return m ? `/api/public/media/${m[1]}` : u;
}

function toPublicMedia<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const key of ['gallery', 'floor_plans'] as const) {
    const val = out[key];
    if (Array.isArray(val)) out[key] = val.map((v) => (typeof v === 'string' ? toPublicUrl(v) : v));
  }
  for (const key of ['floor_plan_url', 'master_plan_url'] as const) {
    const val = out[key];
    if (typeof val === 'string' && val) out[key] = toPublicUrl(val);
  }
  return out as T;
}
