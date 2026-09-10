/**
 * Every column-backed field must have its column.
 *
 * This is the fifth time a missing payload column has taken a whole feature
 * down without a test noticing, so the guard finally lives above the thing
 * that keeps failing rather than beside it. The three ways the two drift:
 *
 *  1. `002_entities.sql` has been edited repeatedly since production applied
 *     it. An applied migration never re-runs, so every column added to that
 *     file afterwards never reached that database — four casualties so far
 *     (configuration, locality, bedrooms, area_unit), and the cause promises
 *     more.
 *  2. `seed/helpers.ts ensureColumn` only walks the *template*. A field an
 *     admin created as JSON and later converted to a column, or one seeded by
 *     a template that has since changed shape, is not in that walk.
 *  3. A permanent field delete drops the column. Re-creating the field by
 *     hand puts the metadata row back; nothing put the column back.
 *
 * What it does NOT do is resurrect a field somebody deleted: it reads
 * `ipy_field`, so a field that is gone from metadata is simply not seen. It
 * only ever adds — never drops, never retypes — so it cannot lose a value.
 *
 * Runs on every boot, straight after the modules are upserted. On a database
 * that is already in step it is one catalogue query and no writes.
 */
import type { Tx } from '../pool.js';
import { logger } from '../../utils/logger.js';
import { COLUMN_TYPES } from '../../core/metadata/fieldTypes.js';

/** JSONB list types are `NOT NULL DEFAULT '[]'` — an empty list is a value, not a null. */
const LIST_TYPES = new Set(['multipicklist', 'multireference', 'tags']);

export interface ReconcileResult {
  /** `table.column` for each column this added. */
  added: string[];
}

export async function reconcileColumns(conn: Tx): Promise<ReconcileResult> {
  const rows = await conn.query<{
    table_name: string; column_name: string; uitype: string; field: string; module: string;
  }>(
    /*
      `config->>'__record'` fields live on ipy_record, not on the payload
      table. Creating a same-named column there does not error — it shadows
      the real one in `SELECT r.*, p.*` and every record silently reads back
      as unassigned. `owner_id` is the one that matters and it is excluded
      here for exactly the reason ensureColumn excludes it.
    */
    `SELECT m.table_name, f.column_name, f.uitype, f.name AS field, m.name AS module
       FROM ipy_field f
       JOIN ipy_module m ON m.id = f.module_id
      WHERE f.storage = 'column'
        AND f.config->>'__record' IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns c
               WHERE c.table_name = m.table_name
                 AND c.column_name = f.column_name)`,
  );

  const added: string[] = [];
  for (const row of rows.rows) {
    const type = COLUMN_TYPES[row.uitype];
    if (!type) {
      // A uitype with no column type is a metadata bug, not a schema one —
      // formula and rollup are computed, and anything else here is a field
      // marked 'column' that never had one. Say so rather than guessing.
      logger.warn(
        { module: row.module, field: row.field, uitype: row.uitype },
        'field is stored as a column but its type has no SQL type — skipped',
      );
      continue;
    }
    // Identifiers, not parameters: both come from the catalogue and from
    // ipy_field, and ipy_field.column_name is already constrained to
    // [A-Za-z_][A-Za-z0-9_]* by quoteIdent everywhere it is used. Re-checked
    // here because this is DDL and a bad name is not recoverable.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.table_name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.column_name)) {
      logger.warn({ table: row.table_name, column: row.column_name }, 'refusing to add a column with an unsafe name');
      continue;
    }
    const suffix = LIST_TYPES.has(row.uitype) ? ` NOT NULL DEFAULT '[]'::jsonb` : '';
    await conn.query(`ALTER TABLE "${row.table_name}" ADD COLUMN IF NOT EXISTS "${row.column_name}" ${type}${suffix}`);
    added.push(`${row.table_name}.${row.column_name}`);
  }

  if (added.length) {
    logger.warn({ added }, 'reconcileColumns restored columns the metadata expected but the table did not have');
  }
  return { added };
}
