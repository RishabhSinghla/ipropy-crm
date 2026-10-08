/**
 * The property portal's feed — what property.ipropy.com shows a buyer.
 *
 * **1 October 2026, the owner:** the website becomes a property portal built on
 * the CRM's Inventories. Two decisions he made when asked, and this file is
 * built around both:
 *
 * - **Only the inventories staff tick go public.** The tick is the
 *   `publish_to_web` field. A ticked property still drops off the moment its
 *   status says it has gone (sold, won, lost, booked…), because nobody
 *   remembers to untick a sold flat and a buyer ringing about it is a wasted
 *   call and a worse first impression.
 * - **The seller is never on the portal.** Buyers deal with iPropy only.
 *
 * So the facts a buyer may read are an **allow-list of field names**, not a
 * deny-list. The share-link screen uses a deny-list, which is right there: an
 * admin chooses per field and a link goes to one person. A portal is the whole
 * internet, and a field somebody adds tomorrow called "Seller name" must stay
 * private until somebody decides otherwise in code review. Each name still has
 * to pass `isShareable` (no phone, owner, contact, email…) as a second lock.
 *
 * Names, not columns, because that is what differs between databases:
 * production calls Configuration `bedrooms` (stored in `configuration`) and
 * Locality `preferred_locations` (stored in `locality`). Unknown names are
 * simply absent, so a database without a field shows one fact fewer.
 */
import type { FieldMeta, PicklistOption } from '@ipropy/shared';
import { statusFieldOf } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { registry } from '../metadata/registry.js';
import { quoteIdent } from '../query/builder.js';
import { columnsOf } from '../entity/payloadColumns.js';
import { isShareable } from './propertyShare.js';

/** What a buyer may read, in the order a listing page shows it. */
export const BUYER_FACTS = [
  'bedrooms', 'configuration', 'bathrooms', 'balconies',
  'category', 'property_type', 'portion_type',
  'locality', 'preferred_locations', 'city',
  'area_size', 'area_size_unit', 'carpet_area', 'built_up_area', 'super_built_up_area', 'plot_area', 'area', 'area_unit',
  'demand', 'demand_unit', 'asking_price', 'asking_price_unit', 'total_price', 'monthly_rent', 'security_deposit', 'maintenance_monthly',
  'floor', 'facing', 'furnishing', 'possession_status', 'possession', 'age_of_property',
  'parking_slots', 'vastu_compliant', 'corner_unit', 'is_resale', 'amenities', 'description',
] as const;

/** One role each, first name present wins. These drive the card and the filters. */
const ROLES = {
  bedrooms: ['bedrooms', 'configuration'],
  category: ['category', 'property_type'],
  portion: ['portion_type'],
  locality: ['preferred_locations', 'locality'],
  city: ['city'],
  area: ['area_size', 'carpet_area', 'built_up_area', 'super_built_up_area', 'plot_area', 'area'],
  areaUnit: ['area_size_unit', 'area_unit'],
  price: ['demand', 'asking_price', 'total_price'],
  priceUnit: ['demand_unit', 'asking_price_unit'],
  rent: ['monthly_rent'],
} as const;
type Role = keyof typeof ROLES;

/** Words in a status that mean the property is no longer on the market. */
const OFF_MARKET_WORDS = 'lost|won|sold|closed|booked|registered|rented|agreement';

export function isOffMarket(status: unknown): boolean {
  return typeof status === 'string' && new RegExp(`\\b(${OFF_MARKET_WORDS})\\b`, 'i').test(status);
}

/*
  A description is typed by staff, and staff type phone numbers into it —
  "owner Sharma ji 98xxxxxxxx, call after 6". Ten or more digits in a row
  (spaces and dashes allowed) is never a fact about the flat.
*/
export function withoutPhoneNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s-]{8,}\d/g, '[number on request]');
}

interface ListingFields {
  table: string;
  facts: FieldMeta[];
  /** Every allowed field that can play a role, best first; the first filled one wins. */
  roles: Partial<Record<Role, FieldMeta[]>>;
  status: FieldMeta | undefined;
  published: FieldMeta | undefined;
}

