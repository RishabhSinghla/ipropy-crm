/**
 * What you have actually seen units like this go for.
 *
 * A portal can tell you the asking price in a locality. It cannot tell you what
 * *your* 3 BHKs in Powai were listed at, or that the two you priced above ₹2.3
 * Cr sat for ninety days while the ones under it moved. After a year of
 * photographing five to ten builder floors a day, that is a private index of
 * the local market that nobody else can build — and the moment it is worth
 * anything is the moment somebody is typing a number into a new unit.
 *
 * Deliberately one line, not a screen. This is not price history and not a
 * dashboard; both were considered and rejected, because a screen you have to
 * open is a screen nobody opens. It is a sentence next to the price field at
 * the moment the decision is being made.
 *
 * **Silence is a valid answer, and the common one.** Three units is not a
 * market. A comparison drawn from too few, or from ones too far away in size,
 * is worse than no comparison: it is a number with false authority behind it,
 * and somebody will price against it.
 */
import { formatIndianPrice } from '@ipropy/shared';
import { db } from '../db/pool.js';
import { priceField, priceSql } from '../core/settings/priceField.js';

/**
 * The fewest comparable units worth speaking about.
 *
 * Below five, a single unusual unit moves the median enough to mislead. This is
 * the difference between "this is what your stock does" and "here are two
 * numbers I found".
 */
const MIN_COMPARABLES = 5;

/** How far from the subject unit's size a comparable may be and still compare. */
const AREA_TOLERANCE = 0.25;

/** Old listings describe a different market; a year is the outer edge of useful. */
const MAX_AGE_DAYS = 365;

export interface Comparables {
  /** The one line to show. */
  summary: string;
  count: number;
  medianPrice: number;
  lowPrice: number;
  highPrice: number;
  /** Median days from listing to sold, for the ones that sold. */
  medianDaysToSell: number | null;
}

interface Row {
  price: number;
  status: string;
  days_listed: number | null;
}

/**
 * Comparables for a unit that may not exist yet.
 *
 * Takes the shape rather than an id, so this answers while somebody is still
 * typing the record — which is the only time it is useful.
 */
export async function comparablesFor(input: {
  locality: string | null;
  bedrooms: number | null;
  area: number | null;
  /** Excluded from its own comparison, when it exists. */
  excludeRecordId?: string | null;
}): Promise<Comparables | null> {
  if (!input.locality || input.bedrooms == null) return null;

  // Read through `to_jsonb(p)`, like buyer matching, and for the same reason:
  // locality, bedrooms, status and every area field are fields an admin may
  // delete, and naming a deleted one raises 42703 — which fails the statement
  // rather than the row, and turns a price hint into a 400 on the record form.
  /*
    The price is whichever field Budget is mapped to — see core/settings/
    priceField.ts. Naming `total_price`/`base_price` here meant a CRM whose
    admin created their own price field had every comparable priced at NULL,
    filtered out by the `> 0` below, and the record form showed no price hint
    at all rather than a wrong one.
  */
  const price = await priceField();
  // $6, after the five the statement already binds.
  const priceExpr = priceSql(price, '$6');

  const rows = await db.query<Row>(
    `SELECT ${priceExpr} AS price,
            to_jsonb(p)->>'status' AS status,
            CASE WHEN to_jsonb(p)->>'status' IN ('Sold','Registered','Agreement Done','Booked')
                 THEN EXTRACT(DAY FROM (r.updated_at - r.created_at))::int
                 ELSE NULL END AS days_listed
     FROM ipy_e_properties p
     JOIN ipy_record r ON r.id = p.record_id
     WHERE r.is_deleted = false
       AND to_jsonb(p)->>'locality' = $1
       AND ipy_try_numeric(to_jsonb(p)->>'bedrooms') = $2
       AND ${priceExpr} > 0
       AND r.created_at > now() - ($3 || ' days')::interval
       AND ($4::uuid IS NULL OR p.record_id <> $4)
       -- Same size bracket, or no size recorded either side. A 700 sq ft and a
       -- 1,600 sq ft 3-bedroom unit are not the same product and averaging
       -- them produces a number describing neither.
       AND ($5::numeric IS NULL OR ipy_try_numeric(to_jsonb(p)->>'area') IS NULL
            OR ipy_try_numeric(to_jsonb(p)->>'area')
                 BETWEEN $5 * ${1 - AREA_TOLERANCE} AND $5 * ${1 + AREA_TOLERANCE})`,
    [input.locality, input.bedrooms, String(MAX_AGE_DAYS), input.excludeRecordId ?? null, input.area, price.column],
  );

  if (rows.rows.length < MIN_COMPARABLES) return null;

  const prices = rows.rows.map((r) => Number(r.price)).sort((a, b) => a - b);
  const median = percentile(prices, 0.5);
  const low = percentile(prices, 0.15);
  const high = percentile(prices, 0.85);

  const sold = rows.rows
    .map((r) => r.days_listed)
    .filter((d): d is number => typeof d === 'number' && d >= 0)
    .sort((a, b) => a - b);
  const medianDays = sold.length >= 3 ? percentile(sold, 0.5) : null;

  return {
    count: rows.rows.length,
    medianPrice: median,
    lowPrice: low,
    highPrice: high,
    medianDaysToSell: medianDays,
    summary: describe({
      count: rows.rows.length,
      locality: input.locality,
      bedrooms: input.bedrooms,
      low, high, median, medianDays,
    }),
  };
}

/**
 * The sentence.
 *
 * Reads as a colleague would say it, and stops there. No recommendation: the
 * person typing knows things this does not — the floor, the view, how badly the
 * builder needs the money — and a CRM that says "price it at ₹2.1 Cr" is
 * pretending otherwise.
 */
function describe(input: {
  count: number;
  locality: string;
  bedrooms: number;
  low: number;
  high: number;
  median: number;
  medianDays: number | null;
}): string {
  const { count, locality, bedrooms, low, high, median, medianDays } = input;
  const range = `${formatIndianPrice(low)}–${formatIndianPrice(high)}`;
  let line = `Your last ${count} ${bedrooms}-bedroom units in ${locality} were listed at ${range}, typically ${formatIndianPrice(median)}.`;
  if (medianDays !== null) {
    line += ` The ones that sold took about ${medianDays} days.`;
  }
  return line;
}

/** Nearest-rank percentile on a pre-sorted array. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}
