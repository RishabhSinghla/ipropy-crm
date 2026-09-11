/**
 * Two migrations must not share a number.
 *
 * Migrations are applied in filename order and recorded by name, so a
 * duplicate number is not immediately broken — `130_call_note_history.sql` and
 * `130_matching_defaults_found_no_price_or_size.sql` both ran on production,
 * in that order, because `c` sorts before `m`. It is deterministic and it held.
 *
 * What it costs is the ability to reason about order at a glance, and the next
 * pair may not be so lucky: two migrations numbered the same, where one has to
 * run after the other, will order alphabetically rather than by intent — and
 * on a database that has already applied one of them, the second still runs,
 * against a schema its author never saw.
 *
 * The four that already exist are listed rather than fixed. Renaming an
 * applied migration is the one thing that must not happen here: the name is
 * the key in `ipy_migration`, so a renamed file is an unapplied file, and it
 * would run a second time on every database that already has it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';

/** Collisions that predate this test. Applied everywhere; leave them alone. */
const GRANDFATHERED = new Set(['092', '093', '094', '130']);

describe('migration files', () => {
  it('gives each new one a number of its own', () => {
    const dir = new URL('../src/db/migrations/', import.meta.url).pathname;
    const byNumber = new Map<string, string[]>();

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.sql')) continue;
      const number = file.slice(0, file.indexOf('_'));
      byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
    }

    const clashes = [...byNumber.entries()]
      .filter(([number, files]) => files.length > 1 && !GRANDFATHERED.has(number))
      .map(([number, files]) => `${number}: ${files.join(', ')}`);

    expect(
      clashes,
      'Two migrations share a number. Give the newer one the next free number '
      + '— and only if it has never been applied anywhere, because the filename '
      + 'is the key in `ipy_migration` and renaming an applied migration runs it '
      + `again.\n\n${clashes.join('\n')}`,
    ).toEqual([]);
  });

  it('numbers them in a way that sorts', () => {
    const dir = new URL('../src/db/migrations/', import.meta.url).pathname;
    const bad = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      // Three digits, always: `9_x.sql` would sort after `10_x.sql` and run in
      // the wrong order on a fresh database.
      .filter((f) => !/^\d{3}_/.test(f));
    expect(bad, `These do not start with three digits and an underscore:\n${bad.join('\n')}`).toEqual([]);
  });
});
