/**
 * Where a property's price lives.
 *
 * Every part of the CRM that compares money against a property used to name
 * `total_price` and `base_price` directly. Both are built-in columns, and this
 * CRM promises an administrator may retire a built-in field and create their
 * own — which production did, replacing them with `asking_price` and pointing
 * Budget at it on the Matching Field Mapping screen.
 *
 * The result was not a wrong number, it was no number: the price read as NULL,
 * and `NULL <= :max` is NULL rather than true, so every property dropped out of
 * every budget comparison. Matching, comparables, lead scoring and the first
 * WhatsApp reply all went quiet at once, each looking like its own bug.
 *
 * So there is one answer to "which field is the price", and it is the mapping
 * the admin already made. The built-in columns stay as the fallback, because a
 * CRM that never moved its price should not notice this exists.
 */
import { matchingConfig, pairFor, type MatchingConfig } from './matching.js';

export interface PriceField {
  column: string;
  storage: 'column' | 'json';
}

const BUILT_IN: PriceField = { column: 'base_price', storage: 'column' };

/** The property field Budget is mapped to, or the built-in column. */
export function priceFieldFrom(config: MatchingConfig): PriceField {
  const pair = pairFor(config, 'budget');
  const column = pair?.propertyColumn ?? pair?.propertyField;
  return column
    ? { column, storage: pair?.propertyStorage === 'json' ? 'json' : 'column' }
    : BUILT_IN;
}

/** The same, for callers that have no config to hand. Cached upstream. */
export async function priceField(): Promise<PriceField> {
  return priceFieldFrom(await matchingConfig());
}

/**
 * A SQL expression for that price, given an alias for the properties table and
 * a bound parameter holding the column name.
 *
 * The column is bound rather than interpolated: it comes from metadata an admin
 * controls, and this file has no business opening a SQL-injection surface to
 * read a number.
 */
export function priceSql(price: PriceField, columnParam: string, alias = 'p'): string {
  const mapped = price.storage === 'json'
    ? `ipy_try_numeric(to_jsonb(${alias})->'custom_fields'->>${columnParam})`
    : `ipy_try_numeric(to_jsonb(${alias})->>${columnParam})`;
  return `COALESCE(${mapped},
             ipy_try_numeric(to_jsonb(${alias})->>'total_price'),
             ipy_try_numeric(to_jsonb(${alias})->>'base_price'))`;
}

/** And in TypeScript, off a `to_jsonb(p)` row. */
export function priceFromRow(raw: Record<string, unknown> | undefined, price: PriceField): number | null {
  if (!raw) return null;
  const custom = (raw.custom_fields ?? {}) as Record<string, unknown>;
  const candidates = [
    price.storage === 'json' ? custom[price.column] : raw[price.column],
    raw.total_price,
    raw.base_price,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(n)) return n;
  }
  return null;
}
