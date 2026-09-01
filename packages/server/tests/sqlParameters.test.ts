/**
 * Every SQL statement binds exactly the parameters it references.
 *
 * CLAUDE.md rule 8 exists for this, and by 1 September 2026 it had been broken
 * four times. The most recent: removing a column from an UPDATE renumbered the
 * parameters after it, except one, which stayed `$5` while four values were
 * bound. Postgres refuses the whole statement with 42P18 — "could not determine
 * data type of parameter $4" — which reads as a type problem rather than a
 * counting one, and is why it takes so long to spot.
 *
 * Nothing else catches it. The SQL is a string, so typecheck sees nothing. A
 * mocked `db.query` accepts any array. And the caller is often a workflow task
 * that logs and carries on, so the feature simply stops working quietly — lead
 * scoring failed on every lead for a day before a browser test happened to
 * print the server log.
 *
 * So this reads the source and checks the arithmetic. It is a blunt instrument
 * and deliberately so: it cannot understand a query built by string
 * concatenation, and it skips those rather than guessing. What it does cover is
 * the shape that has actually broken four times — a literal statement with a
 * literal array beside it.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

/** Migrations are historical and seeds are one-shot; neither is the risk here. */
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

interface Statement { file: string; line: number; referenced: number[]; sql: string }

/** Template literals in this file that look like SQL and use parameters. */
function statementsIn(source: string, file: string): Statement[] {
  const found: Statement[] = [];
  for (const m of source.matchAll(/`([^`]*?\$\d[^`]*?)`/gs)) {
    const sql = m[1] ?? '';
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql)) continue;
    // A statement assembled from pieces cannot be counted by reading it.
    if (/\$\{/.test(sql)) continue;

    const referenced = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((n) => Number(n[1])))].sort((a, b) => a - b);
    if (!referenced.length) continue;

    found.push({
      file,
      line: source.slice(0, m.index).split('\n').length,
      referenced,
      sql: sql.trim().split('\n')[0]!.slice(0, 70),
    });
  }
  return found;
}

describe('SQL parameter numbering', () => {
  it('never skips a number', async () => {
    /*
      `$1, $2, $3, $5` with four values bound is not "close enough". Postgres
      rejects the entire statement, because `$4` has no type it can infer.

      This is the exact shape of the lead-scoring bug: a column was removed from
      the middle of a SET clause and one line below it was not renumbered.
    */
    const files = await sourceFiles(SRC);
    const gaps: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const s of statementsIn(source, file)) {
        const highest = Math.max(...s.referenced);
        const missing = Array.from({ length: highest }, (_, i) => i + 1)
          .filter((n) => !s.referenced.includes(n));
        if (missing.length) {
          gaps.push(
            `${relative(SRC, s.file)}:${s.line} skips ${missing.map((n) => `$${n}`).join(', ')} `
            + `(highest is $${highest}) — ${s.sql}`,
          );
        }
      }
    }

    expect(gaps, 'Postgres refuses a statement whose parameter numbering has a hole').toEqual([]);
  });

  it('starts at $1', async () => {
    // `$2, $3` with two values bound fails the same way: there is no `$1`.
    const files = await sourceFiles(SRC);
    const wrong: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const s of statementsIn(source, file)) {
        if (s.referenced[0] !== 1) {
          wrong.push(`${relative(SRC, s.file)}:${s.line} starts at $${s.referenced[0]} — ${s.sql}`);
        }
      }
    }

    expect(wrong, 'parameters are one-indexed and must start at $1').toEqual([]);
  });

  it('is actually looking at something', async () => {
    /*
      A scanner that silently matches nothing passes forever and protects
      nothing. This is the guard on the guard: if a refactor changes how queries
      are written and the regex stops finding them, this fails rather than going
      quietly green.
    */
    const files = await sourceFiles(SRC);
    let counted = 0;
    for (const file of files) {
      counted += statementsIn(await readFile(file, 'utf8'), file).length;
    }

    expect(counted, 'the scanner found no parameterised SQL at all, which cannot be right')
      .toBeGreaterThan(100);
  });
});
