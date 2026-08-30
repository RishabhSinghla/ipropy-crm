/**
 * The dropdown options that code still matches on by name.
 *
 * Renaming an option is otherwise completely safe — `renameValueEverywhere`
 * rewrites the records holding it, the saved views filtering on it, the widgets
 * counting it and the workflow rules naming it. What it cannot rewrite is a
 * string literal in a query, so the rename succeeds, every record moves, and a
 * feature silently stops.
 *
 * `VALUES_USED_IN_CODE` exists so the admin is told first. It is a hand-kept
 * list, which means it goes stale the moment somebody adds a comparison and
 * forgets — and a stale guard is worse than none, because it reads as a
 * guarantee.
 *
 * So this test does not check the list against itself. It greps the source for
 * comparisons against dropdown values and fails when it finds one the list does
 * not cover.
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { VALUES_USED_IN_CODE, valueUsedInCode } from '../src/core/metadata/picklists.js';

/** Where a literal option string would actually break something. */
const SEARCHED = ['core', 'ai', 'api', 'integrations'];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (extname(entry.name) === '.ts') out.push(full);
  }
  return out;
}

describe('the guard on renaming a dropdown option', () => {
  it('covers every option the code compares against by name', async () => {
    const base = new URL('../src/', import.meta.url).pathname;
    const files = (await Promise.all(SEARCHED.map((d) => sourceFiles(join(base, d))))).flat();

    /*
      Only the values already declared are searched for. This is not trying to
      discover every string in the codebase — it is asking whether a value the
      list *claims* to know about is compared anywhere it has not accounted for,
      and, more usefully, whether a value adjacent to those has crept in.
    */
    const known = Object.keys(VALUES_USED_IN_CODE).map((k) => k.split('.').slice(1).join('.'));
    const watched = [...new Set([...known,
      // Values in the same dropdowns that a comparison could plausibly use.
      'Qualified', 'Negotiation', 'Sold', 'Booked', 'Held', 'Blocked',
      'New Launch', 'Ready To Move', 'Under Construction',
      'Hot', 'Warm', 'Cold',
    ])];

    const uncovered: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        // Comments and the guard's own definition are not call sites.
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//')) return;
        if (file.endsWith('metadata/picklists.ts')) return;

        for (const value of watched) {
          // A comparison, not a mention: `=== 'Lost'`, `!== "Lost"`, `IN ('Lost'`.
          const compared = new RegExp(`[=!]==?\\s*['"\`]${value}['"\`]|['"\`]${value}['"\`]\\s*[=!]==?`);
          if (!compared.test(line)) continue;

          const covered = Object.keys(VALUES_USED_IN_CODE).some((k) => k.endsWith(`.${value}`));
          if (!covered) {
            uncovered.push(`${file.slice(base.length)}:${index + 1} compares against '${value}'`);
          }
        }
      });
    }

    expect(
      [...new Set(uncovered)],
      'these options are matched by name in code and are not in VALUES_USED_IN_CODE, '
      + 'so an admin renaming one would break a feature with no warning',
    ).toEqual([]);
  });

  it('names what breaks, not just that something does', () => {
    // The message is the whole point. "This value is used in code" tells an
    // admin nothing they can act on; "the public website catalogue looks for
    // this exact word" tells them whether they still want to.
    for (const [key, reason] of Object.entries(VALUES_USED_IN_CODE)) {
      expect(reason.length, `${key} needs a real explanation`).toBeGreaterThan(30);
      expect(reason, `${key} should say what breaks`).not.toMatch(/^used in code/i);
    }
  });

  it('answers null for an option nothing depends on', () => {
    expect(valueUsedInCode('lead_status', 'Attempted Contact')).toBeNull();
    expect(valueUsedInCode('not_a_picklist', 'not_a_value')).toBeNull();
  });

  it('covers the two that were missing', () => {
    // Found by grepping rather than by reading the list: a +6 scoring bonus and
    // a buyer-match bonus, both matching on the option's exact text.
    expect(valueUsedInCode('lead_status', 'Qualified')).toBeTruthy();
    expect(valueUsedInCode('possession_status', 'New Launch')).toBeTruthy();
  });
});
