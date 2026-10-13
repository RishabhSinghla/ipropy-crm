/**
 * A deploy must be able to boot on a database where Associates already exists.
 *
 * On 13 October 2026 every deploy failed for about two hours and the old version
 * kept serving. The container runs migrate, then seed, then starts; the seed had
 * just been taught to create the Associates module, and on production that module
 * already existed — made by migration 175, whose "All Associates" view carries no
 * `seed_key`. The seed did not recognise it, inserted a second, and the unique
 * index on (module, system view name) refused. A fresh test database never shows
 * this, because there the seed creates the module first.
 *
 * So this puts the database in production's shape — the migration's view, with no
 * seed_key — and runs the seed again.
 */
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { seed } from '../../src/db/seed/index.js';

describe('the seed on a database whose Associates module came from migration 175', () => {
  it('runs again without a second "All Associates", and does not lose the one that is there', async () => {
    const module = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'associates'`);
    // Skipped in the (never expected) case that Associates is absent: the seed owns it now.
    if (!module) return;

    await db.query(`UPDATE ipy_view SET seed_key = NULL WHERE module_id = $1 AND is_system = true`, [module.id]);
    const before = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM ipy_view WHERE module_id = $1 AND is_system = true ORDER BY name`, [module.id]);

    await expect(seed()).resolves.not.toThrow();

    const after = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM ipy_view WHERE module_id = $1 AND is_system = true ORDER BY name`, [module.id]);
    expect(after.rows.map((row) => row.name)).toEqual(before.rows.map((row) => row.name));
    expect(after.rows.map((row) => row.id)).toEqual(before.rows.map((row) => row.id));
    expect(after.rows.filter((row) => row.name === 'All Associates')).toHaveLength(1);
  });
});
