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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { NotFoundError } from '../../utils/errors.js';
import { getDriver, getStorageSettings } from '../../core/storage/index.js';
import { logger } from '../../utils/logger.js';
import { recordShareView, resolveShareToken } from '../../core/sharing/shareLinks.js';
import { getPropertyShareConfig, loadSharedProperty } from '../../core/sharing/propertyShare.js';
import { photoOrderBy } from '../../core/media/ordering.js';
import { publicPropertyStatuses } from '../../core/settings/scoring.js';

export const publicRouter = Router();

// Which statuses reach the public is a setting now — see migration 059. It is
// the most customer-visible decision in this file: it chooses what every
// visitor to the website sees, and "show Booked units too, a half-sold tower
// sells the other half" is a sales decision rather than a code change.
// Read per request; the reader caches and is invalidated when settings save.

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
  [`u.status = ANY($1)`, publishClause('u'), `u.project_name IS NOT NULL`, `btrim(u.project_name) <> ''`];

const PROJECT_GROUP = `GROUP BY lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g'))`;

/**
 * What a visitor to the website may see, one field per entry.
 *
 * Still a whitelist, and still the security control described at the top of
 * this file: a field added to `properties` later cannot appear here just
 * because it exists. What changed is that a field *removed* no longer takes the
 * website down with it.
 *
 * Every name below is a field an administrator is free to delete in the admin
 * panel, and deleting one used to turn this into `column "..." does not exist`.
 * Postgres answers 42703, the API turns it into a 400, and the entire public
 * property list stops loading. Nothing names the field, and the admin panel
 * gives no warning, because removing a field it is allowed to remove is not an
 * error. So the list is filtered against the columns the table actually has.
 */
const PROPERTY_FIELD_LIST: { sql: string; needs: string[] }[] = [
  { sql: 'u.record_id AS id', needs: ['record_id'] },
  { sql: 'u.name', needs: ['name'] },
  {
    sql: `lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g')) AS project_id`,
    needs: ['project_name'],
  },
  ...[
    'project_name',
    'status', 'property_type', 'configuration',
    'tower', 'wing', 'floor', 'facing', 'view_description', 'corner_unit', 'vastu_compliant',
    'carpet_area', 'built_up_area', 'super_built_up_area', 'plot_area', 'balcony_area',
    'terrace_area', 'area_unit',
    'bedrooms', 'bathrooms', 'balconies', 'parking_slots', 'furnishing',
    'base_price', 'rate_per_sqft', 'floor_rise_charge', 'plc_charge', 'parking_charge',
    'club_membership', 'maintenance_deposit', 'other_charges', 'gst_percent', 'total_price',
    'possession_status', 'possession_date', 'is_resale',
    'gallery', 'floor_plan_url', 'video_url', 'virtual_tour_url', 'amenities',
    'city', 'locality', 'latitude', 'longitude', 'description',
  ].map((c) => ({ sql: `u.${c}`, needs: [c] })),
];

let propertyFieldsCache: string | null = null;

/** Forget which columns exist. Called whenever an admin changes the model. */
export function invalidatePublicFields(): void {
  propertyFieldsCache = null;
}

