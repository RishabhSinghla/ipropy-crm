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
  contactLabel?: string;
  propertyLabel?: string;
}

export interface MatchingConfig {
  fieldMap: MatchFieldPair[];
  /** Applied only to pairs where the property field is a currency field. */
  priceGracePercent: number;
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
        [['matching.field_map', 'matching.price_grace_percent']],
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
        contactFieldId: contact.internalId,
        propertyFieldId: property.internalId,
        contactLabel: contact.label,
        propertyLabel: property.label,
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

    cached = {
      fieldMap: fieldMap.length ? fieldMap : DEFAULT_MATCHING_CONFIG.fieldMap,
      priceGracePercent: grace,
    };
    return cached;
  } catch (err) {
    // Matching must never fail because a setting could not be read.
    logger.warn({ err }, 'could not read matching config, using defaults');
    return DEFAULT_MATCHING_CONFIG;
  }
}

/** The admin-configured pair for a given contact field, if there is one. */
export function pairFor(config: MatchingConfig, contactField: string): MatchFieldPair | undefined {
  return config.fieldMap.find((p) => p.contactField === contactField);
}
