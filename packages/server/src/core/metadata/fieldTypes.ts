/**
 * The SQL type behind each column-backed field type.
 *
 * Two things need this and used to disagree about it: the seed, which puts back
 * a column the metadata expects, and the field editor, which has to decide
 * whether changing a field's type is something the database can survive.
 *
 * Mirrors what migrations 002 onwards actually created — verified against the
 * live schema, not guessed.
 */
export const COLUMN_TYPES: Record<string, string> = {
  string: 'TEXT', textarea: 'TEXT', richtext: 'TEXT', email: 'TEXT', phone: 'TEXT',
  url: 'TEXT', autonumber: 'TEXT', image: 'TEXT', time: 'TEXT',
  integer: 'INTEGER', score: 'INTEGER',
  decimal: 'NUMERIC', currency: 'NUMERIC', percent: 'NUMERIC', area: 'NUMERIC',
  boolean: 'BOOLEAN', date: 'DATE', datetime: 'TIMESTAMPTZ',
  reference: 'UUID', owner: 'UUID', user: 'UUID',
  json: 'JSONB', address: 'JSONB', multipicklist: 'JSONB', multireference: 'JSONB', tags: 'JSONB',
  picklist: 'TEXT',
};

/**
 * Field types this one can become without touching the database.
 *
 * A field an admin created lives in `custom_fields`, which is JSONB and holds
 * anything, so it can become any type at all. A built-in field is a real column
 * with a real type: Email and Text are both `TEXT`, so swapping between them
 * changes nothing but validation, while Date and Text are not, and writing "not
 * sure yet" into a `DATE` column fails on the row rather than on the form.
 *
 * Returning the list rather than a yes/no is deliberate: an admin told "no"
 * still has to guess what would work.
 */
export function interchangeableTypes(uitype: string): string[] {
  const sql = COLUMN_TYPES[uitype];
  if (!sql) return [uitype];
  return Object.entries(COLUMN_TYPES)
    .filter(([, t]) => t === sql)
    .map(([u]) => u);
}
