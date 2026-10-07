import type { ModuleMeta } from '@ipropy/shared';
import type { Tx } from '../../db/pool.js';
import { ConflictError } from '../../utils/errors.js';
import { registry } from '../metadata/registry.js';
import { fieldExpr, quoteIdent } from '../query/builder.js';

/** Presentation prefixes do not make an Indian mobile a different identity. */
export function mobileIdentity(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const national = digits.replace(/^0+/, '');
  if (national.length === 10) return national;
  if (/^(91|091|0091)\d{10}$/.test(digits)) return digits.slice(-10);
  return digits;
}

export function mobileIdentities(module: ModuleMeta, values: Record<string, unknown>): Set<string> {
  return new Set(module.fields.filter(f => f.isActive && f.uitype === 'phone')
    .map(f => mobileIdentity(values[f.name])).filter((v): v is string => v !== null));
}

// Keep SQL and JS normalisation in step, including legacy formatted rows.
export function identitySql(expression: string): string {
  const digits = `regexp_replace(coalesce((${expression})::text, ''), '[^0-9]', '', 'g')`;
  return `(CASE WHEN length(ltrim(${digits}, '0')) = 10 THEN ltrim(${digits}, '0')
    WHEN ${digits} ~ '^(91|091|0091)[0-9]{10}$' THEN right(${digits}, 10)
    ELSE ${digits} END)`;
}

/** Non-bypassable, metadata-driven identity rule shared by configured modules. */
export async function assertMobileIdentityAvailable(
  conn: Tx, module: ModuleMeta, values: Record<string, unknown>,
  options: { existing?: Record<string, unknown>; excludeId?: string } = {},
): Promise<void> {
  const group = module.settings?.mobileIdentityGroup;
  if (typeof group !== 'string' || !group) return;
  const old = mobileIdentities(module, options.existing ?? {});
  const added = [...mobileIdentities(module, values)].filter(n => !old.has(n)).sort();
  if (!added.length) return;
  if (!conn.inTransaction) throw new Error('Mobile identity checks require a transaction');
  // Sorted locks avoid deadlocks for two-phone saves. Locks cover the query AND
  // the eventual insert/update, so simultaneous creates cannot both pass.
  for (const number of added) {
    await conn.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`mobile:${group}:${number}`]);
  }
  const modules = await registry.getModules({ entityOnly: true });
  for (const candidate of modules.filter(m => m.settings?.mobileIdentityGroup === group)) {
    const fields = candidate.fields.filter(f => f.isActive && f.uitype === 'phone');
    if (!fields.length) continue;
    const hit = await conn.queryOne<{ id: string }>(
      `SELECT r.id FROM ipy_record r JOIN ${quoteIdent(candidate.tableName)} e ON e.record_id = r.id
       WHERE r.module_id = $1 AND r.is_deleted = false
       AND ($3::uuid IS NULL OR r.id <> $3::uuid)
       AND (${fields.map(f => `${identitySql(fieldExpr(f))} = ANY($2::text[])`).join(' OR ')}) LIMIT 1`,
      [candidate.id, added, options.excludeId ?? null],
    );
    if (hit) {
      // Do not disclose a different agent's private record details.
      throw new ConflictError('This mobile number already exists in Leads or Inventory. Use the existing record instead.',
        { field: fields.find(f => added.includes(mobileIdentity(values[f.name]) ?? ''))?.name ?? 'mobile' });
    }
  }
}
