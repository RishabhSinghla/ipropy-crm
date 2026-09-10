/**
 * A field somebody renamed must not reappear under its old name.
 *
 * The owner: "why CRM keeps on bringing those fields back somewhere or the
 * other inside of it after removing from fields — this is so bad."
 *
 * They were never coming back from a deletion. They were coming back from a
 * **rename**. `upsertField` conflicts on `(module_id, name)`, and a rename
 * changes the name while never touching `column_name` — records live under the
 * column, which is what makes a rename safe in the first place. So a renamed
 * field is invisible to that conflict, the template inserts a fresh row under
 * the original name, and the module ends up with two fields writing one column.
 *
 * That is worse than a cosmetic duplicate. Both fields read and write the same
 * storage, so the same value shows in two places on the form and whichever a
 * rep edits last wins. Production had four such pairs on Properties alone:
 * full_name/name, assigned_to/owner_id, block_tower/tower, demand/base_price.
 *
 * The seed runs on every cold start, so on the free tier this happened about
 * once an hour.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';

/** A seeded, column-backed field that no other test leans on. */
const FIELD = 'furnishing';
const RENAMED = 'how_it_comes';

let original: { id: string; name: string; column_name: string } | null = null;

beforeAll(async () => {
  original = await db.queryOne<{ id: string; name: string; column_name: string }>(
    `SELECT f.id, f.name, f.column_name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
      WHERE m.name = 'properties' AND f.name = $1`,
    [FIELD],
  );
});

afterAll(async () => {
  if (!original) return;
  // Put the name back and clear anything the test left beside it.
  await db.query(
    `DELETE FROM ipy_field WHERE module_id = (SELECT module_id FROM ipy_field WHERE id = $1)
       AND column_name = $2 AND id <> $1`,
    [original.id, original.column_name],
  );
  await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [original.id, original.name]);
  registry.invalidate();
});

describe('a renamed field and the next cold start', () => {
  it('is not duplicated by the seed', async () => {
    if (!original) return; // the field has been deleted on this database; nothing to prove

    await db.query(`UPDATE ipy_field SET name = $2, is_customised = true WHERE id = $1`,
      [original.id, RENAMED]);
    registry.invalidate();

    // What docker-entrypoint.sh does on every boot.
    const { seed } = await import('../../src/db/seed/index.js');
    await seed();
    registry.invalidate();

    const onThatColumn = await db.query<{ name: string }>(
      `SELECT f.name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'properties' AND f.column_name = $1 ORDER BY f.name`,
      [original.column_name],
    );

    // One column, one field. Two would mean the same value on screen twice,
    // with each edit overwriting the other.
    expect(onThatColumn.rows.map((r) => r.name)).toEqual([RENAMED]);
  });
});
