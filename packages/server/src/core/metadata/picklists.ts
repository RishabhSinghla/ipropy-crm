/**
 * What a dropdown is actually used by, and what happens to records when one of
 * its options is renamed or deleted.
 *
 * An option is a string stored on every record that chose it. Nothing in the
 * schema ties the two together — `status` is a `TEXT` column holding `'Lost'`,
 * not a foreign key — so renaming the option without touching the records
 * silently orphans them: the record still says `'Lost'`, the dropdown no longer
 * offers it, and the value renders as a bare unstyled string that no filter
 * matches. That failure is invisible until somebody runs a report.
 *
 * This module is the other half of the rename: find every field that draws from
 * the dropdown, and rewrite the stored value everywhere it appears.
 *
 * Fields live in two places (`ipy_field.storage`) and hold the value in two
 * shapes (`picklist` = a string, `multipicklist` = a JSONB array), so there are
 * four cases and all four are handled here rather than in the route.
 */
import { db, type Tx } from '../../db/pool.js';
import { quoteIdent } from '../query/builder.js';
import * as registry from './registry.js';

export interface PicklistFieldUse {
  module: string;
  moduleLabel: string;
  tableName: string;
  field: string;
  fieldLabel: string;
  uitype: string;
  storage: 'column' | 'json';
  columnName: string;
  isMulti: boolean;
}

/**
 * Dropdowns the application reads by name, outside the field system.
 *
 * `fieldsUsingPicklist` answers "which form controls render this?", which is
 * the question that matters for almost every dropdown — but a handful are
 * fetched by name in code, so nothing points at them and they look unused.
 * Deleting one empties a control that has no field behind it: the call logger's
 * Disposition, and the two lists the call analyser is allowed to choose from.
 *
 * Keep this in step with the call sites — `web/pages/Calls.tsx` and
 * `ai/callAnalysis.ts` as of migration 049.
 */
export const PICKLISTS_USED_IN_CODE: Record<string, string> = {
  call_disposition: 'the outcome list on the call logger, and the values call analysis may choose from',
  lead_status: 'the statuses call analysis may propose for a lead',
};

/** Every field, on every module, whose options come from this dropdown. */
export async function fieldsUsingPicklist(name: string): Promise<PicklistFieldUse[]> {
  // Inactive modules included on purpose: their rows still hold the value, and
  // a dropdown option deleted while a module is switched off must not come back
  // to a module that is switched on again.
  const modules = await registry.getModules({ entityOnly: true });
  const uses: PicklistFieldUse[] = [];

  for (const module of modules) {
    for (const field of module.fields) {
      if (field.config?.picklist !== name) continue;
      if (field.uitype !== 'picklist' && field.uitype !== 'multipicklist') continue;
      uses.push({
        module: module.name,
        moduleLabel: module.label,
        tableName: module.tableName,
        field: field.name,
        fieldLabel: field.label,
        uitype: field.uitype,
        storage: field.storage,
        columnName: field.columnName,
        isMulti: field.uitype === 'multipicklist',
      });
    }
  }
  return uses;
}

/**
 * Fields where clearing the value is not possible.
 *
 * `ipy_e_leads.status` is `TEXT NOT NULL` — "delete this option and leave the
 * field empty" would fail on the constraint, roll the transaction back, and
 * show the admin a 500 for a choice the UI offered them. Better to know before
 * starting and say which field is in the way.
 */
export async function fieldsThatCannotBeCleared(name: string, conn: Tx = db): Promise<PicklistFieldUse[]> {
  const uses = await fieldsUsingPicklist(name);
  const blocked: PicklistFieldUse[] = [];

  for (const use of uses) {
    // A JSONB key is always removable; only a real column carries NOT NULL.
    if (use.storage !== 'column') continue;
    const row = await conn.queryOne<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [use.tableName, use.columnName],
    );
    if (row?.is_nullable === 'NO') blocked.push(use);
  }
  return blocked;
}

/** A SQL predicate matching rows whose value for `use` is `$1`. */
function matchExpr(use: PicklistFieldUse): string {
  if (use.storage === 'column') {
    const col = quoteIdent(use.columnName);
    return use.isMulti ? `${col} @> to_jsonb(ARRAY[$1]::text[])` : `${col} = $1`;
  }
  const key = `'${use.columnName.replace(/'/g, "''")}'`;
  return use.isMulti
    ? `custom_fields -> ${key} @> to_jsonb(ARRAY[$1]::text[])`
    : `custom_fields ->> ${key} = $1`;
}

