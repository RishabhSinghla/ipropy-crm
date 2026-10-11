/**
 * Which of our own records a dealer-group deal fits — both ways.
 *
 *   A dealer *has* a 3 BHK in Greenfields at ₹1.45 Cr → which of our contacts
 *   want one?
 *   A dealer's client *wants* a 2 BHK under 80 lakh → which of our units fit?
 *
 * Deliberately simpler than `ai/matching.ts`, which scores a unit against a
 * buyer on a dozen facts. A group post carries three facts at best (BHK,
 * price, locality), so this asks only those, and demands the locality: a
 * "3 BHK, 1.5 Cr" with no place in it fits half the database and alerting on
 * it would teach the team to ignore the alerts.
 *
 * Every payload column is read through `fieldText`/`fieldJson`, so a field an
 * admin deleted reads as empty rather than raising (see payloadColumns.ts).
 */
import { db } from '../../db/pool.js';
import { columnsOf, fieldJson, fieldText } from '../entity/payloadColumns.js';
import { recordScopeSql } from '../permissions/index.js';
import type { ScopeContext } from '../permissions/index.js';
import { SqlParams } from '../query/builder.js';

export interface DealMatch {
  recordId: string;
  module: 'leads' | 'properties';
  label: string;
  ownerId: string | null;
}

interface Deal {
  kind: 'have' | 'want' | 'unknown';
  bhk: number | null;
  price_min_lakh: number | null;
  price_max_lakh: number | null;
  localities: string[];
}

/** A dealer quoting ₹1.45 Cr will take a little less; a buyer saying 1.5 will stretch a little. */
const PRICE_GRACE = 0.15;

const NOT_OPEN = `'lost','junk','won','closed','sold','booked','registered','not interested'`;

async function leadsWanting(deal: Deal, scope?: ScopeContext): Promise<DealMatch[]> {
  const columns = await columnsOf('ipy_e_leads');
  const text = (column: string): string => fieldText(columns, 'l', column);
  const json = (column: string): string => fieldJson(columns, 'l', column);
  const params = new SqlParams();
  const where = [
    `r.is_deleted = false`,
    `r.archived_at IS NULL`,
    `lower(coalesce(${text('status')}, '')) NOT IN (${NOT_OPEN})`,
    `${json('preferred_locations')} ?| ${params.add(deal.localities)}::text[]`,
  ];
  if (deal.bhk) {
    // A lead who has not said a size is not ruled out by one.
    const size = params.add(`${deal.bhk} BHK`);
    where.push(`(jsonb_typeof(${json('configuration')}) IS DISTINCT FROM 'array'
                 OR jsonb_array_length(${json('configuration')}) = 0
                 OR ${json('configuration')} ? ${size})`);
  }
  if (deal.price_min_lakh) {
    const floor = params.add(deal.price_min_lakh * 100_000 * (1 - PRICE_GRACE));
    where.push(`(ipy_try_numeric(${text('budget')}) IS NULL OR ipy_try_numeric(${text('budget')}) >= ${floor}::numeric)`);
  }
  if (scope) {
    const fragment = await recordScopeSql(scope, 'leads', params, false);
    if (fragment) where.push(fragment);
  }
  const rows = await db.query<{ record_id: string; label: string; owner_id: string | null }>(
    `SELECT r.id AS record_id, r.label, r.owner_id
       FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.updated_at DESC LIMIT 25`,
    params.all(),
  );
  return rows.rows.map((row) => ({ recordId: row.record_id, module: 'leads', label: row.label, ownerId: row.owner_id }));
}

async function unitsFitting(deal: Deal, scope?: ScopeContext): Promise<DealMatch[]> {
  const columns = await columnsOf('ipy_e_properties');
  const text = (column: string): string => fieldText(columns, 'p', column);
  const params = new SqlParams();
  const where = [
    `r.is_deleted = false`,
    `r.archived_at IS NULL`,
    `lower(coalesce(${text('status')}, '')) NOT IN (${NOT_OPEN})`,
    `${text('locality')} = ANY(${params.add(deal.localities)}::text[])`,
  ];
  if (deal.bhk) {
    where.push(`(ipy_try_numeric(${text('bedrooms')}) IS NULL OR ipy_try_numeric(${text('bedrooms')}) = ${params.add(deal.bhk)}::numeric)`);
  }
  if (deal.price_max_lakh) {
    const ceiling = params.add(deal.price_max_lakh * 100_000 * (1 + PRICE_GRACE));
    where.push(`(coalesce(ipy_try_numeric(${text('total_price')}), ipy_try_numeric(${text('base_price')})) IS NULL
                 OR coalesce(ipy_try_numeric(${text('total_price')}), ipy_try_numeric(${text('base_price')})) <= ${ceiling}::numeric)`);
  }
  if (scope) {
    const fragment = await recordScopeSql(scope, 'properties', params, false);
    if (fragment) where.push(fragment);
  }
  const rows = await db.query<{ record_id: string; label: string; owner_id: string | null }>(
    `SELECT r.id AS record_id, r.label, r.owner_id
       FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.updated_at DESC LIMIT 25`,
    params.all(),
  );
  return rows.rows.map((row) => ({ recordId: row.record_id, module: 'properties', label: row.label, ownerId: row.owner_id }));
}

/**
 * Our records this deal fits. Pass a scope to see only what that person may
 * open; without one it is the whole business, which is what the alerts need
 * so each owner hears about their own records.
 */
export async function matchDeal(postId: string, scope?: ScopeContext): Promise<DealMatch[]> {
  const deal = await db.queryOne<Deal>(
    `SELECT kind, bhk, price_min_lakh, price_max_lakh, localities FROM ipy_market_post WHERE id = $1`,
    [postId],
  );
  if (!deal || !deal.localities.length || deal.kind === 'unknown') return [];
  if (!deal.bhk && !deal.price_min_lakh) return [];
  return deal.kind === 'have' ? leadsWanting(deal, scope) : unitsFitting(deal, scope);
}
