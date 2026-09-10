/**
 * Public, unauthenticated read API for the customer-facing property website
 * (a separate app — see the sibling `ipropy-website` checkout).
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
import { dirname, resolve, sep } from 'node:path';
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
import { applyFileSecurityHeaders } from '../../core/media/serving.js';
import { publicPropertyStatuses } from '../../core/settings/scoring.js';

export const publicRouter = Router();

// Which statuses reach the public is a setting now — see migration 059. It is
// the most customer-visible decision in this file: it chooses what every
// visitor to the website sees, and "show Booked units too, a half-sold tower
// sells the other half" is a sales decision rather than a code change.
// Read per request; the reader caches and is invalidated when settings save.

/*
  A property reaches the website only when somebody says so.

  This used to read `IS NULL OR = 'true'`, so a property with the flag unset was
  published — and the flag is unset on every newly created record until somebody
  saves that field. The practical effect: a half-entered unit went live the
  moment it was created, before it had photos, a price or a verified address.
  Both properties on the public site today have no price for exactly this
  reason.

  Absent now means hidden. Migration `087` writes an explicit `true` onto
  everything that was relying on the old default first, so nothing that is
  live today disappears when this ships.

  **A deleted property is hidden too, and that check was missing entirely.** Not
  one of the ten public queries excluded deleted records, so a rep deleting a
  sold unit removed it from the CRM and left it advertised to buyers — the
  catalogue, the detail page, the project pages and the city counts all kept
  serving it. There is no purge, so it stayed there forever.

  The check lives here rather than in each query because this clause is the one
  thing every public property read already goes through. `is_deleted` is on
  `ipy_record` and none of these queries join it, so an EXISTS on the primary
  key is what keeps the fix to a single line instead of restructuring ten
  statements.
*/
const publishClause = (alias: string) => `(
  ${alias}.custom_fields->>'publish_to_web' = 'true'
  AND EXISTS (SELECT 1 FROM ipy_record dr WHERE dr.id = ${alias}.record_id AND dr.is_deleted = false)
)`;

/*
  Never build ORDER BY from raw query input — a fixed whitelist keeps it
  injection-safe — and never name a column the model may have lost.

  Each option says which columns it needs. `total_price` and `possession_date`
  have both gone from production, and `price_asc` is the *default* sort for the
  public property list, so every request to the public catalogue answered
  `unknown_field`: the website showed no properties at all, which reads as
  having no stock rather than as a field that moved. The SELECT list was
  already guarded this way; the ORDER BY was not.
*/
interface SortOption { sql: string; needs: string[] }

const PROJECT_SORTS: Record<string, SortOption> = {
  possession: { sql: 'MIN(u.possession_date) ASC NULLS LAST', needs: ['possession_date'] },
  price_asc: { sql: 'MIN(u.total_price) ASC NULLS LAST', needs: ['total_price'] },
  price_desc: { sql: 'MAX(u.total_price) DESC NULLS LAST', needs: ['total_price'] },
  // `created_at` lives on ipy_record, not on the payload table, so this one
  // needs the join to be there. Declared rather than assumed, because it is a
  // fallback and a fallback that raises is worse than no fallback at all.
  newest: { sql: 'MAX(u.created_at) DESC NULLS LAST', needs: ['created_at'] },
};
const PROPERTY_SORTS: Record<string, SortOption> = {
  price_asc: { sql: 'u.total_price ASC NULLS LAST', needs: ['total_price'] },
  price_desc: { sql: 'u.total_price DESC NULLS LAST', needs: ['total_price'] },
  area_desc: { sql: 'u.carpet_area DESC NULLS LAST', needs: ['carpet_area'] },
  possession: { sql: 'u.possession_date ASC NULLS LAST', needs: ['possession_date'] },
};

/**
 * The requested sort if the model can still do it, then the first that it can,
 * and `record_id` as the answer that always works. A catalogue in an arbitrary
 * but stable order is a working catalogue; a 400 is not.
 */