/** How many live records hold this option, per field and in total. */
export async function countRecordsWithValue(
  name: string,
  value: string,
  conn: Tx = db,
): Promise<{ total: number; byField: { module: string; field: string; count: number }[] }> {
  const uses = await fieldsUsingPicklist(name);
  const byField: { module: string; field: string; count: number }[] = [];

  for (const use of uses) {
    const row = await conn.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM ${quoteIdent(use.tableName)}
        WHERE ${matchExpr(use)}
          AND EXISTS (SELECT 1 FROM ipy_record r WHERE r.id = record_id AND r.is_deleted = false)`,
      [value],
    );
    const count = row?.count ?? 0;
    if (count > 0) byField.push({ module: use.module, field: use.field, count });
  }

  return { total: byField.reduce((sum, f) => sum + f.count, 0), byField };
}

/**
 * Point every record holding `from` at `to`, or clear it when `to` is null.
 *
 * Deleted records are rewritten too, deliberately: a restore has to come back
 * with a value the dropdown still offers.
 */
export async function replaceValueInRecords(
  name: string,
  from: string,
  to: string | null,
  conn: Tx = db,
): Promise<{ records: number; filters: number }> {
  const uses = await fieldsUsingPicklist(name);
  let records = 0;

  for (const use of uses) {
    const table = quoteIdent(use.tableName);
    const key = `'${use.columnName.replace(/'/g, "''")}'`;
    let sql: string;
    const params: unknown[] = [from];

    if (use.storage === 'column' && !use.isMulti) {
      const col = quoteIdent(use.columnName);
      if (to === null) {
        sql = `UPDATE ${table} SET ${col} = NULL WHERE ${col} = $1`;
      } else {
        sql = `UPDATE ${table} SET ${col} = $2 WHERE ${col} = $1`;
        params.push(to);
      }
    } else if (use.storage === 'column' && use.isMulti) {
      const col = quoteIdent(use.columnName);
      // Rebuild the array element by element: the old value becomes the new one
      // (or drops out), everything else is untouched, and order is preserved.
      sql = to === null
        ? `UPDATE ${table} SET ${col} = COALESCE((
             SELECT jsonb_agg(x) FROM jsonb_array_elements_text(${col}) AS x WHERE x <> $1
           ), '[]'::jsonb)
           WHERE ${col} @> to_jsonb(ARRAY[$1]::text[])`
        : `UPDATE ${table} SET ${col} = COALESCE((
             SELECT jsonb_agg(DISTINCT CASE WHEN x = $1 THEN $2 ELSE x END)
               FROM jsonb_array_elements_text(${col}) AS x
           ), '[]'::jsonb)
           WHERE ${col} @> to_jsonb(ARRAY[$1]::text[])`;
      if (to !== null) params.push(to);
    } else if (!use.isMulti) {
      sql = to === null
        ? `UPDATE ${table} SET custom_fields = custom_fields - ${key}
             WHERE custom_fields ->> ${key} = $1`
        : `UPDATE ${table} SET custom_fields = jsonb_set(custom_fields, ARRAY[${key}], to_jsonb($2::text))
             WHERE custom_fields ->> ${key} = $1`;
      if (to !== null) params.push(to);
    } else {
      sql = to === null
        ? `UPDATE ${table} SET custom_fields = jsonb_set(custom_fields, ARRAY[${key}], COALESCE((
             SELECT jsonb_agg(x) FROM jsonb_array_elements_text(custom_fields -> ${key}) AS x WHERE x <> $1
           ), '[]'::jsonb))
           WHERE custom_fields -> ${key} @> to_jsonb(ARRAY[$1]::text[])`
        : `UPDATE ${table} SET custom_fields = jsonb_set(custom_fields, ARRAY[${key}], COALESCE((
             SELECT jsonb_agg(DISTINCT CASE WHEN x = $1 THEN $2 ELSE x END)
               FROM jsonb_array_elements_text(custom_fields -> ${key}) AS x
           ), '[]'::jsonb))
           WHERE custom_fields -> ${key} @> to_jsonb(ARRAY[$1]::text[])`;
      if (to !== null) params.push(to);
    }

    const res = await conn.query(sql, params);
    records += res.rowCount ?? 0;
  }

  // Saved views, workflow conditions and dashboard widgets filter on the stored
  // string too. A rename that leaves those behind produces a view that silently
  // returns nothing, which reads as "the CRM lost my leads".
  const filters = to !== null ? await renameInFilters(name, from, to, conn) : 0;

  return { records, filters };
}

/**
 * Rewrite the value wherever a saved filter mentions it.
 *
 * Matching is by *value*, not by field, and only for fields that draw on this
 * dropdown — hence the field-name list. Renaming "Lost" in Lead Status must not
 * touch a filter looking for "Lost" in a different dropdown that happens to use
 * the same word.
 */
async function renameInFilters(name: string, from: string, to: string, conn: Tx): Promise<number> {
  const fields = (await fieldsUsingPicklist(name)).map((u) => u.field);
  if (!fields.length) return 0;

  let changed = 0;
  for (const [table, column] of [
    ['ipy_view', 'filter'],
    ['ipy_dashboard_widget', 'config'],
    ['ipy_workflow', 'conditions'],
    // A workflow action that *writes* the value ("set Status to Lost") is as
    // broken by a rename as one that reads it.
    ['ipy_workflow_task', 'config'],
  ] as const) {
    const res = await conn.query(
      // A whole-document string replace, restricted to documents that mention
      // both one of the fields and the old value. jsonb has no "replace this
      // leaf everywhere" operator, and the alternative — walking every filter
      // shape by hand — is far more code and far more ways to be wrong.
      `UPDATE ${table}
          SET ${column} = replace(${column}::text, $2, $3)::jsonb
        WHERE ${column}::text LIKE '%' || $2 || '%'
          AND ${column}::text ~ $1`,
      [
        `"(${fields.map((f) => f.replace(/[^a-zA-Z0-9_]/g, '')).join('|')})"`,
        JSON.stringify(from),
        JSON.stringify(to),
      ],
    );
    changed += res.rowCount ?? 0;
  }
  return changed;
}
