/**
 * Changing the type of a field that is a real column.
 *
 * The field editor used to refuse this outright, with a message telling the
 * admin to add a second field and delete the first — "Locality is stored as
 * multipicklist, so it can only become JSON, Address, Multi Lookup, Tags".
 * That is a workaround, not an answer: the new field has a different API name,
 * so every saved view, filter, workflow and integration that named the old one
 * has to be rebuilt by hand, and the values do not come across at all.
 *
 * What actually stands in the way is one `ALTER TABLE … TYPE … USING`, and the
 * honest part of the old refusal — that some conversions cannot carry every
 * value. A date column becoming text loses nothing; text becoming a date loses
 * every cell that was never a date. So this does both halves:
 *
 *   1. **Count first.** Every conversion is dry-run over the real rows before
 *      anything changes, and reports how many values would not survive. The
 *      caller refuses unless it was told to accept the loss.
 *   2. **Never raise.** Every cast goes through the `ipy_try_*` helpers from
 *      migration 112, so a value that cannot convert becomes NULL rather than
 *      failing the statement — which on a table of ten thousand rows is the
 *      difference between "412 values will be cleared" and "nothing happened
 *      and I cannot tell you why".
 *
 * A multi-select becoming a single dropdown keeps the first choice, because
 * that is what "this record picked one of these" means. It is reported as a
 * loss when any record had more than one.
 */
import type { Tx } from '../../db/pool.js';
import { COLUMN_TYPES } from './fieldTypes.js';

/** Types whose JSONB column holds a list of strings. */
const LIST_TYPES = new Set(['multipicklist', 'multireference', 'tags']);

export interface ConversionPlan {
  /** SQL that turns the old column's value into the new type. `%s` is the column reference. */
  using: string;
  /** SQL predicate matching rows whose value will not survive. `%s` is the column reference. */
  lossy: string | null;
  /** What the admin is told before they confirm. */
  note: string | null;
}

/**
 * How to get from one field type to another, or null when there is no sane
 * route. Keyed on the SQL types, not the field types, because Email → Text and
 * Phone → Text are the same problem and there are thirty-two field types.
 */
export function conversionPlan(fromType: string, toType: string): ConversionPlan | null {
  const from = COLUMN_TYPES[fromType];
  const to = COLUMN_TYPES[toType];
  if (!from || !to) return null;
  if (from === to) return { using: '%s', lossy: null, note: null };

  const fromList = LIST_TYPES.has(fromType);
  const toList = LIST_TYPES.has(toType);

  // A list of choices becoming one choice: keep the first, and say so.
  if (fromList && to === 'TEXT') {
    return {
      using: `CASE WHEN jsonb_typeof(%s) = 'array' THEN NULLIF(%s ->> 0, '')
                   ELSE NULLIF(%s #>> '{}', '') END`,
      lossy: `jsonb_typeof(%s) = 'array' AND jsonb_array_length(%s) > 1`,
      note: 'Records that had more than one value keep the first — the rest are cleared.',
    };
  }
  // One choice becoming a list of choices: nothing is lost.
  if (!fromList && toList && from === 'TEXT') {
    return {
      using: `CASE WHEN %s IS NULL OR btrim(%s) = '' THEN '[]'::jsonb ELSE jsonb_build_array(%s) END`,
      lossy: null,
      note: null,
    };
  }
  // Anything at all becoming free-form JSON.
  if (to === 'JSONB' && !toList) {
    return { using: `to_jsonb(%s)`, lossy: null, note: null };
  }
  // A number, date or flag becoming text: every value has a printed form.
  if (to === 'TEXT' && !fromList) {
    return { using: `%s::text`, lossy: null, note: null };
  }

  // Text (or a number's text) becoming something stricter. This is the
  // direction that loses values, and the only one the count really matters for.
  const guarded: Record<string, string> = {
    INTEGER: 'ipy_try_int(%s::text)',
    NUMERIC: 'ipy_try_numeric(%s::text)',
    DATE: 'ipy_try_date(%s::text)',
    TIMESTAMPTZ: 'ipy_try_timestamptz(%s::text)',
    UUID: 'ipy_try_uuid(%s::text)',
    BOOLEAN: 'ipy_try_bool(%s::text)',
  };
  const cast = guarded[to];
  if (!cast || fromList) return null;

  return {
    using: cast,
    lossy: `%s IS NOT NULL AND ${cast} IS NULL`,
    note: 'Values that are not a valid ' + toType + ' are cleared.',
  };
}

function fill(template: string, columnRef: string): string {
  return template.split('%s').join(columnRef);
}

export interface ConversionCheck {
  plan: ConversionPlan;
  /** Rows whose value will not survive the change. */
  lossyRows: number;
}

/** Dry run: what would this cost, in rows? Reads only. */
export async function checkConversion(
  conn: Tx, table: string, column: string, fromType: string, toType: string,
): Promise<ConversionCheck | null> {
  const plan = conversionPlan(fromType, toType);
  if (!plan) return null;
  if (!plan.lossy) return { plan, lossyRows: 0 };

  const ref = `"${column}"`;
  const row = await conn.queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM "${table}" WHERE ${fill(plan.lossy, ref)}`,
  );
  return { plan, lossyRows: row?.n ?? 0 };
}

/**
 * Do it. Caller has already checked the cost and the permission.
 *
 * The default comes off before the type changes and goes back on after: a
 * `DEFAULT '[]'::jsonb` cannot survive the column becoming TEXT, and Postgres
 * refuses the ALTER rather than dropping it for you. NOT NULL is handled the
 * same way — the list types require it (an empty list is a value, not a null),
 * everything else must allow a null, because a value that could not convert is
 * now one.
 */
export async function convertColumn(
  conn: Tx, table: string, column: string, fromType: string, toType: string,
): Promise<void> {
  const plan = conversionPlan(fromType, toType);
  if (!plan) throw new Error(`No conversion from ${fromType} to ${toType}`);
  const sqlType = COLUMN_TYPES[toType];
  const ref = `"${column}"`;
  const t = `"${table}"`;

  await conn.query(`ALTER TABLE ${t} ALTER COLUMN ${ref} DROP DEFAULT`);
  await conn.query(`ALTER TABLE ${t} ALTER COLUMN ${ref} DROP NOT NULL`);
  await conn.query(`ALTER TABLE ${t} ALTER COLUMN ${ref} TYPE ${sqlType} USING ${fill(plan.using, ref)}`);

  if (LIST_TYPES.has(toType)) {
    await conn.query(`UPDATE ${t} SET ${ref} = '[]'::jsonb WHERE ${ref} IS NULL`);
    await conn.query(`ALTER TABLE ${t} ALTER COLUMN ${ref} SET DEFAULT '[]'::jsonb`);
    await conn.query(`ALTER TABLE ${t} ALTER COLUMN ${ref} SET NOT NULL`);
  }
}