async function resolveSort(
  options: Record<string, SortOption>,
  requested: string,
  /* The order that always works. Grouped queries need an aggregate. */
  lastResort = 'u.record_id',
): Promise<string> {
  const present = await propertyColumns();
  const usable = (o: SortOption | undefined): boolean => Boolean(o) && o!.needs.every((c) => present.has(c));
  if (usable(options[requested])) return options[requested]!.sql;
  const fallback = Object.values(options).find(usable);
  return fallback?.sql ?? lastResort;
}

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
/**
 * A "project" here is derived by grouping units, so every output alias has to
 * exist whether or not the column behind it does. A missing column therefore
 * becomes a typed NULL rather than a dropped key: the shape the website parses
 * stays the same and one deleted field cannot empty the whole catalogue.
 *
 * The properties list learned this the hard way — see PROPERTY_FIELD_LIST.
 */
const PROJECT_FIELD_LIST: { sql: string; needs: string[]; missing: string }[] = [
  { sql: `lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g')) AS id`, needs: ['project_name'], missing: `NULL::text AS id` },
  { sql: `MIN(u.project_name) AS name`, needs: ['project_name'], missing: `NULL::text AS name` },
  { sql: `MIN(u.possession_status) AS status`, needs: ['possession_status'], missing: `NULL::text AS status` },
  { sql: `MIN(u.property_type) AS project_type`, needs: ['property_type'], missing: `NULL::text AS project_type` },
  { sql: `MIN(u.city) AS city`, needs: ['city'], missing: `NULL::text AS city` },
  { sql: `MIN(u.locality) AS locality`, needs: ['locality'], missing: `NULL::text AS locality` },
  { sql: `NULL::text AS micro_market`, needs: [], missing: `NULL::text AS micro_market` },
  { sql: `NULL::text AS state`, needs: [], missing: `NULL::text AS state` },
  { sql: `NULL::jsonb AS address`, needs: [], missing: `NULL::jsonb AS address` },
  { sql: `AVG(u.latitude) AS latitude`, needs: ['latitude'], missing: `NULL::numeric AS latitude` },
  { sql: `AVG(u.longitude) AS longitude`, needs: ['longitude'], missing: `NULL::numeric AS longitude` },
  { sql: `NULL::text AS rera_number`, needs: [], missing: `NULL::text AS rera_number` },
  { sql: `NULL::date AS rera_expiry`, needs: [], missing: `NULL::date AS rera_expiry` },
  { sql: `NULL::numeric AS total_land_area`, needs: [], missing: `NULL::numeric AS total_land_area` },
  { sql: `NULL::text AS land_area_unit`, needs: [], missing: `NULL::text AS land_area_unit` },
  { sql: `COUNT(DISTINCT u.tower)::int AS total_towers`, needs: ['tower'], missing: `0 AS total_towers` },
  { sql: `MAX(u.floor)::int AS total_floors`, needs: ['floor'], missing: `NULL::int AS total_floors` },
  { sql: `COUNT(*)::int AS total_units`, needs: [], missing: `COUNT(*)::int AS total_units` },
  { sql: `COUNT(*)::int AS available_units`, needs: [], missing: `COUNT(*)::int AS available_units` },
  { sql: `0 AS booked_units`, needs: [], missing: `0 AS booked_units` },
  { sql: `NULL::numeric AS open_area_percent`, needs: [], missing: `NULL::numeric AS open_area_percent` },
  { sql: `MIN(u.total_price) AS price_min`, needs: ['total_price'], missing: `NULL::numeric AS price_min` },
  { sql: `MAX(u.total_price) AS price_max`, needs: ['total_price'], missing: `NULL::numeric AS price_max` },
  { sql: `AVG(u.rate_per_sqft) AS rate_per_sqft`, needs: ['rate_per_sqft'], missing: `NULL::numeric AS rate_per_sqft` },
  {
    sql: `COALESCE(jsonb_agg(DISTINCT u.bedrooms) FILTER (WHERE u.bedrooms IS NOT NULL), '[]'::jsonb) AS configurations`,
    needs: ['bedrooms'],
    missing: `'[]'::jsonb AS configurations`,
  },
  { sql: `NULL::date AS launch_date`, needs: [], missing: `NULL::date AS launch_date` },
  { sql: `MIN(u.possession_date) AS possession_date`, needs: ['possession_date'], missing: `NULL::date AS possession_date` },
  { sql: `NULL::numeric AS completion_percent`, needs: [], missing: `NULL::numeric AS completion_percent` },
  {
    sql: `COALESCE(jsonb_agg(DISTINCT a.amenity) FILTER (WHERE a.amenity IS NOT NULL), '[]'::jsonb) AS amenities`,
    needs: ['amenities'],
    missing: `'[]'::jsonb AS amenities`,
  },
  { sql: `'[]'::jsonb AS usps`, needs: [], missing: `'[]'::jsonb AS usps` },
  { sql: `NULL::text AS brochure_url`, needs: [], missing: `NULL::text AS brochure_url` },
  { sql: `MIN(u.video_url) AS video_url`, needs: ['video_url'], missing: `NULL::text AS video_url` },
  { sql: `MIN(u.virtual_tour_url) AS virtual_tour_url`, needs: ['virtual_tour_url'], missing: `NULL::text AS virtual_tour_url` },
  { sql: `NULL::text AS master_plan_url`, needs: [], missing: `NULL::text AS master_plan_url` },
  {
    sql: `COALESCE(jsonb_agg(DISTINCT g.image) FILTER (WHERE g.image IS NOT NULL), '[]'::jsonb) AS gallery`,
    needs: ['gallery'],
    missing: `'[]'::jsonb AS gallery`,
  },
  { sql: `'[]'::jsonb AS floor_plans`, needs: [], missing: `'[]'::jsonb AS floor_plans` },
  { sql: `'[]'::jsonb AS connectivity`, needs: [], missing: `'[]'::jsonb AS connectivity` },
  { sql: `MIN(u.description) AS description`, needs: ['description'], missing: `NULL::text AS description` },
];