async function propertyFields(): Promise<string> {
  if (propertyFieldsCache) return propertyFieldsCache;
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'ipy_e_properties'`,
  );
  const present = new Set(rows.map((r) => r.column_name));
  const kept = PROPERTY_FIELD_LIST.filter((f) => f.needs.every((c) => present.has(c)));
  const dropped = PROPERTY_FIELD_LIST.length - kept.length;
  if (dropped > 0) {
    logger.info({ dropped }, 'public property fields: some have been removed from the model');
  }
  propertyFieldsCache = kept.map((f) => f.sql).join(', ');
  return propertyFieldsCache;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

publicRouter.get('/projects', asyncHandler(async (req, res) => {
  const conds = PROJECT_BASE_CONDS();
  const params: unknown[] = [await publicPropertyStatuses()];

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
    [await publicPropertyStatuses(), req.params.id],
  );
  if (!project) throw new NotFoundError('Project not found');

  const units = await db.query(
    `SELECT ${await propertyFields()}
     FROM ipy_e_properties u
     WHERE ${[...PROJECT_BASE_CONDS(), slug].join(' AND ')}
     ORDER BY u.total_price ASC NULLS LAST`,
    [await publicPropertyStatuses(), req.params.id],
  );

  const similar = await db.query(
    `SELECT ${PROJECT_FIELDS}
     ${PROJECT_FROM}
     WHERE ${[...PROJECT_BASE_CONDS(), `u.city = $2`, `btrim(u.project_name) <> $3`].join(' AND ')}
     ${PROJECT_GROUP}
     ORDER BY MIN(u.possession_date) ASC NULLS LAST
     LIMIT 4`,
    [await publicPropertyStatuses(), project.city, project.name],
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
  // `= ANY($1)`, not `= $1`. The setting is a *list* of statuses — an admin can
  // publish Available and Held together — and comparing a text column to an
  // array with `=` matches nothing at all. No error, no warning: the catalogue
  // just answers zero every time, which reads exactly like having no stock.
  // Every other query in this file already had the ANY; this one did not.
  const conds: string[] = [`u.status = ANY($1)`, publishClause('u')];
  const params: unknown[] = [await publicPropertyStatuses()];

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
      `SELECT ${await propertyFields()}
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
    `SELECT ${await propertyFields()}
     FROM ipy_e_properties u
     WHERE u.record_id = $1 AND u.status = ANY($2) AND ${publishClause('u')}`,
    [req.params.id, await publicPropertyStatuses()],
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
// Filters and city summaries — what the website's search UI is built from.
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
    `SELECT u.city,
            COUNT(DISTINCT btrim(u.project_name))::int AS project_count,
            COUNT(*)::int AS unit_count,
            MIN(u.total_price) AS price_min,
            MAX(u.total_price) AS price_max
     FROM ipy_e_properties u
     WHERE u.status = $1 AND ${publishClause('u')} AND u.city IS NOT NULL
     GROUP BY u.city
     ORDER BY project_count DESC`,
    [await publicPropertyStatuses()],
  );
  res.json({ items: rows.rows });
}));

// ---------------------------------------------------------------------------
// Media — the CRM's own /api/files/:id requires auth. Gallery/floor-plan
// fields on projects/properties store URLs of that same shape
// (`/api/files/<attachment-id>`), so this serves the same bytes without
// auth, but only for an attachment whose owning record currently passes the
// public-visibility filter above — an id alone isn't enough to fetch it.
// ?size=thumb|medium|large serves the resized derivative
// (core/media/pipeline.ts) when one exists, falling back to the untouched
// original otherwise — this is the whole reason the website is fast: it
// never downloads a multi-MB original just to show a listing thumbnail.
// ---------------------------------------------------------------------------

const VARIANT_SIZES = new Set(['thumb', 'medium', 'large']);

// Widths used when shrinking an original that has no derivative yet — see
// the share media route. Matches core/media/images.ts so a photo looks the
// same before and after the queue catches up with it.
const FALLBACK_WIDTHS: Record<string, number> = { thumb: 480, medium: 1200, large: 2400 };

