/**
 * Every field the rename guard protects is a field that actually exists.
 *
 * `FIELDS_USED_IN_CODE` is the list that stops an admin renaming something the
 * engine depends on. It is hand-written, and it had drifted: six of its
 * twenty-eight names pointed at nothing.
 *
 * Four of those were fields deleted on purpose, which is harmless — the guard
 * simply lies dormant, and wakes up correctly if the field is ever added back.
 *
 * The other two were typos, and they were the two that mattered most:
 *
 *  * `properties.price` — the real field is `base_price`. So the one price the
 *    matcher, the comparables, the drafted first reply and every figure on the
 *    public website all read was **completely unguarded**. An admin renaming
 *    "Base Price" would have been allowed to, and buyer matching would have gone
 *    quiet with nothing said.
 *  * `properties.unit_no` — the real field is `name`, which is what a property's
 *    label is built from and therefore what names its OneDrive folder.
 *
 * A guard that names a field that does not exist is worse than no guard, because
 * it reads as protection. So the rule enforced here is narrow and exact: a
 * guarded name must either exist, or be tombstoned. Neither means a typo.
 */
import { describe, expect, it } from 'vitest';
import { FIELDS_USED_IN_CODE } from '../../src/core/metadata/fieldRename.js';
import { db } from '../../src/db/pool.js';

describe('the rename guard', () => {
  it('never protects a field name that does not exist', async () => {
    const typos: string[] = [];

    for (const key of Object.keys(FIELDS_USED_IN_CODE)) {
      const [moduleName, fieldName] = key.split('.');
      expect(moduleName && fieldName, `"${key}" is not module.field`).toBeTruthy();

      const field = await db.queryOne<{ n: string }>(
        `SELECT count(*) AS n FROM ipy_field f
           JOIN ipy_module m ON m.id = f.module_id
          WHERE m.name = $1 AND f.name = $2`,
        [moduleName, fieldName],
      );

      // A field can be storage='json' and have no column, so metadata is the
      // primary check; the column is a fallback for anything the registry has
      // not caught up with.
      const column = await db.queryOne<{ n: string }>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        [`ipy_e_${moduleName}`, fieldName],
      );

      // Deliberately deleted is fine. The guard lies dormant and comes back to
      // life correctly if the field is ever restored.
      const tombstoned = await db.queryOne<{ n: string }>(
        `SELECT count(*) AS n FROM ipy_field_tombstone
          WHERE module_name = $1 AND field_name = $2`,
        [moduleName, fieldName],
      );

      const exists = Number(field?.n) > 0 || Number(column?.n) > 0;
      const deleted = Number(tombstoned?.n) > 0;

      if (!exists && !deleted) {
        typos.push(
          `${key} — no such field, and no tombstone either, so it was never `
          + `deleted on purpose. This guard protects nothing.`,
        );
      }
    }

    expect(
      typos,
      'a guarded name that matches no field is a typo, and it reads as protection '
      + 'while giving none — the whole point of the list is to refuse a rename',
    ).toEqual([]);
  });

  it('guards the price the matcher and the website actually read', async () => {
    // Pinned by name because this is the one that was wrong. `base_price` is
    // read by ai/matching.ts, ai/comparables.ts, ai/firstReply.ts and
    // core/storage/propertyDetails.ts.
    expect(Object.keys(FIELDS_USED_IN_CODE)).toContain('properties.base_price');

    const real = await db.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM ipy_field f
         JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'properties' AND f.name = 'base_price'`,
    );
    expect(Number(real?.n), 'base_price is the real field; price never existed').toBe(1);
  });
});
