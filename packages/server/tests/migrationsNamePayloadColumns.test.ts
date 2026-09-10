/**
 * A migration may not name a payload column it has not made sure of.
 *
 * `ipy_e_leads` and `ipy_e_properties` are the two tables whose columns an
 * administrator adds and removes at runtime. Production's properties table has
 * about twenty columns where `002_entities.sql` declares sixty — the rest were
 * deleted on purpose, and a permanent delete drops the column.
 *
 * Naming a column that is not there is a Postgres 42703 raised at **parse**
 * time, so no `WHERE` clause and no `IF EXISTS` can save the statement. In a
 * migration that is not a broken row, it is a site that never comes up:
 * `docker-entrypoint.sh` runs migrate before the server under `set -e`.
 *
 * Three deploys have died this way — 110 on `city`, 110 again on `bedrooms`,
 * 113 on `area_unit` — and every one of them passed CI, because CI builds
 * these tables from 002 where every column still exists. `columnsThatCanBeDeleted`
 * skips this directory for the same reason: it compares against the local
 * database, which is not the shape that breaks.
 *
 * So this reads the SQL instead of the database. A statement naming a payload
 * column is fine when the same file has just guaranteed it, and fine inside a
 * `DO $$ … EXECUTE …$$` block, where the reference is a string Postgres does
 * not parse until it runs and the block can check `information_schema` first.
 * Anything else is the bug.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../src/db/migrations/', import.meta.url).pathname;

/**
 * From 110 onwards. Everything before it either predates the divergence or has
 * already run everywhere it is going to run — re-litigating history would only
 * teach people to add exemptions.
 */
const FROM = 110;

/** Columns every payload row has by definition; they are the join, not fields. */
const STRUCTURAL = new Set(['record_id', 'custom_fields']);

/** `DO $tag$ … $tag$` — the guarded form, checked by hand inside. */
function stripDoBlocks(sql: string): string {
  return sql.replace(/DO\s+\$(\w*)\$[\s\S]*?\$\1\$/gi, ' /* guarded */ ');
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Columns this file creates before the offset given, so may safely name after it. */
function guaranteedBy(sql: string, upTo: number): Set<string> {
  const out = new Set(STRUCTURAL);
  const re = /ALTER\s+TABLE\s+ipy_e_(?:leads|properties)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?/gi;
  for (const m of sql.slice(0, upTo).matchAll(re)) out.add(m[1].toLowerCase());
  return out;
}

interface Offence { file: string; statement: string; column: string }

function offences(file: string, raw: string): Offence[] {
  const sql = stripDoBlocks(stripComments(raw));
  const found: Offence[] = [];

  // `UPDATE ipy_e_x SET a = …, b = … WHERE …` — the shape all three failures had.
  const re = /UPDATE\s+(ipy_e_(?:leads|properties))\s+SET\s+([\s\S]*?);/gi;
  for (const m of sql.matchAll(re)) {
    const safe = guaranteedBy(sql, m.index ?? 0);
    const body = m[2];
    // Every bare identifier in the statement. Quoted strings go first so a
    // value like 'sqft' is not read as a column name.
    const words = body.replace(/'[^']*'/g, ' ').match(/\b[a-z_][a-z0-9_]*\b/gi) ?? [];
    for (const word of words) {
      const w = word.toLowerCase();
      if (KEYWORDS.has(w) || safe.has(w)) continue;
      // Only flag names that look like payload fields — a function or a table
      // elsewhere in the statement is not what this is looking for.
      if (!PAYLOAD_COLUMNS.has(w)) continue;
      found.push({ file, statement: m[0].slice(0, 90).replace(/\s+/g, ' '), column: w });
    }
  }
  return found;
}

const KEYWORDS = new Set([
  'set', 'where', 'and', 'or', 'is', 'not', 'null', 'from', 'select', 'case', 'when',
  'then', 'else', 'end', 'in', 'exists', 'true', 'false', 'btrim', 'coalesce', 'trim',
  'update', 'jsonb', 'text', 'numeric', 'int', 'integer', 'as', 'on', 'left', 'join',
  'ipy_e_leads', 'ipy_e_properties', 'ipy_module', 'ipy_field', 'id', 'name', 'now',
  'floor', 'regexp_match', 'to_jsonb', 'lower', 'upper', 'nullif', 'count', 'sqft',
]);

/**
 * Names that are payload columns rather than SQL. Read from 002 rather than
 * listed by hand, so it cannot drift — and 002 is the widest possible set,
 * which is exactly the set production may be missing any of.
 */
const PAYLOAD_COLUMNS: Set<string> = (() => {
  const entities = readFileSync(`${DIR}002_entities.sql`, 'utf8');
  const out = new Set<string>();
  for (const table of ['ipy_e_leads', 'ipy_e_properties']) {
    const body = entities.match(new RegExp(`CREATE TABLE ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'))?.[1];
    if (!body) continue;
    for (const line of body.split('\n')) {
      const m = line.trim().match(/^(\w+)\s+[A-Z]/);
      if (m && !STRUCTURAL.has(m[1])) out.add(m[1].toLowerCase());
    }
  }
  return out;
})();

describe('migrations and the columns production may not have', () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => Number(f.slice(0, 3)) >= FROM);

  it('has migrations in range to check', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(PAYLOAD_COLUMNS.size).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${file} guards every payload column it writes`, () => {
      // One line per column per statement: the same name appearing three times
      // in one UPDATE is one mistake, not three.
      const all = offences(file, readFileSync(`${DIR}${file}`, 'utf8'));
      const seen = new Set<string>();
      const found = all.filter((o) => {
        const key = `${o.statement}|${o.column}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const message = found
        .map((o) => `  ${o.column} in: ${o.statement}…`)
        .join('\n');
      expect(
        found,
        found.length
          ? `${file} names a column production may not have:\n${message}\n\n`
            + 'Either ADD COLUMN IF NOT EXISTS it earlier in the same file, or put the\n'
            + 'statement in a DO $$ … EXECUTE … $$ block that checks information_schema first.'
          : undefined,
      ).toEqual([]);
    });
  }
});