publicRouter.get('/media/:attachmentId', asyncHandler(async (req, res) => {
  const file = await db.queryOne<{ storage_key: string; file_name: string; mime_type: string; record_id: string | null; variants: Record<string, string> | null }>(
    `SELECT storage_key, file_name, mime_type, record_id, variants FROM ipy_attachment WHERE id = $1`,
    [req.params.attachmentId],
  );
  if (!file?.record_id) throw new NotFoundError('File not found');

  const visible = await db.queryOne(
    `SELECT 1 FROM ipy_e_properties WHERE record_id = $1 AND status = ANY($2) AND ${publishClause('ipy_e_properties')}`,
    [file.record_id, await publicPropertyStatuses()],
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

// ---------------------------------------------------------------------------
// Share links — one property, sent to one person.
//
// Separate from everything above, and deliberately not subject to the
// status/publish gate. That gate is right for a catalogue: the website should
// only list units that are actually available and meant to be public. It is
// wrong for sending, because the property somebody most wants to send is the
// floor they photographed this morning, which is a draft.
//
// What authorises this instead is the token: minted by a signed-in user who had
// permission to see the record, unguessable, revocable, and scoped to exactly
// one property. See core/sharing/shareLinks.ts.
// ---------------------------------------------------------------------------

/** Everything the shared page renders. 404 covers every failure — see resolveShareToken. */
publicRouter.get('/share/:token', asyncHandler(async (req, res) => {
  const link = await resolveShareToken(req.params.token);
  if (!link) throw new NotFoundError('This link is no longer available');

  const shared = await loadSharedProperty(link.recordId);
  if (!shared) throw new NotFoundError('This link is no longer available');

  // The record's own photos, not the `gallery` field. Gallery is curated by
  // hand and is empty on a property that arrived through capture — which is
  // every property this feature exists for. Ordered by the arrangement
  // somebody made, falling back to when they were shot, so the buyer walks the
  // floor in the order it was walked.
  //
  // This used to lead with `ai_category`, which grouped the set by room type
  // and meant the first thing a buyer saw was whatever the model happened to
  // sort first. A cover photo is a decision, so it now outranks a guess — see
  // core/media/ordering.ts.
  const photos = shared.showPhotos
    ? (await db.query<{ id: string; file_name: string }>(
      `SELECT id, file_name
         FROM ipy_attachment
        WHERE record_id = $1
          AND mime_type LIKE 'image/%'
        ORDER BY ${photoOrderBy('')}, ai_category NULLS LAST, created_at
        LIMIT 60`,
      [link.recordId],
    )).rows
    : [];

  // Counted after the payload is built and never awaited into the response: a
  // failed counter must not stop a buyer seeing the property.
  void recordShareView(link.id).catch((err) => logger.debug({ err }, 'share: view count failed'));

  res.json({
    property: shared.property,
    fields: shared.fields,
    photos: photos.map((p) => ({
      id: p.id,
      url: `/api/public/share/${link.token}/media/${p.id}`,
    })),
    sharedAt: link.createdAt,
  });
}));

/**
 * An image from a shared property.
 *
 * Authorised by the token in the path and checked against the attachment's own
 * record, so a valid link for one property cannot be used to pull an image
 * belonging to another by swapping the id.
 */
publicRouter.get('/share/:token/media/:attachmentId', asyncHandler(async (req, res) => {
  const link = await resolveShareToken(req.params.token);
  if (!link) throw new NotFoundError('File not found');
  const shareConfig = await getPropertyShareConfig();
  if (!shareConfig.showPhotos) throw new NotFoundError('File not found');

  const file = await db.queryOne<{
    storage_key: string; mime_type: string; variants: Record<string, string> | null;
  }>(
    `SELECT storage_key, mime_type, variants
       FROM ipy_attachment
      WHERE id = $1 AND record_id = $2 AND mime_type LIKE 'image/%'`,
    [req.params.attachmentId, link.recordId],
  );
  if (!file) throw new NotFoundError('File not found');

  const requestedSize = typeof req.query.size === 'string' ? req.query.size : null;
  const variantKey = requestedSize && VARIANT_SIZES.has(requestedSize) ? file.variants?.[requestedSize] : undefined;
  const storageKey = variantKey ?? file.storage_key;

  const driver = await getDriver();
  const data = await driver.read(storageKey);
  if (!data) throw new NotFoundError('File is missing from storage');

  // Private, never public: a link is not secret enough to sit in a shared CDN
  // cache, and revoking one has to actually take effect.
  res.setHeader('Cache-Control', 'private, no-store');

  if (variantKey) {
    res.setHeader('Content-Type', 'image/webp');
    res.send(data);
    return;
  }

  // No derivative yet, so this is the untouched original — and on this route
  // that is the normal case rather than the rare one. The media queue makes
  // variants a minute or two after upload; a share link is made for the floor
  // somebody photographed this morning, so a buyer can easily open it first.
  //
  // Serving the original there means several megabytes per photo to a phone on
  // mobile data, which is the difference between a link that loads and one that
  // gets closed. Shrinking on the fly costs about a tenth of a second and the
  // route is rate-limited, so the trade is worth making. The originals on disk
  // are untouched — this is a resize on the way out, not a derivative.
  try {
    res.setHeader('Content-Type', 'image/webp');
    res.send(await sharp(data, { failOn: 'none' })
      .rotate()
      .resize({ width: FALLBACK_WIDTHS[requestedSize ?? 'large'] ?? 1600, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer());
  } catch (err) {
    // A format sharp cannot decode still deserves to be shown.
    logger.debug({ err, id: req.params.attachmentId }, 'shared media: could not shrink, sending the original');
    res.setHeader('Content-Type', file.mime_type);
    res.send(data);
  }
}));

// ---------------------------------------------------------------------------
// The Android companion app
// ---------------------------------------------------------------------------

/**
 * Where the published APK and its details live inside the image.
 *
 * Written by `companion-android/scripts/publish-apk.sh` and committed, because
 * the container has no Android SDK and Render has no artefact store. Three and
 * a half megabytes in git is the price of the CRM being able to hand a rep the
 * app without a second service, a login, or a monthly bill.
 */
//
// Anchored to this file rather than to `process.cwd()`. The container starts
// the server from the repository root and a developer starts it from
// `packages/server`, so a working-directory path is right in one of those and
// silently wrong in the other, which shows up as "no build published" with
// nothing in the logs. This file sits three levels below the package root in
// both `src` and `dist`.
const COMPANION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/companion');
const COMPANION_APK = resolve(COMPANION_DIR, 'ipropy-companion.apk');

interface CompanionBuild {
  versionName: string;
  versionCode: number;
  minSdk: number;
  sizeBytes: number;
  sha256: string;
  builtAt: string;
}

/**
 * What build is on offer, so the download page can say so.
 *
 * Read from disk each time rather than cached: the file changes once every few
 * months, a read of two hundred bytes costs nothing, and a cache here would
 * mean a freshly deployed APK advertised itself as the old one until somebody
 * restarted the server.
 */
async function publishedBuild(): Promise<CompanionBuild | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(resolve(COMPANION_DIR, 'companion.json'), 'utf8')) as CompanionBuild;
  } catch {
    return null;
  }
}

publicRouter.get('/companion', asyncHandler(async (_req, res) => {
  const build = await publishedBuild();
  res.json({
    available: build !== null,
    build,
    // Where to send the phone. A setting wins if one is set, so moving the file
    // to object storage later is a settings change rather than a deploy.
    url: (await companionOverrideUrl()) ?? '/api/public/companion/download',
  });
}));

/**
 * Hand over the APK.
 *
 * **Unauthenticated on purpose.** A rep installs this before the phone has ever
 * signed into the CRM, often by opening a link someone sent them, and an APK
 * that needs a bearer token cannot be fetched by a browser following a plain
 * link. Nothing is given away by that: the app ships with no server address and
 * no credentials, and does nothing at all until somebody pastes a pairing token
 * into it. The button that leads here still sits behind a login.
 */
publicRouter.get('/companion/download', asyncHandler(async (req, res) => {
  const override = await companionOverrideUrl();
  if (override) {
    res.redirect(302, override);
    return;
  }

  const build = await publishedBuild();
  if (!build) throw new NotFoundError('No companion build has been published yet');

  // Version in the filename, so a rep with two downloads in their folder can
  // tell which is which, and so a phone does not silently reuse a cached copy.
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="ipropy-companion-${build.versionName}.apk"`);
  // Long cache, but keyed to this exact build: the URL is stable, so the ETag
  // is what tells a phone the file changed.
  res.setHeader('ETag', `"${build.sha256}"`);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(COMPANION_APK, (err) => {
    if (err) {
      logger.warn({ err }, 'companion apk stream failed');
      if (!res.headersSent) res.status(404).json({ error: 'not_found' });
    }
  });
}));

/**
 * An address to send the phone to instead of this server.
 *
 * Empty by default. It exists so that the day the APK outgrows living in the
 * image, or the day he wants it on a CDN, nothing in the app or the CRM has to
 * change: he pastes a URL into Admin → Settings and every download follows it.
 */
async function companionOverrideUrl(): Promise<string | null> {
  const row = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'companion.apk_url'`,
  );
  const raw = typeof row?.value === 'string' ? row.value : null;
  const trimmed = raw?.trim();
  return trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : null;
}
