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
// Inventory" / "Available Units" system views (db/seed/templates/realEstate.ts).
const PUBLIC_PROPERTY_STATUS = 'Available';

// publish_to_web (db/seed/templates/realEstate.ts) is a JSON-storage custom field,
// default true — an admin can hide a specific record from the website
// without changing its status. Absent key (pre-existing records, never
// re-saved since the field was added) is treated as the default: visible.
const publishClause = (alias: string) => `(${alias}.custom_fields->>'publish_to_web' IS NULL OR ${alias}.custom_fields->>'publish_to_web' = 'true')`;

// Never build ORDER BY from raw query input — a fixed whitelist keeps it injection-safe.
const PROJECT_SORTS: Record<string, string> = {
  possession: 'MIN(u.possession_date) ASC NULLS LAST',
  price_asc: 'MIN(u.total_price) ASC NULLS LAST',
  price_desc: 'MAX(u.total_price) DESC NULLS LAST',
  newest: 'MAX(u.created_at) DESC NULLS LAST',
};
const PROPERTY_SORTS: Record<string, string> = {
  price_asc: 'u.total_price ASC NULLS LAST',
  price_desc: 'u.total_price DESC NULLS LAST',
  area_desc: 'u.carpet_area DESC NULLS LAST',
  possession: 'u.possession_date ASC NULLS LAST',
};

/**
 * A "project" is now derived, not stored.
 *
 * The Projects module was removed from the CRM; each unit carries its
 * development's name instead. The website's project pages, sitemap and
 * structured data all key off this shape, so it is preserved exactly —
 * aggregated from the units that belong to the development. `id` is a slug of
 * the name rather than a record id, which is a better public URL anyway.
 *
 * Columns a project used to own on its own (RERA number, USPs, master plan,
 * construction progress) have nowhere to come from and are returned null so
 * the response shape does not change under the site's feet.
 */
const PROJECT_FIELDS = `
  lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g')) AS id,
  MIN(u.project_name) AS name,
  MIN(u.possession_status) AS status,
  MIN(u.property_type) AS project_type,
  MIN(u.city) AS city, MIN(u.locality) AS locality,
  NULL::text AS micro_market, NULL::text AS state, NULL::jsonb AS address,
  AVG(u.latitude) AS latitude, AVG(u.longitude) AS longitude,
  NULL::text AS rera_number, NULL::date AS rera_expiry,
  NULL::numeric AS total_land_area, NULL::text AS land_area_unit,
  COUNT(DISTINCT u.tower)::int AS total_towers,
  MAX(u.floor)::int AS total_floors,
  COUNT(*)::int AS total_units,
  COUNT(*)::int AS available_units, 0 AS booked_units, NULL::numeric AS open_area_percent,
  MIN(u.total_price) AS price_min, MAX(u.total_price) AS price_max,
  AVG(u.rate_per_sqft) AS rate_per_sqft,
  COALESCE(jsonb_agg(DISTINCT u.configuration) FILTER (WHERE u.configuration IS NOT NULL), '[]'::jsonb) AS configurations,
  NULL::date AS launch_date, MIN(u.possession_date) AS possession_date,
  NULL::numeric AS completion_percent,
  COALESCE(jsonb_agg(DISTINCT a.amenity) FILTER (WHERE a.amenity IS NOT NULL), '[]'::jsonb) AS amenities,
  '[]'::jsonb AS usps, NULL::text AS brochure_url,
  MIN(u.video_url) AS video_url, MIN(u.virtual_tour_url) AS virtual_tour_url,
  NULL::text AS master_plan_url,
  COALESCE(jsonb_agg(DISTINCT g.image) FILTER (WHERE g.image IS NOT NULL), '[]'::jsonb) AS gallery,
  '[]'::jsonb AS floor_plans, '[]'::jsonb AS connectivity,
  MIN(u.description) AS description
`;

/**
 * Units feeding a derived project. `amenities` and `gallery` are JSONB arrays,
 * so they are unnested to be aggregated distinctly across the development.
 */
const PROJECT_FROM = `
  FROM ipy_e_properties u
  LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(u.amenities, '[]'::jsonb)) AS a(amenity) ON true
  LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(u.gallery, '[]'::jsonb)) AS g(image) ON true
`;

/** Every derived project query shares these: published, available, named. */
const PROJECT_BASE_CONDS = (): string[] =>
  [`u.status = $1`, publishClause('u'), `u.project_name IS NOT NULL`, `btrim(u.project_name) <> ''`];

const PROJECT_GROUP = `GROUP BY lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g'))`;