/**
 * Units feeding a derived project. `amenities` and `gallery` are JSONB arrays,
 * so they are unnested to be aggregated distinctly across the development.
 */
async function projectFrom(): Promise<string> {
  const present = await propertyColumns();
  const lateral = (col: string, alias: string, out: string) =>
    present.has(col)
      ? `LEFT JOIN LATERAL jsonb_array_elements_text(COALESCE(u.${col}, '[]'::jsonb)) AS ${alias}(${out}) ON true`
      : `LEFT JOIN LATERAL (SELECT NULL::text AS ${out}) AS ${alias} ON true`;
  return `
  FROM ipy_e_properties u
  ${lateral('amenities', 'a', 'amenity')}
  ${lateral('gallery', 'g', 'image')}
`;
}

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
  {
    /*
      The gallery is the photographs on the record, in the order somebody put
      them in — not the `gallery` column beside them.
      
      Those were two lists of the same thing, and only one of them was ever
      filled. n8n uploads the finished copies as attachments, the CRM's own
      record page reads attachments (ordered by sort_order, migration 052), and
      nothing in the codebase has ever written `u.gallery`. So a property could
      be photographed, processed and published, show its photos perfectly inside
      the CRM, and appear on the website with no pictures at all.

      Reading the attachments makes the ordering the team sets in the CRM the
      ordering a buyer sees, which is what the cover-photo drag was for.
    */
    sql: `COALESCE((
            SELECT jsonb_agg('/api/files/' || a.id ORDER BY a.sort_order NULLS LAST, a.created_at)
              FROM ipy_attachment a
             WHERE a.record_id = u.record_id
               AND a.mime_type LIKE 'image/%'
          ), '[]'::jsonb) AS gallery`,
    needs: ['record_id'],
  },
  ...[
    'project_name',
    'status', 'property_type',
    'tower', 'wing', 'floor', 'facing', 'view_description', 'corner_unit', 'vastu_compliant',
    'carpet_area', 'built_up_area', 'super_built_up_area', 'plot_area', 'balcony_area',
    'terrace_area', 'area_unit',
    'bedrooms', 'bathrooms', 'balconies', 'parking_slots', 'furnishing',
    'base_price', 'rate_per_sqft', 'floor_rise_charge', 'plc_charge', 'parking_charge',
    'club_membership', 'maintenance_deposit', 'other_charges', 'gst_percent', 'total_price',
    'possession_status', 'possession_date', 'is_resale',
    'floor_plan_url', 'video_url', 'virtual_tour_url', 'amenities',
    'city', 'locality', 'latitude', 'longitude', 'description',
  ].map((c) => ({ sql: `u.${c}`, needs: [c] })),
];

