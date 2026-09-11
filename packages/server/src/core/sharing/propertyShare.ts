/**
 * Public property-share presentation, kept deliberately separate from the
 * public website catalogue.
 *
 * A share token is an unauthenticated door, so the database never returns an
 * entire property row here. Administrators choose from a guarded set of
 * customer-safe fields and this module builds an explicit SELECT from that
 * choice. A newly-added CRM field is private until an admin turns it on.
 */
import type { FieldMeta } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { buildLabel } from '../entity/recordService.js';
import { priceField } from '../settings/priceField.js';
import { registry } from '../metadata/registry.js';
import { fieldExpr, quoteIdent } from '../query/builder.js';

export const PROPERTY_SHARE_SETTING = 'sharing.property_link';

export interface PropertyShareConfig {
  visibleFields: string[];
  showPhotos: boolean;
}

export interface PropertyShareField {
  name: string;
  label: string;
  uitype: FieldMeta['uitype'];
  visible: boolean;
}

export interface SharedPropertyPayload {
  property: Record<string, unknown>;
  fields: Omit<PropertyShareField, 'visible'>[];
  showPhotos: boolean;
  /**
   * Resolved here rather than in the browser, because the page used to read
   * `total_price` and `project_name` by name and production has permanently
   * deleted both. A buyer's link then showed no price at all — not even
   * "Price on request", since the element is only rendered when the number is
   * present — and a title of "Property".
   *
   * `price` is null when the property has no price *or* the admin has not
   * shared the price field; the two are deliberately indistinguishable to the
   * browser, so an unshared price cannot leak through this route.
   */
  title: string | null;
  price: number | null;
  priceShared: boolean;
}

/**
 * Privacy-first defaults. Exact identity and location are deliberately absent:
 * Unit Name, Project, Tower, Wing, Unit Number, City and Locality all remain
 * available to an admin, but a fresh installation does not expose them.
 *
 * Stated as what to *withhold*, not what to show. The list used to name the
 * twenty-six fields to share, and production has since deleted twenty-one of
 * them — so the default share had no price and no size on it, while the
 * replacements an admin created (`asking_price`, `area_size`) were never
 * considered because nothing had added them to the list. A deny-list cannot
 * rot that way: a field created tomorrow is shared unless it is somebody's
 * identity or exact address, which is the promise this was making all along.
 */
const WITHHELD_BY_DEFAULT = new Set([
  // Who and exactly where — the two things a rep sells on knowing.
  'name', 'full_name', 'project_name', 'unit_name',
  'city', 'locality', 'preferred_locations', 'address',
  'tower', 'block_tower', 'wing', 'unit_number', 'unit_no',
  // How the sale is going. Shareable if an admin ticks it, but a buyer opening
  // a link should not read why the last one walked away or when the rep plans
  // to chase them. `SENSITIVE_NAME` already covers owner/contact/broker/
  // commission/internal/private; these are the pipeline ones it does not.
  'lost_reason', 'next_follow_up', 'next_followup_at',
  'property_source', 'lead_source', 'source', 'rating', 'priority',
]);

export function defaultShareFields(available: Iterable<string>): string[] {
  return [...available].filter((name) => !WITHHELD_BY_DEFAULT.has(name));
}

const SUPPORTED_TYPES = new Set<FieldMeta['uitype']>([
  'string', 'textarea', 'richtext', 'url',
  'integer', 'decimal', 'currency', 'percent', 'area',
  'picklist', 'radio', 'multipicklist', 'boolean',
  'date', 'datetime', 'time', 'formula',
]);

/** Fields whose business meaning is internal even if an admin later relabels them. */
const NEVER_SHARE = new Set([
  // `mobile` is the seller's number and reads as the property's identity here.
  // `SENSITIVE_NAME` catches `phone` and `email` and does not catch this one,
  // so it has to be named: a buyer who has it does not need the agent.
  'mobile',
  'property_code', 'status', 'owner_id',
  'blocked_until', 'blocked_by', 'blocked_for_lead_id', 'owner_contact_id',
  'latitude', 'longitude', 'gallery', 'floor_plan_url', 'video_url', 'virtual_tour_url',
  'publish_to_web',
]);

const SENSITIVE_NAME = /(^ai_|commission|broker|internal|private|owner|contact|phone|email|aadhaar|passport|password|secret|token)/i;

function isShareable(field: FieldMeta): boolean {
  return field.isActive
    && field.displayType !== 'hidden'
    && field.config.__record !== true
    && SUPPORTED_TYPES.has(field.uitype)
    && !NEVER_SHARE.has(field.name)
    && !SENSITIVE_NAME.test(field.name);
}

async function shareableFields(): Promise<FieldMeta[]> {
  const module = await registry.requireModule('properties');
  return module.fields.filter(isShareable).sort((a, b) => a.sequence - b.sequence);
}