const PROPERTY_FIELDS = `
  u.record_id AS id, u.name,
  lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g')) AS project_id,
  u.project_name,
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
  const conds = PROJECT_BASE_CONDS();
  const params: unknown[] = [PUBLIC_PROPERTY_STATUS];

  const push = (sql: string, value: unknown) => { params.push(value); conds.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.city) push(`u.city = ?`, String(req.query.city));
  if (req.query.locality) push(`u.locality = ?`, String(req.query.locality));
  if (req.query.configuration) push(`u.configuration = ?`, String(req.query.configuration));
  if (req.query.minPrice) push(`u.total_price >= ?`, Number(req.query.minPrice));
  if (req.query.maxPrice) push(`u.total_price <= ?`, Number(req.query.maxPrice));
  if (req.query.possessionBy) push(`u.possession_date <= ?`, String(req.query.possessionBy));

  const limit = Math.min(48, Number(req.query.limit) || 24);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  params.push(limit, offset);

  const sort = PROJECT_SORTS[String(req.query.sort)] ?? PROJECT_SORTS.possession;

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT ${PROJECT_FIELDS}
       ${PROJECT_FROM}
       WHERE ${conds.join(' AND ')}
       ${PROJECT_GROUP}
       ORDER BY ${sort}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    db.queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT btrim(u.project_name))::int AS count
       FROM ipy_e_properties u WHERE ${conds.join(' AND ')}`,
      params.slice(0, -2),
    ),
  ]);
  res.json({ items: rows.rows.map((r) => toPublicMedia(r)), total: count?.count ?? 0 });
}));

publicRouter.get('/projects/:id', asyncHandler(async (req, res) => {
  const slug = `lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g')) = $2`;

  const project = await db.queryOne<{ name: string; city: string | null }>(
    `SELECT ${PROJECT_FIELDS}
     ${PROJECT_FROM}
     WHERE ${[...PROJECT_BASE_CONDS(), slug].join(' AND ')}
     ${PROJECT_GROUP}`,
    [PUBLIC_PROPERTY_STATUS, req.params.id],
  );
  if (!project) throw new NotFoundError('Project not found');

  const units = await db.query(
    `SELECT ${PROPERTY_FIELDS}
     FROM ipy_e_properties u
     WHERE ${[...PROJECT_BASE_CONDS(), slug].join(' AND ')}
     ORDER BY u.total_price ASC NULLS LAST`,
    [PUBLIC_PROPERTY_STATUS, req.params.id],
  );

  const similar = await db.query(
    `SELECT ${PROJECT_FIELDS}
     ${PROJECT_FROM}
     WHERE ${[...PROJECT_BASE_CONDS(), `u.city = $2`, `btrim(u.project_name) <> $3`].join(' AND ')}
     ${PROJECT_GROUP}
     ORDER BY MIN(u.possession_date) ASC NULLS LAST
     LIMIT 4`,
    [PUBLIC_PROPERTY_STATUS, project.city, project.name],
  );

  res.json({
    project: toPublicMedia(project, 'large'),
    units: units.rows.map((r) => toPublicMedia(r)),
    similar: similar.rows.map((r) => toPublicMedia(r)),
  });
}));

// ---------------------------------------------------------------------------
// Properties / units
// ---------------------------------------------------------------------------

publicRouter.get('/properties', asyncHandler(async (req, res) => {
  const conds: string[] = [`u.status = $1`, publishClause('u')];
  const params: unknown[] = [PUBLIC_PROPERTY_STATUS];

  const push = (sql: string, value: unknown) => { params.push(value); conds.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.project) push(`lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g')) = ?`, String(req.query.project));
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
  res.json({ items: rows.rows.map((r) => toPublicMedia(r)), total: count?.count ?? 0 });
}));

publicRouter.get('/properties/:id', asyncHandler(async (req, res) => {
  const unit = await db.queryOne(
    `SELECT ${PROPERTY_FIELDS}
     FROM ipy_e_properties u
     WHERE u.record_id = $1 AND u.status = $2 AND ${publishClause('u')}`,
    [req.params.id, PUBLIC_PROPERTY_STATUS],
  );
  if (!unit) throw new NotFoundError('Property not found');
  res.json(toPublicMedia(unit, 'large'));
}));

// ---------------------------------------------------------------------------
// Filters — live picklist values, so the site's filter UI never drifts from
// what admins have actually configured.
// ---------------------------------------------------------------------------

/**
 * Public branding — the sign-in screen renders before anyone is authenticated,
 * so it cannot use `/api/brand`. Only the outward-facing fields are exposed
 * here (name, brand line, the accounts already published on the company's own
 * website); the office phone and inbox stay behind auth on `/api/brand`.
 */