/** The module whose records the portal lists. */
const PORTAL_MODULE = 'properties';

async function listingFields(): Promise<ListingFields | null> {
  const module = await registry.getModule(PORTAL_MODULE);
  if (!module) return null;
  const present = await columnsOf(module.tableName);
  const usable = (f: FieldMeta) => f.storage === 'json' || present.has(f.columnName);
  const byName = new Map(module.fields.filter((f) => f.isActive && usable(f)).map((f) => [f.name, f]));

  /*
    `isShareable` refuses hidden fields, and the two unit fields are hidden on
    purpose (they are drawn beside their number, never on their own). They are
    still a buyer's fact — "per sq. ft." — so they skip that one check only.
  */
  const isUnit = (name: string) => name.endsWith('_unit');
  const facts = BUYER_FACTS
    .map((name) => byName.get(name))
    .filter((f): f is FieldMeta => Boolean(f)
      && (isShareable(f!) || (isUnit(f!.name) && isShareable({ ...f!, displayType: 'default' }))));
  const allowed = new Map(facts.map((f) => [f.name, f]));

  const roles: Partial<Record<Role, FieldMeta[]>> = {};
  for (const role of Object.keys(ROLES) as Role[]) {
    const found = ROLES[role].map((name) => allowed.get(name)).filter((x): x is FieldMeta => Boolean(x));
    if (found.length) roles[role] = found;
  }

  /*
    A price or an area names its own unit field (`config.unitField`), and that
    is the one to trust over a guessed name — production's price is `demand`
    stored under `asking_price`, and its unit field is whatever it was called
    the day it was created.
  */
  const companion = (role: 'area' | 'price', unitRole: 'areaUnit' | 'priceUnit') => {
    const name = roles[role]?.[0]?.config.unitField;
    const unit = typeof name === 'string' ? byName.get(name) : undefined;
    if (!unit || !isShareable({ ...unit, displayType: 'default' })) return;
    roles[unitRole] = [unit, ...(roles[unitRole] ?? []).filter((f) => f.name !== unit.name)];
    if (!facts.some((f) => f.name === unit.name)) facts.push(unit);
  };
  companion('area', 'areaUnit');
  companion('price', 'priceUnit');

  return {
    table: module.tableName,
    facts,
    roles,
    status: statusFieldOf(module.fields.filter((f) => f.isActive && usable(f))),
    published: module.fields.find((f) => f.name === 'publish_to_web' && usable(f)),
  };
}

/** The stored value as JSON — a column as itself, a JSONB key as its raw value. */
function rawExpr(field: FieldMeta, alias = 'u'): string {
  if (field.storage === 'column') return `${alias}.${quoteIdent(field.columnName)}`;
  return `${alias}.custom_fields->${pgString(field.columnName)}`;
}

/** The same value as text, for filtering and searching. */
function textExpr(field: FieldMeta, alias = 'u'): string {
  if (field.storage === 'column') return `${alias}.${quoteIdent(field.columnName)}::text`;
  return `${alias}.custom_fields->>${pgString(field.columnName)}`;
}

/** A number, or NULL when somebody typed "1.5 Cr" into it — never an error. */
function numberExpr(field: FieldMeta, alias = 'u'): string {
  return `ipy_try_numeric(${textExpr(field, alias)})`;
}

/** A role as one number: the first of its fields that holds one. */
function roleNumber(fields: FieldMeta[] | undefined): string | null {
  if (!fields?.length) return null;
  return fields.length === 1 ? numberExpr(fields[0]) : `COALESCE(${fields.map((x) => numberExpr(x)).join(', ')})`;
}

/** Field metadata only ever reaches SQL as a literal escaped here. */
function pgString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The one rule for "this property is on the portal". The tick, not deleted,
 * and a status that does not say it has gone. Inlined as SQL so the list, the
 * detail page, the filters and the photo route all ask exactly this.
 */