function normaliseConfig(value: unknown, available: Set<string>): PropertyShareConfig {
  const input = value && typeof value === 'object' ? value as Partial<PropertyShareConfig> : {};
  const requested = Array.isArray(input.visibleFields)
    ? input.visibleFields.filter((name): name is string => typeof name === 'string')
    : defaultShareFields(available);

  return {
    visibleFields: [...new Set(requested)].filter((name) => available.has(name)),
    showPhotos: input.showPhotos !== false,
  };
}

export async function getPropertyShareConfig(conn: Tx = db): Promise<PropertyShareConfig> {
  const fields = await shareableFields();
  const setting = await conn.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = $1`,
    [PROPERTY_SHARE_SETTING],
  );
  return normaliseConfig(setting?.value, new Set(fields.map((field) => field.name)));
}

export async function getPropertyShareAdminConfig(conn: Tx = db): Promise<{
  fields: PropertyShareField[];
  showPhotos: boolean;
}> {
  const fields = await shareableFields();
  const config = await getPropertyShareConfig(conn);
  const visible = new Set(config.visibleFields);
  return {
    fields: fields.map((field) => ({
      name: field.name,
      label: field.label,
      uitype: field.uitype,
      visible: visible.has(field.name),
    })),
    showPhotos: config.showPhotos,
  };
}

export async function savePropertyShareConfig(
  input: PropertyShareConfig,
  userId: string,
  conn: Tx = db,
): Promise<PropertyShareConfig> {
  const fields = await shareableFields();
  const config = normaliseConfig(input, new Set(fields.map((field) => field.name)));
  await conn.query(
    `INSERT INTO ipy_setting
       (key, value, category, label, description, updated_by, updated_at)
     VALUES ($1,$2::jsonb,'sharing','Property share links',
             'Controls exactly which property details and photos a buyer can see through a private share link.',
             $3,now())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       category = EXCLUDED.category,
       label = EXCLUDED.label,
       description = EXCLUDED.description,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [PROPERTY_SHARE_SETTING, JSON.stringify(config), userId],
  );
  return config;
}

/**
 * Read only the fields the admin selected. SQL identifiers come exclusively
 * from validated metadata and still pass through quoteIdent/fieldExpr.
 */
export async function loadSharedProperty(recordId: string, conn: Tx = db): Promise<SharedPropertyPayload | null> {
  const module = await registry.requireModule('properties');
  const available = (await shareableFields());
  const config = await getPropertyShareConfig(conn);
  const selected = new Set(config.visibleFields);
  const visible = available.filter((field) => selected.has(field.name));

  const columns = visible.map((field) => (
    `${fieldExpr(field, 'u')} AS ${quoteIdent(field.name)}`
  ));
  // An all-hidden share is valid (photos only), but still has to prove that the
  // property row exists. The marker is removed before returning the payload.
  const row = await conn.queryOne<Record<string, unknown>>(
    `SELECT u.record_id AS ${quoteIdent('__record_exists')}${columns.length ? `, ${columns.join(', ')}` : ''}
       FROM ${quoteIdent(module.tableName)} u
      WHERE u.record_id = $1`,
    [recordId],
  );
  if (!row) return null;
  delete row.__record_exists;

  // The title comes from the module's own `labelFields`, the same metadata the
  // list and every lookup use, so a renamed or replaced name field follows
  // automatically. The browser used to guess at `project_name` then `name`,
  // both of which production deleted, and every shared unit was called
  // "Property".
  // Only from label fields that are actually shared and actually filled.
  // `buildLabel` ends on the module's singular label, so an unshared unit name
  // produced the title "Property" — truthy, which suppressed the page's own
  // better fallback of "3 BHK Builder Floor". Null lets that run.
  const labelled = module.labelFields.some((name) => {
    const value = row[name];
    return value !== null && value !== undefined && String(value).trim() !== '';
  });
  const title = labelled ? buildLabel(module, row) : null;

  // Which field holds the price is the mapping the admin already made on the
  // Matching Setup screen — the one answer the rest of the CRM uses. Read here
  // rather than in the browser so that a CRM whose price lives in an
  // admin-created field still shows one.
  const price = await priceField();
  // Matched on `columnName`, which is the real column for a built-in field and
  // the JSONB key for an admin-created one, because that is what the mapping
  // stores and it survives a rename. The row itself is keyed by field *name*,
  // so the number is read back by name below — the two are the same string
  // only until somebody renames the field.
  const priceName = visible.find((field) => field.columnName === price.column)?.name;
  const priceShared = Boolean(priceName);
  const priceValue = priceName === undefined ? null : Number(row[priceName]);

  return {
    property: row,
    fields: visible
      // Shown once, in the header. Left in the facts list it appeared twice.
      .filter((field) => field.name !== priceName)
      .map((field) => ({ name: field.name, label: field.label, uitype: field.uitype })),
    showPhotos: config.showPhotos,
    title,
    price: priceValue !== null && Number.isFinite(priceValue) && priceValue > 0 ? priceValue : null,
    priceShared,
  };
}