let propertyFieldsCache: string | null = null;
let projectFieldsCache: string | null = null;
let columnsCache: Set<string> | null = null;

/** Forget which columns exist. Called whenever an admin changes the model. */
export function invalidatePublicFields(): void {
  propertyFieldsCache = null;
  projectFieldsCache = null;
  columnsCache = null;
}

/** Which columns `ipy_e_properties` actually has right now. */
async function propertyColumns(): Promise<Set<string>> {
  if (columnsCache) return columnsCache;
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'ipy_e_properties'`,
  );
  columnsCache = new Set(rows.map((r) => r.column_name));
  return columnsCache;
}

async function propertyFields(): Promise<string> {
  if (propertyFieldsCache) return propertyFieldsCache;
  const present = await propertyColumns();
  const kept = PROPERTY_FIELD_LIST.filter((f) => f.needs.every((c) => present.has(c)));
  const dropped = PROPERTY_FIELD_LIST.length - kept.length;
  if (dropped > 0) {
    logger.info({ dropped }, 'public property fields: some have been removed from the model');
  }
  propertyFieldsCache = kept.map((f) => f.sql).join(', ');
  return propertyFieldsCache;
}

/**
 * Whether the model still has the columns a route is built on.
 *
 * Some routes do not merely *read* a field, they are defined by it. "Projects"
 * on the public site are not records at all: they are units grouped by
 * `project_name`. Delete that field and there is no such thing as a project,
 * which is a true and reportable state — an empty list. What it must not do is
 * throw `unknown_field`, because a 400 reads as a broken site rather than as an
 * empty shelf, and that is exactly what production was doing.
 */
async function modelHas(...columns: string[]): Promise<boolean> {
  const present = await propertyColumns();
  return columns.every((c) => present.has(c));
}

async function projectFields(): Promise<string> {
  if (projectFieldsCache) return projectFieldsCache;
  const present = await propertyColumns();
  const gone = PROJECT_FIELD_LIST.filter((f) => !f.needs.every((c) => present.has(c)));
  if (gone.length > 0) {
    logger.info({ count: gone.length }, 'public project fields: some columns have been removed from the model');
  }
  projectFieldsCache = PROJECT_FIELD_LIST
    .map((f) => (f.needs.every((c) => present.has(c)) ? f.sql : f.missing))
    .join(', ');
  return projectFieldsCache;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

publicRouter.get('/projects', asyncHandler(async (req, res) => {
  // No project_name field means there are no projects to derive. An empty
  // catalogue, not an error.
  if (!await modelHas('project_name')) { res.json({ items: [], total: 0 }); return; }
  const conds = PROJECT_BASE_CONDS();
  const params: unknown[] = [await publicPropertyStatuses()];

  const push = (sql: string, value: unknown) => { params.push(value); conds.push(sql.replace('?', `$${params.length}`)); };

  // A filter on a field that no longer exists is skipped, not fatal. Narrowing
  // by something the model has dropped should return everything, not nothing.
  if (req.query.city && (await modelHas('city'))) push(`u.city = ?`, String(req.query.city));
  if (req.query.locality && (await modelHas('locality'))) push(`u.locality = ?`, String(req.query.locality));
  if (req.query.configuration && (await modelHas('configuration'))) push(`u.configuration = ?`, String(req.query.configuration));
  if (req.query.minPrice && (await modelHas('total_price'))) push(`u.total_price >= ?`, Number(req.query.minPrice));
  if (req.query.maxPrice && (await modelHas('total_price'))) push(`u.total_price <= ?`, Number(req.query.maxPrice));
  if (req.query.possessionBy && (await modelHas('possession_date'))) push(`u.possession_date <= ?`, String(req.query.possessionBy));

  const limit = Math.min(48, Number(req.query.limit) || 24);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  params.push(limit, offset);

  const sort = await resolveSort(PROJECT_SORTS, String(req.query.sort), 'MIN(u.record_id::text)');

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT ${await projectFields()}
       ${await projectFrom()}
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
  if (!await modelHas('project_name')) throw new NotFoundError('Project not found');
  const slug = `lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g')) = $2`;

  const project = await db.queryOne<{ name: string; city: string | null }>(
    `SELECT ${await projectFields()}
     ${await projectFrom()}
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

  // "Nearby projects" means "in the same city", so without a city field there
  // is no nearby — but there is still a project page. Narrowing is dropped
  // rather than the query being allowed to name a column that is gone, which
  // would answer 400 for the whole page over a sidebar.
  const byCity = await modelHas('city');
  const similarConds = [...PROJECT_BASE_CONDS()];
  const similarParams: unknown[] = [await publicPropertyStatuses()];
  if (byCity) {
    similarParams.push(project.city);
    similarConds.push(`u.city = $${similarParams.length}`);
  }
  similarParams.push(project.name);
  similarConds.push(`btrim(u.project_name) <> $${similarParams.length}`);

  const similar = await db.query(
    `SELECT ${await projectFields()}
     ${await projectFrom()}
     WHERE ${similarConds.join(' AND ')}
     ${PROJECT_GROUP}
     ORDER BY MIN(u.possession_date) ASC NULLS LAST
     LIMIT 4`,
    similarParams,
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

  if (req.query.project && (await modelHas('project_name'))) push(`lower(regexp_replace(btrim(u.project_name), '[^a-zA-Z0-9]+', '-', 'g')) = ?`, String(req.query.project));
  // A filter on a field that no longer exists is skipped, not fatal. Narrowing
  // by something the model has dropped should return everything, not nothing.
  if (req.query.city && (await modelHas('city'))) push(`u.city = ?`, String(req.query.city));
  // Same rule as the two filters above: narrowing by something the model has
  // dropped returns everything rather than failing the request.
  if (req.query.configuration && (await modelHas('configuration'))) push(`u.configuration = ?`, String(req.query.configuration));
  if (req.query.bedrooms && (await modelHas('bedrooms'))) push(`u.bedrooms = ?`, Number(req.query.bedrooms));
  if (req.query.minPrice && (await modelHas('total_price'))) push(`u.total_price >= ?`, Number(req.query.minPrice));
  if (req.query.maxPrice && (await modelHas('total_price'))) push(`u.total_price <= ?`, Number(req.query.maxPrice));

  const limit = Math.min(48, Number(req.query.limit) || 24);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  params.push(limit, offset);

  const sort = await resolveSort(PROPERTY_SORTS, String(req.query.sort));

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
/**
 * What the browser needs to know before anybody signs in.
 *
 * Only the Sentry DSN today, and it is deliberately unauthenticated: the app
 * has to start reporting errors *before* a login succeeds, since a broken login
 * is exactly the failure worth hearing about and the one nobody can report from
 * inside.
 *
 * Public is also correct rather than merely convenient. A DSN can only write
 * events; it reads nothing and administers nothing, and every website using
 * Sentry ships one in its JavaScript for the same reason. Nothing else is added
 * to this response without checking it belongs in a stranger's hands.
 */
publicRouter.get('/client-config', asyncHandler(async (_req, res) => {
  const { getSettings } = await import('../../core/settings/integrations.js');
  const { config } = await import('../../config.js');
  const sentry = getSettings().sentry;

  // Cached briefly: every page load asks, and the answer changes twice a year.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    sentryDsn: sentry.dsn || null,
    environment: sentry.environment || (config.isProd ? 'production' : 'development'),
  });
}));

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
     WHERE pl.name IN ('city', 'locality', 'amenities') AND plv.is_active
     ORDER BY plv.sequence`,
  );
  const grouped: Record<string, { value: string; label: string }[]> = { city: [], locality: [], amenities: [] };
  for (const r of rows.rows) grouped[r.name]?.push({ value: r.value, label: r.label });
  res.json(grouped);
}));

