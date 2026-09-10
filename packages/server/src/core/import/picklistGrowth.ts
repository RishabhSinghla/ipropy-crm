/**
 * A dropdown value the file has and the CRM does not.
 *
 * The owner's ask: "drop down field of any key value automatically create a
 * new drop down". A spreadsheet of six hundred units has localities, tower
 * names and possession statuses that nobody has typed into the CRM yet, and
 * the choice used to be to add all of them by hand first or to import values
 * that no filter, no view and no report could see afterwards — because a
 * picklist value is a plain string on the record, not a foreign key, so an
 * unknown one stores fine and is simply never offered again.
 *
 * So the import grows the list instead. Two rules make that safe:
 *
 *  - **A tombstoned option is never resurrected.** `ipy_picklist_tombstone`
 *    is how a deliberate deletion survives the seed, and a spreadsheet with
 *    an old value in it is not a decision to bring the option back. Those are
 *    reported as skipped, not added.
 *  - **Case and spacing fold.** "sector 21", "Sector 21" and "Sector  21 "
 *    are the same locality, and adding three of them is worse than adding
 *    none. An incoming value that matches an existing option apart from case
 *    or spacing is rewritten to the option's own spelling.
 */
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import type { FieldMeta } from '@ipropy/shared';

export interface GrowthResult {
  /** `Field → value` for each option this created. */
  added: string[];
  /** Values left alone because somebody had deliberately deleted that option. */
  skippedTombstoned: string[];
}

/** The comparison key: what makes two spellings the same option. */
function fold(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Fields on this module whose values come from a dropdown the import may grow. */
export function growableFields(fields: FieldMeta[]): FieldMeta[] {
  return fields.filter(
    (f) => (f.uitype === 'picklist' || f.uitype === 'radio' || f.uitype === 'multipicklist' || f.uitype === 'tags')
      && typeof f.config.picklist === 'string',
  );
}

/**
 * Reconcile the values a file actually contains against the options that
 * exist, adding what is missing.
 *
 * Called once with everything the file holds, before any row is written, so
 * an import of two thousand rows costs one pass rather than two thousand
 * lookups — and so the first row is validated against the same list as the
 * last.
 *
 * Returns the corrections to apply while writing rows: incoming spelling →
 * the option's spelling.
 */
export async function growPicklists(
  fields: FieldMeta[],
  /** Field name → every distinct value seen in the file for it. */
  seen: Map<string, Set<string>>,
  conn: Tx = db,
): Promise<{ result: GrowthResult; canonical: Map<string, Map<string, string>> }> {
  const result: GrowthResult = { added: [], skippedTombstoned: [] };
  const canonical = new Map<string, Map<string, string>>();

  for (const field of growableFields(fields)) {
    const values = seen.get(field.name);
    if (!values?.size) continue;
    const listName = String(field.config.picklist);

    const list = await conn.queryOne<{ id: string; allow_adhoc: boolean }>(
      `SELECT id, allow_adhoc FROM ipy_picklist WHERE name = $1`, [listName],
    );
    if (!list) continue;

    const existing = await conn.query<{ value: string; sequence: number }>(
      `SELECT value, sequence FROM ipy_picklist_value WHERE picklist_id = $1`, [list.id],
    );
    const byFold = new Map(existing.rows.map((r) => [fold(r.value), r.value]));
    let nextSeq = Math.max(0, ...existing.rows.map((r) => r.sequence)) + 1;

    const tombstoned = await conn.query<{ value: string }>(
      `SELECT value FROM ipy_picklist_tombstone WHERE picklist_name = $1`, [listName],
    );
    const deadFold = new Set(tombstoned.rows.map((r) => fold(r.value)));

    const map = new Map<string, string>();
    for (const raw of values) {
      const value = raw.trim();
      if (!value) continue;
      const key = fold(value);

      const known = byFold.get(key);
      if (known) {
        // Only worth recording when the spelling actually differs.
        if (known !== value) map.set(value, known);
        continue;
      }
      if (deadFold.has(key)) {
        result.skippedTombstoned.push(`${field.label} → ${value}`);
        continue;
      }

      await conn.query(
        `INSERT INTO ipy_picklist_value (picklist_id, value, label, sequence, is_active)
         VALUES ($1, $2, $2, $3, true)
         ON CONFLICT DO NOTHING`,
        [list.id, value, nextSeq++],
      );
      byFold.set(key, value);
      result.added.push(`${field.label} → ${value}`);
    }
    if (map.size) canonical.set(field.name, map);
  }

  if (result.added.length) {
    logger.info({ added: result.added.length }, 'import added dropdown options');
  }
  return { result, canonical };
}
