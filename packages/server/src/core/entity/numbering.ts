/**
 * Auto-number generation (LEAD-00042, IPY-PROJ-0007, …).
 *
 * Uses UPDATE ... RETURNING on a single sequence row so concurrent inserts
 * cannot produce duplicates, and supports yearly/monthly resets.
 */
import type { Tx } from '../../db/pool.js';
import { db } from '../../db/pool.js';

export interface NumberingSpec {
  prefix?: string;
  suffix?: string;
  digits?: number;
  start?: number;
  resetPolicy?: 'never' | 'yearly' | 'monthly';
}

function currentMarker(policy: 'never' | 'yearly' | 'monthly'): string | null {
  const now = new Date();
  if (policy === 'yearly') return String(now.getUTCFullYear());
  if (policy === 'monthly') return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return null;
}

export async function nextNumber(
  moduleName: string,
  fieldName: string,
  spec: NumberingSpec = {},
  conn: Tx = db,
): Promise<string> {
  const prefix = spec.prefix ?? '';
  const suffix = spec.suffix ?? '';
  const digits = spec.digits ?? 5;
  const start = spec.start ?? 1;
  const policy = spec.resetPolicy ?? 'never';
  const marker = currentMarker(policy);

  // Create the row if this is the first ever number for the module/field.
  await conn.query(
    `INSERT INTO ipy_sequence (module_name, field_name, prefix, suffix, digits, current_value, reset_policy, reset_marker)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (module_name, field_name) DO NOTHING`,
    [moduleName, fieldName, prefix, suffix, digits, start - 1, policy, marker],
  );

  // Atomic increment, resetting the counter when the period rolls over.
  const row = await conn.queryOne<{ current_value: number; prefix: string; suffix: string; digits: number }>(
    `UPDATE ipy_sequence
     SET current_value = CASE
           WHEN reset_policy <> 'never' AND reset_marker IS DISTINCT FROM $3 THEN $4
           ELSE current_value + 1
         END,
         reset_marker = $3
     WHERE module_name = $1 AND field_name = $2
     RETURNING current_value, prefix, suffix, digits`,
    [moduleName, fieldName, marker, start],
  );

  if (!row) return `${prefix}${String(start).padStart(digits, '0')}${suffix}`;

  const body = String(row.current_value).padStart(row.digits ?? digits, '0');
  const periodPart = policy === 'yearly' ? `${new Date().getUTCFullYear()}-` :
    policy === 'monthly' ? `${currentMarker('monthly')}-` : '';
  return `${row.prefix ?? prefix}${periodPart}${body}${row.suffix ?? suffix}`;
}

/** Read the configured spec without consuming a number (for admin previews). */
export async function previewNumber(moduleName: string, fieldName: string, spec: NumberingSpec = {}, conn: Tx = db): Promise<string> {
  const row = await conn.queryOne<{ current_value: number }>(
    `SELECT current_value FROM ipy_sequence WHERE module_name = $1 AND field_name = $2`,
    [moduleName, fieldName],
  );
  const next = (row?.current_value ?? (spec.start ?? 1) - 1) + 1;
  const digits = spec.digits ?? 5;
  return `${spec.prefix ?? ''}${String(next).padStart(digits, '0')}${spec.suffix ?? ''}`;
}
