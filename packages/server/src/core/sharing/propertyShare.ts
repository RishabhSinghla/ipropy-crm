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
}

/**
 * Privacy-first defaults. Exact identity and location are deliberately absent:
 * Unit Name, Project, Tower, Wing, Unit Number, City and Locality all remain
 * available to an admin, but a fresh installation does not expose them.
 */
export const DEFAULT_PROPERTY_SHARE_FIELDS = [
  'property_type', 'configuration',
  'floor', 'facing', 'view_description', 'corner_unit', 'vastu_compliant',
  'bedrooms', 'bathrooms', 'balconies', 'parking_slots', 'furnishing',
  'carpet_area', 'built_up_area', 'super_built_up_area', 'plot_area',
  'balcony_area', 'terrace_area', 'area_unit',
  'total_price', 'monthly_rent', 'maintenance_monthly',
  'possession_status', 'possession_date', 'is_resale', 'age_of_property',
  'amenities', 'description',
];

const SUPPORTED_TYPES = new Set<FieldMeta['uitype']>([
  'string', 'textarea', 'richtext', 'url',
  'integer', 'decimal', 'currency', 'percent', 'area',
  'picklist', 'multipicklist', 'boolean',
  'date', 'datetime', 'time', 'formula',
]);

/** Fields whose business meaning is internal even if an admin later relabels them. */
const NEVER_SHARE = new Set([
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
    : DEFAULT_PROPERTY_SHARE_FIELDS;

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

  return {
    property: row,
    fields: visible.map((field) => ({ name: field.name, label: field.label, uitype: field.uitype })),
    showPhotos: config.showPhotos,
  };
}