function visibleClause(f: ListingFields, alias = 'u'): string {
  if (!f.published) return 'FALSE';
  const ticked = f.published.storage === 'column'
    ? `${alias}.${quoteIdent(f.published.columnName)}::text = 'true'`
    : `${alias}.custom_fields->>${pgString(f.published.columnName)} = 'true'`;
  const live = `EXISTS (SELECT 1 FROM ipy_record lr WHERE lr.id = ${alias}.record_id AND lr.is_deleted = false)`;
  const status = f.status
    ? `NOT (COALESCE(${textExpr(f.status, alias)}, '') ~* '\\m(${OFF_MARKET_WORDS})\\M')`
    : 'TRUE';
  return `(${ticked} AND ${live} AND ${status})`;
}

function labelOf(field: FieldMeta, value: unknown, options: PicklistOption[]): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (field.uitype === 'picklist' || field.uitype === 'radio') {
    return options.find((o) => o.value === value)?.label ?? value;
  }
  if (field.uitype === 'multipicklist' && Array.isArray(value)) {
    return value.map((v) => options.find((o) => o.value === v)?.label ?? v);
  }
  if (field.uitype === 'textarea' || field.uitype === 'richtext' || field.uitype === 'string') {
    return withoutPhoneNumbers(String(value));
  }
  return value;
}

