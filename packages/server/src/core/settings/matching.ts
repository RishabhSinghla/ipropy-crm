/**
 * Which contact field is compared against which property field when scoring
 * a buyer↔property match, and how much grace a price/currency pair gets.
 *
 * Buyer matching used to name these as hardcoded SQL columns — budget vs
 * base_price, configuration vs bedrooms, and so on — with a fixed ±10%/20%
 * price band nobody could see or change. An admin who wanted to compare a
 * different pair of fields, or loosen the price band, had no way in short of
 * asking for code to change. This is that way in: an ordered list of
 * contact-field ↔ property-field pairs plus one percentage, editable from
 * Admin → Matching Setup, read by `ai/matching.ts` on every match.
 *
 * Same cache-and-invalidate contract as scoring.ts: matching runs on every
 * lead view and property view, so a database round trip per match is a real
 * cost, and an edit has to take effect on the next match, not the next
 * restart.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registry } from '../metadata/registry.js';

export interface MatchFieldPair {
  /** A field on the leads (Contacts) module. */
  contactField: string;
  /** A field on the properties module. */
  propertyField: string;
  /** Permanent field IDs persisted in the mapping table. */
  contactFieldId?: string;
  propertyFieldId?: string;
  /*
    Where the value actually lives.

    `contactField`/`propertyField` are field *names*, and a name is the one
    thing on a field that changes — renaming is routine here. The payload row
    is keyed by `column_name`, which never changes, so every read of a value
    goes through these and never through the name. On a CRM where nobody has
    renamed anything the two are identical, which is exactly why reading the
    name appeared to work.
  */
  contactColumn?: string;
  propertyColumn?: string;
  contactStorage?: 'column' | 'json';
  propertyStorage?: 'column' | 'json';
  contactLabel?: string;
  propertyLabel?: string;
  contactUitype?: string;
  propertyUitype?: string;
}

export interface MatchingConfig {
  fieldMap: MatchFieldPair[];
  /** Applied only to pairs where the property field is a currency field. */
  priceGracePercent: number;
  /** Size tolerance for mapped area fields; independent from pricing. */
  areaGracePercent: number;
}

/** What the engine compared before any of this was editable. */
export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  fieldMap: [
    { contactField: 'budget', propertyField: 'base_price' },
    { contactField: 'configuration', propertyField: 'bedrooms' },
    { contactField: 'preferred_locations', propertyField: 'locality' },
    { contactField: 'area', propertyField: 'area' },
  ],
  priceGracePercent: 10,
  areaGracePercent: 15,
};

let cached: MatchingConfig | null = null;

export function invalidateMatchingConfig(): void {
  cached = null;
}

function isPair(v: unknown): v is MatchFieldPair {
  return Boolean(v) && typeof v === 'object'
    && typeof (v as MatchFieldPair).contactField === 'string' && (v as MatchFieldPair).contactField.length > 0
    && typeof (v as MatchFieldPair).propertyField === 'string' && (v as MatchFieldPair).propertyField.length > 0;
}

export async function matchingConfig(): Promise<MatchingConfig> {
  if (cached) return cached;
  try {
    const [leads, properties, settings, mappings] = await Promise.all([
      registry.requireModule('leads'),
      registry.requireModule('properties'),
      db.query<{ key: string; value: unknown }>(
        `SELECT key, value FROM ipy_setting WHERE key = ANY($1)`,
        [['matching.field_map', 'matching.price_grace_percent', 'matching.area_grace_percent']],
      ),
      db.query<{ source_field_internal_id: string; target_field_internal_id: string }>(
        `SELECT fm.source_field_internal_id, fm.target_field_internal_id
           FROM ipy_field_mapping fm
           JOIN ipy_module sm ON sm.id = fm.source_module_id AND sm.name = 'leads'
           JOIN ipy_module tm ON tm.id = fm.target_module_id AND tm.name = 'properties'
          WHERE fm.purpose = 'matching' AND fm.is_active
          ORDER BY fm.created_at`,
      ),
    ]);
    const map = new Map(settings.rows.map((r) => [r.key, r.value]));
    const leadById = new Map(leads.fields.map((f) => [f.internalId, f]));
    const propertyById = new Map(properties.fields.map((f) => [f.internalId, f]));
    const mapped = mappings.rows.flatMap((pair): MatchFieldPair[] => {
      const contact = leadById.get(pair.source_field_internal_id);
      const property = propertyById.get(pair.target_field_internal_id);
      return contact && property ? [{
        contactField: contact.name,
        propertyField: property.name,
        contactColumn: contact.columnName,
        propertyColumn: property.columnName,
        contactStorage: contact.storage,
        propertyStorage: property.storage,
        contactFieldId: contact.internalId,
        propertyFieldId: property.internalId,
        contactLabel: contact.label,
        propertyLabel: property.label,
        contactUitype: contact.uitype,
        propertyUitype: property.uitype,
      }] : [];
    });

    // Existing customers update in place: the migration imports their old
    // name-based setting into ipy_field_mapping. Until then, retain the old
    // setting as a safe compatibility fallback.
    const rawMap = map.get('matching.field_map');
    const legacyMap = Array.isArray(rawMap) ? rawMap.filter(isPair) : [];
    const fieldMap = mapped.length ? mapped : legacyMap;

    const rawGrace = map.get('matching.price_grace_percent');
    const grace = typeof rawGrace === 'number' && Number.isFinite(rawGrace) && rawGrace >= 0 && rawGrace <= 100
      ? rawGrace
      : DEFAULT_MATCHING_CONFIG.priceGracePercent;
    const rawAreaGrace = map.get('matching.area_grace_percent');
    const areaGrace = typeof rawAreaGrace === 'number' && Number.isFinite(rawAreaGrace) && rawAreaGrace >= 0 && rawAreaGrace <= 100
      ? rawAreaGrace : DEFAULT_MATCHING_CONFIG.areaGracePercent;

    cached = {
      fieldMap: fieldMap.length ? fieldMap : DEFAULT_MATCHING_CONFIG.fieldMap,
      priceGracePercent: grace,
      areaGracePercent: areaGrace,
    };
    return cached;
  } catch (err) {
    // Matching must never fail because a setting could not be read.
    logger.warn({ err }, 'could not read matching config, using defaults');
    return DEFAULT_MATCHING_CONFIG;
  }
}

/**
 * The admin-configured pair for one of the built-in contact fields.
 *
 * Matched on the column rather than the name for the same reason the pair
 * carries a column at all: `budget` the name can become `Client Budget`, and
 * the built-in scoring must keep finding it. Legacy pairs, which predate the
 * mapping table, stored the column in the name slot already.
 */
export function pairFor(config: MatchingConfig, contactColumn: string): MatchFieldPair | undefined {
  return config.fieldMap.find((p) => (p.contactColumn ?? p.contactField) === contactColumn);
}

/**
 * A mapped value out of a payload row, by the same rule the record service
 * uses: column-backed fields sit on the row, JSON-backed fields sit inside
 * `custom_fields`, and both are keyed by `column_name`.
 */
export function mappedValue(
  raw: Record<string, unknown> | undefined,
  column: string | undefined,
  storage: 'column' | 'json' | undefined,
): unknown {
  if (!raw || !column) return undefined;
  if (storage === 'json') {
    const custom = (raw.custom_fields ?? {}) as Record<string, unknown>;
    return custom[column];
  }
  return raw[column];
}
