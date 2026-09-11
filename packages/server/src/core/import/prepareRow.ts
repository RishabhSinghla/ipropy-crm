/**
 * One spreadsheet row, turned into the values a record is made of.
 *
 * This is lifted out of the import loop for one reason: the wizard has to be
 * able to show what a file will do *before* it does it, and a preview that
 * computes its answer differently from the importer is worse than no preview —
 * it is a promise the import then breaks.
 */
import type { FieldMeta } from '@ipropy/shared';
import { normaliseForField, type NormaliseContext } from './normalise.js';
import { resolvePerson, type People } from './people.js';

export interface PreparedRow {
  values: Record<string, unknown>;
  /** Cells that could not be read. The row fails with these rather than with a Postgres sentence. */
  unreadable: string[];
}

export interface PrepareOptions {
  mapping: Record<string, string>;
  fields: FieldMeta[];
  /** Spelling corrections per field: "sector 21" → "Sector 21". */
  canonical: Map<string, Map<string, string>>;
  /** Fields whose cell holds a list rather than one value. */
  multiValued: Set<string>;
  ctx: NormaliseContext;
  /** Colleagues by name and email, for an Assigned To column. */
  people?: People;
}

export function prepareRow(raw: Record<string, string>, opts: PrepareOptions): PreparedRow {
  const values: Record<string, unknown> = {};
  const unreadable: string[] = [];

  for (const [header, fieldName] of Object.entries(opts.mapping)) {
    if (!fieldName) continue;
    const v = raw[header];
    if (v === undefined || v === '') continue;

    /*
      Presentation is corrected before the value is validated.

      A leading zero on a mobile, `₹` and commas on a price, `Sq Yard` for the
      unit, `15-03-2026` for the date: all of these are how somebody typed the
      value, not what it means. The record API is strict for good reasons and
      stays strict; this is the one place that is lenient, and a cell it
      genuinely cannot read fails the row with a sentence naming the column
      rather than a raw database error.
    */
    const fieldMeta = opts.fields.find((f) => f.name === fieldName);

    /*
      An owner column holds a person's name, never their id.

      The record API is right to insist on an id — it is a foreign key. But a
      file saying "Rakesh" used to fail every single row with "Assigned To must
      reference a valid record", which is true and useless. Resolved here, and
      named here when it cannot be: "there is nobody here called Rakesh" is
      something an admin can act on.
    */
    if (fieldMeta && (fieldMeta.uitype === 'owner' || fieldMeta.uitype === 'user') && opts.people) {
      const who = resolvePerson(v, opts.people);
      if (who.problem) { unreadable.push(`${header}: ${who.problem}`); continue; }
      if (who.id) { values[fieldName] = who.id; continue; }
    }

    let cell: unknown = v;
    if (fieldMeta) {
      const read = normaliseForField(fieldMeta, v, opts.ctx);
      if (read.problem) { unreadable.push(`${header}: ${read.problem}`); continue; }
      if (read.value !== null && read.value !== undefined) cell = read.value;
    }

    const fix = opts.canonical.get(fieldName);
    if (!fix) { values[fieldName] = cell; continue; }
    // Corrected to the option's own spelling, so "neharpar" and "NEHARPAR" do
    // not become two localities. Multi-select cells value by value; a single
    // dropdown is one lookup and is never split.
    values[fieldName] = opts.multiValued.has(fieldName)
      ? String(cell).split(/[;,]/).map((part) => fix.get(part.trim()) ?? part.trim())
        .filter(Boolean).join('; ')
      : (fix.get(String(cell).trim()) ?? cell);
  }

  return { values, unreadable };
}

/** A column in the file always wins over a value set for the whole file. */
export function applyStaticValues(
  values: Record<string, unknown>, staticValues: Record<string, unknown>,
): void {
  for (const [name, value] of Object.entries(staticValues)) {
    if (values[name] === undefined) values[name] = value;
  }
}
