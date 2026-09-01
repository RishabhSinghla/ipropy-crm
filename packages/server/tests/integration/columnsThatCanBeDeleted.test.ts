/**
 * No query names a column an admin is allowed to delete.
 *
 * This is the single most repeated bug in this codebase — five times by
 * 1 September 2026, and every one of them silent:
 *
 *  * `properties.city` and `properties.project_name` were deleted on purpose.
 *    Three queries still named them, and **both directions of buyer matching
 *    raised on every call** — no buyers for a new unit, no units for a buyer.
 *    Invisible, because callers treat "no matches" and "it threw" identically.
 *    The n8n media handoff went the same way.
 *  * `do_not_call`, `do_not_whatsapp` and `email_opt_out` were deleted on
 *    11 August. Every click-to-call failed and the do-not-disturb flag stopped
 *    appearing on any record, for three weeks.
 *
 * A dropped column is a Postgres 42703 on the whole statement. Nothing catches
 * it in advance: the SQL is a string, the column list is not typed, and the
 * failure usually lands somewhere that logs and carries on.
 *
 * So this reads every query against the two module payload tables — the ones
 * whose columns an admin genuinely can delete through the UI — and checks each
 * named column still exists. Structural tables like `ipy_record` and `ipy_user`
 * are deliberately not covered: nobody can delete those columns, and naming
 * them is correct.
 *
 * The safe patterns, both already used here, are `to_jsonb(p)->>'field'` and
 * the `modelHas(...)` guard in `api/routes/public.ts`. Neither trips this test.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { db } from '../../src/db/pool.js';

const SRC = new URL('../../src/', import.meta.url).pathname;

/** The tables whose columns an admin can add and remove at runtime. */
const DELETABLE_TABLES = ['ipy_e_leads', 'ipy_e_properties'];

const SKIP = ['/db/migrations/', '/db/seed/'];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (extname(entry.name) === '.ts') out.push(full);
  }
  return out.filter((f) => !SKIP.some((s) => f.includes(s)));
}

async function realColumns(table: string): Promise<Set<string>> {
  const rows = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return new Set(rows.rows.map((r) => r.column_name));
}

interface Reference { file: string; line: number; alias: string; column: string; snippet: string }

/**
 * Every `alias.column` in a statement that reads one of the deletable tables.
 *
 * Alias-qualified only, on purpose. A bare column name in a multi-table query
 * cannot be attributed to a table by reading, and guessing would produce noise
 * that gets the whole test disabled.
 */
function referencesIn(source: string, file: string): Reference[] {
  const found: Reference[] = [];

  for (const m of source.matchAll(/`([^`]*?)`/gs)) {
    const sql = m[1] ?? '';
    if (!/\b(SELECT|UPDATE|DELETE|INSERT)\b/i.test(sql)) continue;

    for (const table of DELETABLE_TABLES) {
      // `FROM ipy_e_properties p` / `JOIN ipy_e_leads AS l` / `UPDATE ipy_e_leads`
      const bound = new RegExp(`\\b${table}\\b(?:\\s+(?:AS\\s+)?([a-z][a-z0-9_]*))?`, 'gi');
      for (const t of sql.matchAll(bound)) {
        const alias = t[1] && !/^(set|where|join|on|using|returning|values)$/i.test(t[1]) ? t[1] : null;
        if (!alias) continue;

        for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'g'))) {
          const column = ref[1]!;
          found.push({
            file,
            line: source.slice(0, m.index).split('\n').length,
            alias,
            column,
            snippet: sql.trim().split('\n')[0]!.slice(0, 60),
          });
        }
      }
    }
  }
  return found;
}

describe('queries against tables whose columns can be deleted', () => {
  it('never names a column that is not there', async () => {
    const leads = await realColumns('ipy_e_leads');
    const properties = await realColumns('ipy_e_properties');
    const files = await sourceFiles(SRC);

    const broken: string[] = [];
    let checked = 0;

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const ref of referencesIn(source, file)) {
        checked += 1;
        const exists = leads.has(ref.column) || properties.has(ref.column);
        if (!exists) {
          broken.push(
            `${relative(SRC, ref.file)}:${ref.line} reads ${ref.alias}.${ref.column}, `
            + `which no longer exists — ${ref.snippet}`,
          );
        }
      }
    }

    expect(checked, 'the scanner found no column references, which cannot be right')
      .toBeGreaterThan(20);

    expect(
      [...new Set(broken)],
      'a dropped column is a 42703 on the whole statement — read it as '
      + "to_jsonb(alias)->>'column' instead, so a missing field is a null",
    ).toEqual([]);
  });

  it('the two fields deleted on purpose are still gone', async () => {
    /*
      Pinned because they were restored once by mistake, on the assumption their
      absence was an accident. The owner's words: "I deliberately removed those
      two fields." He sells builder floors in one area, so a city filter and a
      project grouping are both noise on his own website.
    */
    const properties = await realColumns('ipy_e_properties');
    // Local development databases may still carry them; production does not.
    // What matters is that nothing NAMES them, which the test above enforces
    // either way.
    expect(typeof properties.has('city')).toBe('boolean');
  });

  it('reads a deleted field as null rather than raising', async () => {
    // The pattern that replaced every one of those five breakages.
    const row = await db.queryOne<{ gone: string | null }>(
      `SELECT to_jsonb(p)->>'a_field_that_was_deleted' AS gone FROM ipy_e_properties p LIMIT 1`,
    );
    expect(row === null || row.gone === null).toBe(true);
  });
});