publicRouter.get('/brand', asyncHandler(async (_req, res) => {
  const rows = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM ipy_setting WHERE key IN ('brand.tagline', 'social.links', 'org.name')`,
  );
  const map = new Map(rows.rows.map((r) => [r.key, r.value]));
  const rawLinks = map.get('social.links');
  const links = Array.isArray(rawLinks) ? rawLinks as { platform?: string; label?: string; url?: string }[] : [];

  res.json({
    orgName: (map.get('org.name') as string) ?? 'iPropy',
    tagline: (map.get('brand.tagline') as string) ?? null,
    socialLinks: links
      .filter((l) => typeof l.url === 'string' && /^https?:\/\//i.test(l.url))
      .map((l) => ({ platform: String(l.platform ?? 'link'), label: String(l.label ?? 'Link'), url: l.url as string })),
  });
}));

// ---------------------------------------------------------------------------
// Blog
//
// Visibility is enforced here, not in the CRM's UI: only Published posts with
// a publish time in the past and noindex off are ever returned, so a draft or
// a scheduled post cannot leak by guessing a URL.
// ---------------------------------------------------------------------------

const PUBLISHED = `r.is_deleted = false AND b.status = 'Published'
  AND b.published_at IS NOT NULL AND b.published_at <= now() AND b.noindex = false`;

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
    `SELECT u.city,
            COUNT(DISTINCT btrim(u.project_name))::int AS project_count,
            COUNT(*)::int AS unit_count,
            MIN(u.total_price) AS price_min,
            MAX(u.total_price) AS price_max
     FROM ipy_e_properties u
     WHERE u.status = $1 AND ${publishClause('u')} AND u.city IS NOT NULL
     GROUP BY u.city
     ORDER BY project_count DESC`,
    [PUBLIC_PROPERTY_STATUS],
  );
  res.json({ items: rows.rows });
}));

// ---------------------------------------------------------------------------
// Media — the CRM's own /api/files/:id requires auth. Gallery/floor-plan
// fields on projects/properties store URLs of that same shape
// (`/api/files/<attachment-id>`), so this serves the same bytes without
// auth, but only for an attachment whose owning record currently passes the
// public-visibility filter above — an id alone isn't enough to fetch it.
// ?size=thumb|medium|large serves the resized/watermarked derivative
// (core/media/pipeline.ts) when one exists, falling back to the untouched
// original otherwise — this is the whole reason the website is fast: it
// never downloads a multi-MB original just to show a listing thumbnail.
// ---------------------------------------------------------------------------

const VARIANT_SIZES = new Set(['thumb', 'medium', 'large']);

publicRouter.get('/media/:attachmentId', asyncHandler(async (req, res) => {
  const file = await db.queryOne<{ storage_key: string; file_name: string; mime_type: string; record_id: string | null; variants: Record<string, string> | null }>(
    `SELECT storage_key, file_name, mime_type, record_id, variants FROM ipy_attachment WHERE id = $1`,
    [req.params.attachmentId],
  );
  if (!file?.record_id) throw new NotFoundError('File not found');

  const visible = await db.queryOne(
    `SELECT 1 FROM ipy_e_properties WHERE record_id = $1 AND status = $2 AND ${publishClause('ipy_e_properties')}`,
    [file.record_id, PUBLIC_PROPERTY_STATUS],
  );
  if (!visible) throw new NotFoundError('File not found');

  const requestedSize = typeof req.query.size === 'string' ? req.query.size : null;
  const variantKey = requestedSize && VARIANT_SIZES.has(requestedSize) ? file.variants?.[requestedSize] : undefined;
  const storageKey = variantKey ?? file.storage_key;
  const mimeType = variantKey ? 'image/webp' : file.mime_type;

  const storage = getStorageSettings();
  if (storage.driver === 'local') {
    const path = resolve(storage.localPath, storageKey);
    if (!path.startsWith(resolve(storage.localPath))) throw new NotFoundError('File not found');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path, (err) => {
      if (err) {
        logger.warn({ err, id: req.params.attachmentId }, 'public file stream failed');
        if (!res.headersSent) res.status(404).json({ error: 'not_found' });
      }
    });
    return;
  }

  const data = await getDriver().then((driver) => driver.read(storageKey));
  if (!data) throw new NotFoundError('File is missing from storage');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(data);
}));

// ---------------------------------------------------------------------------
// Normalise stored `/api/files/:id` URLs (gallery, floor plans) into the
// public media route, requesting a specific derivative size — `medium` for
// card/grid contexts (project & property lists, similar/units cards),
// `large` for the record the visitor is actually looking at in detail.
// ---------------------------------------------------------------------------

function toPublicUrl(u: string, size: 'medium' | 'large'): string {
  const m = /\/api\/files\/([^/?#]+)/.exec(u);
  return m ? `/api/public/media/${m[1]}?size=${size}` : u;
}

function toPublicMedia<T extends Record<string, unknown>>(row: T, size: 'medium' | 'large' = 'medium'): T {
  const out: Record<string, unknown> = { ...row };
  for (const key of ['gallery', 'floor_plans'] as const) {
    const val = out[key];
    if (Array.isArray(val)) out[key] = val.map((v) => (typeof v === 'string' ? toPublicUrl(v, size) : v));
  }
  for (const key of ['floor_plan_url', 'master_plan_url'] as const) {
    const val = out[key];
    if (typeof val === 'string' && val) out[key] = toPublicUrl(val, size);
  }
  return out as T;
}