// City summaries for the website's /cities landing pages — one aggregate
// query rather than the site looping a `city=` filter per picklist value.
publicRouter.get('/cities', asyncHandler(async (_req, res) => {
  if (!await modelHas('city', 'project_name')) { res.json({ items: [] }); return; }
  const rows = await db.query<{ city: string; project_count: number; unit_count: number; price_min: number | null; price_max: number | null }>(
    `SELECT u.city,
            COUNT(DISTINCT btrim(u.project_name))::int AS project_count,
            COUNT(*)::int AS unit_count,
            MIN(u.total_price) AS price_min,
            MAX(u.total_price) AS price_max
     FROM ipy_e_properties u
     -- ANY, not =. The parameter is the list of statuses an admin has made
     -- public, and node-postgres sends a JS array as the literal '{Available}'.
     -- Comparing status to that literal is a valid string comparison that
     -- matches nothing, so this answered with an empty list and no error, and
     -- "Where we work" has never appeared on the website. Third instance of
     -- this exact slip in this file; the other two are fixed above.
     WHERE u.status = ANY($1) AND ${publishClause('u')} AND u.city IS NOT NULL
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

  /*
    The same headers the signed-in file route has carried all along, which this
    one did not.

    A stored mime type is whatever the uploading client declared — never
    derived, never sniffed. So anyone who can attach a file to a property that
    later gets published could serve `image/svg+xml` from the CRM's own origin,
    and an SVG opened as a top-level document runs its scripts. The session
    token lives in localStorage and the API deliberately runs without a CSP of
    its own, so that is the whole session.

    `applyFileSecurityHeaders` is the existing answer: `sandbox` drops the
    response into an opaque origin with scripts off, `nosniff` stops a browser
    second-guessing the type, and the disposition allow-list downloads anything
    that is not genuinely embeddable. None of it costs a real photograph
    anything — a CSP on an image subresource does not affect `<img>`.
  */
  const storage = getStorageSettings();
  if (storage.driver === 'local') {
    const path = resolve(storage.localPath, storageKey);
    // A prefix test alone treats `/uploads-evil` as inside `/uploads`, so the
    // boundary has to be the separator, not the string.
    const root = resolve(storage.localPath);
    if (path !== root && !path.startsWith(root + sep)) throw new NotFoundError('File not found');
    applyFileSecurityHeaders(res, mimeType, file.file_name, false);
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
  applyFileSecurityHeaders(res, mimeType, file.file_name, false);
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
    applyFileSecurityHeaders(res, 'image/webp', 'photo.webp', false);
    res.setHeader('Cache-Control', 'private, no-store');
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
    applyFileSecurityHeaders(res, 'image/webp', 'photo.webp', false);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await sharp(data, { failOn: 'none' })
      .rotate()
      .resize({ width: FALLBACK_WIDTHS[requestedSize ?? 'large'] ?? 1600, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer());
  } catch (err) {
    /*
      A format sharp cannot decode still deserves to be shown — but this branch
      is exactly where a hostile file lands. The happy path above rasterises
      everything to webp, which quietly defuses an SVG; a deliberately malformed
      one fails to decode and arrives here, where it used to be echoed back with
      its own declared mime type. So the guard matters more here than anywhere.
    */
    logger.debug({ err, id: req.params.attachmentId }, 'shared media: could not shrink, sending the original');
    applyFileSecurityHeaders(res, file.mime_type, 'photo', false);
    res.setHeader('Cache-Control', 'private, no-store');
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