async function optionsFor(field: FieldMeta): Promise<PicklistOption[]> {
  if (field.options?.length) return field.options;
  const units = field.config.unitOptions as { value: string; label: string }[] | undefined;
  if (units?.length) return units.map((u, i) => ({ ...u, color: null, sequence: i, isActive: true }));
  return field.config.picklist ? registry.getPicklist(field.config.picklist) : [];
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "3 BHK Builder Floor in Greenfields Colony" — from facts, never a name. */
export function listingTitle(parts: { bedrooms?: unknown; category?: unknown; portion?: unknown; locality?: unknown }): string {
  const rooms = parts.bedrooms === null || parts.bedrooms === undefined || parts.bedrooms === ''
    ? ''
    : /bhk|rk|studio/i.test(String(parts.bedrooms)) ? String(parts.bedrooms) : `${parts.bedrooms} BHK`;
  const kind = [parts.portion, parts.category].filter((p) => p && String(p).trim()).join(' ');
  const what = [rooms, kind].filter(Boolean).join(' ') || 'Property';
  return parts.locality ? `${what} in ${parts.locality}` : what;
}

export interface PublicListing {
  id: string;
  title: string;
  price: number | null;
  priceBasis: string | null;
  rent: number | null;
  area: number | null;
  areaUnit: string | null;
  bedrooms: string | null;
  category: string | null;
  locality: string | null;
  city: string | null;
  photos: string[];
  /** `type` is the field's kind (currency, area…) so the site can print ₹1.45 Cr rather than 14500000. */
  facts: { name: string; label: string; type: string; value: unknown }[];
  listedAt: string;
  updatedAt: string;
}

async function shape(f: ListingFields, row: Record<string, unknown>, size: 'medium' | 'large'): Promise<PublicListing> {
  const facts: PublicListing['facts'] = [];
  const shown: Record<string, unknown> = {};
  for (const field of f.facts) {
    const value = labelOf(field, row[field.name], await optionsFor(field));
    shown[field.name] = value;
    // A unit is drawn beside its number, and "Corner unit: No" is not a selling point.
    if (field.name.endsWith('_unit') || value === false) continue;
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    facts.push({ name: field.name, label: field.label, type: field.uitype, value });
  }
  const first = (r: Role, from: Record<string, unknown>) => {
    for (const field of f.roles[r] ?? []) {
      const v = from[field.name];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
  };
  const role = (r: Role) => first(r, shown);
  const text = (r: Role) => { const v = role(r); return v === null ? null : String(v); };

  return {
    id: String(row.id),
    title: listingTitle({ bedrooms: role('bedrooms'), category: role('category'), portion: role('portion'), locality: role('locality') }),
    price: asNumber(first('price', row)),
    priceBasis: text('priceUnit'),
    rent: asNumber(first('rent', row)),
    area: asNumber(first('area', row)),
    areaUnit: text('areaUnit'),
    bedrooms: text('bedrooms'),
    category: text('category'),
    locality: text('locality'),
    city: text('city'),
    photos: ((row.photos as string[] | null) ?? []).map((id) => `/api/public/media/${id}?size=${size}`),
    facts,
    listedAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/*
  Photos are the record's own images, in the order the team arranged them —
  the same rule as the old catalogue. A picture a customer sent on WhatsApp is
  stored against a record too, and that is a conversation, not a listing.
*/
const PHOTOS = `COALESCE((
    SELECT jsonb_agg(a.id ORDER BY a.sort_order NULLS LAST, a.created_at)
      FROM ipy_attachment a
     WHERE a.record_id = u.record_id AND a.mime_type LIKE 'image/%'
       AND COALESCE(a.category, '') <> 'whatsapp'
  ), '[]'::jsonb) AS photos`;

function selectList(f: ListingFields): string {
  return [
    'u.record_id AS id', 'r.created_at', 'r.updated_at', PHOTOS,
    ...f.facts.map((field) => `${rawExpr(field)} AS ${quoteIdent(field.name)}`),
  ].join(', ');
}

export interface ListingQuery {
  q?: string;
  city?: string[];
  locality?: string[];
  bedrooms?: string[];
  category?: string[];
  minPrice?: number;
  maxPrice?: number;
  sort?: string;
  page?: number;
  limit?: number;
}

const byNumber = (role: Role, dir: 'ASC' | 'DESC') => (f: ListingFields) => {
  const n = roleNumber(f.roles[role]);
  return n ? `${n} ${dir} NULLS LAST` : 'r.created_at DESC';
};
const SORTS: Record<string, (f: ListingFields) => string> = {
  newest: () => 'r.created_at DESC',
  price_asc: byNumber('price', 'ASC'),
  price_desc: byNumber('price', 'DESC'),
  area_desc: byNumber('area', 'DESC'),
};

export async function listPublicListings(query: ListingQuery): Promise<{ items: PublicListing[]; total: number; page: number; pages: number }> {
  const f = await listingFields();
  if (!f) return { items: [], total: 0, page: 1, pages: 0 };

  const conds = [visibleClause(f)];
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };

  const anyOf = (role: Role, values?: string[]) => {
    const field = f.roles[role]?.[0];
    if (!field || !values?.length) return;
    conds.push(`${textExpr(field)} = ANY(${bind(values)}::text[])`);
  };
  anyOf('city', query.city);
  anyOf('locality', query.locality);
  anyOf('bedrooms', query.bedrooms);
  anyOf('category', query.category);
  const price = roleNumber(f.roles.price);
  if (price && query.minPrice) conds.push(`${price} >= ${bind(query.minPrice)}::numeric`);
  if (price && query.maxPrice) conds.push(`${price} <= ${bind(query.maxPrice)}::numeric`);

  const q = query.q?.trim();
  if (q) {
    const searchable = f.facts.filter((field) => ['picklist', 'string', 'textarea', 'radio'].includes(field.uitype));
    if (searchable.length) {
      const p = bind(`%${q}%`);
      conds.push(`(${searchable.map((field) => `${textExpr(field)} ILIKE ${p}`).join(' OR ')})`);
    }
  }

  const limit = Math.min(48, Math.max(1, query.limit ?? 24));
  const page = Math.max(1, query.page ?? 1);
  const order = (SORTS[query.sort ?? ''] ?? SORTS.newest)(f);
  const where = conds.join(' AND ');
  const from = `FROM ${quoteIdent(f.table)} u JOIN ipy_record r ON r.id = u.record_id`;

  const [rows, count] = await Promise.all([
    db.query<Record<string, unknown>>(
      `SELECT ${selectList(f)} ${from} WHERE ${where}
        ORDER BY ${order}, u.record_id
        LIMIT ${bind(limit)} OFFSET ${bind((page - 1) * limit)}`,
      params,
    ),
    db.queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n ${from} WHERE ${where}`, params.slice(0, -2)),
  ]);
  const total = count?.n ?? 0;
  return {
    items: await Promise.all(rows.rows.map((row) => shape(f, row, 'medium'))),
    total,
    page,
    pages: Math.ceil(total / limit),
  };
}

export async function getPublicListing(id: string): Promise<PublicListing | null> {
  const f = await listingFields();
  if (!f || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT ${selectList(f)} FROM ${quoteIdent(f.table)} u JOIN ipy_record r ON r.id = u.record_id
      WHERE u.record_id = $1 AND ${visibleClause(f)}`,
    [id],
  );
  return row ? shape(f, row, 'large') : null;
}

/** Whether a record is on the portal right now — the photo route asks this. */
export async function isPublicListing(recordId: string): Promise<boolean> {
  const f = await listingFields();
  if (!f) return false;
  const row = await db.queryOne(
    `SELECT 1 FROM ${quoteIdent(f.table)} u WHERE u.record_id = $1 AND ${visibleClause(f)}`,
    [recordId],
  );
  return Boolean(row);
}

export interface ListingFacets {
  city: { value: string; label: string; count: number }[];
  locality: { value: string; label: string; count: number }[];
  bedrooms: { value: string; label: string; count: number }[];
  category: { value: string; label: string; count: number }[];
  price: { min: number | null; max: number | null };
  total: number;
}

/**
 * What the search box can offer: only values some live listing actually has,
 * with how many. A filter offering "Mohali" with nothing behind it is a dead
 * end a buyer meets once and remembers.
 */
export async function publicListingFacets(): Promise<ListingFacets> {
  const empty: ListingFacets = { city: [], locality: [], bedrooms: [], category: [], price: { min: null, max: null }, total: 0 };
  const f = await listingFields();
  if (!f) return empty;
  const from = `FROM ${quoteIdent(f.table)} u WHERE ${visibleClause(f)}`;

  const facet = async (role: Role) => {
    const field = f.roles[role]?.[0];
    if (!field) return [];
    const { rows } = await db.query<{ value: string; count: number }>(
      `SELECT ${textExpr(field)} AS value, COUNT(*)::int AS count ${from}
          AND NULLIF(${textExpr(field)}, '') IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100`,
    );
    const options = await optionsFor(field);
    return rows.map((r) => ({ value: r.value, label: String(labelOf(field, r.value, options) ?? r.value), count: r.count }));
  };

  const price = roleNumber(f.roles.price);
  const priceRow = price
    ? await db.queryOne<{ min: number | null; max: number | null }>(`SELECT MIN(${price}) AS min, MAX(${price}) AS max ${from}`)
    : null;
  const total = await db.queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n ${from}`);

  return {
    city: await facet('city'),
    locality: await facet('locality'),
    bedrooms: await facet('bedrooms'),
    category: await facet('category'),
    price: { min: priceRow?.min ?? null, max: priceRow?.max ?? null },
    total: total?.n ?? 0,
  };
}

/**
 * Whether a record can go on the portal, and whether it is on it now — what
 * the record's "Show on website" menu item asks before it draws itself.
 *
 * Asked of the server because the screen cannot work it out: production keeps
 * the tick field hidden from forms, and the screen's field list leaves hidden
 * fields out, so a switch that looked for the field on screen never appeared
 * (8 October 2026). The caller has already checked the person may open it.
 */
export async function websiteState(moduleName: string, recordId: string): Promise<{ offered: boolean; shown: boolean }> {
  const f = moduleName === PORTAL_MODULE ? await listingFields() : null;
  if (!f?.published) return { offered: false, shown: false };
  const row = await db.queryOne<{ shown: string | null }>(
    `SELECT ${textExpr(f.published)} AS shown FROM ${quoteIdent(f.table)} u WHERE u.record_id = $1`,
    [recordId],
  );
  return { offered: true, shown: row?.shown === 'true' };
}
