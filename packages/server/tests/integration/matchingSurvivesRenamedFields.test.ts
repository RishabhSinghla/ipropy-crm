/**
 * Buyer matching, when the fields it compares have been *renamed*.
 *
 * The sibling file next to this one covers deletion. This one covers the other
 * half of the same habit, and it is the more common one: the owner renames
 * fields constantly, and a rename moves `ipy_field.name` while `column_name`
 * stays exactly where it was. Production has carried `demand`,
 * `preferred_locations` and `area_size` for months on top of the `base_price`,
 * `locality` and `carpet_area` columns they have always used.
 *
 * That gap is invisible on a fresh install, where every field's name and column
 * are the same string, so a test shaped like this laptop cannot see it — which
 * is how a mapping keyed by name passed everything and would still have scored
 * one criterion of four against the real database.
 *
 * The failure mode is the dangerous kind: not an exception, but a confident
 * percentage computed from fewer facts than it claims.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { matchingConfig, invalidateMatchingConfig } from '../../src/core/settings/matching.js';

/** name → the name it is being given for the duration of this file. */
const RENAMES: { module: string; from: string; to: string }[] = [
  { module: 'properties', from: 'base_price', to: 'qa_demand' },
  { module: 'properties', from: 'locality', to: 'qa_preferred_locations' },
];
const applied: { module: string; from: string; to: string }[] = [];

async function rename(module: string, from: string, to: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE ipy_field f SET name = $3 FROM ipy_module m
      WHERE m.id = f.module_id AND m.name = $1 AND f.name = $2`,
    [module, from, to],
  );
  return Boolean(res.rowCount);
}

beforeAll(async () => {
  for (const r of RENAMES) if (await rename(r.module, r.from, r.to)) applied.push(r);
  const { registry } = await import('../../src/core/metadata/registry.js');
  registry.invalidate();
  invalidateMatchingConfig();
});

afterAll(async () => {
  // The suite shares one database, so the names go back before anything else
  // reads them.
  for (const r of applied.reverse()) await rename(r.module, r.to, r.from);
  const { registry } = await import('../../src/core/metadata/registry.js');
  registry.invalidate();
  invalidateMatchingConfig();
});

describe('buyer matching with fields renamed', () => {
  it('still resolves every mapped pair to a column that exists', async () => {
    if (!applied.length) return; // nothing to rename means nothing to prove

    const config = await matchingConfig();
    expect(config.fieldMap.length).toBeGreaterThan(0);

    const columns = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('ipy_e_leads', 'ipy_e_properties')`,
    );
    const leadColumns = new Set(columns.rows.filter((c) => c.table_name === 'ipy_e_leads').map((c) => c.column_name));
    const propertyColumns = new Set(columns.rows.filter((c) => c.table_name === 'ipy_e_properties').map((c) => c.column_name));

    for (const pair of config.fieldMap) {
      // A JSON-stored field lives inside custom_fields and has no column of its
      // own; a column-stored one must name a column that is really there.
      if (pair.contactStorage !== 'json') {
        expect(leadColumns.has(pair.contactColumn ?? pair.contactField)).toBe(true);
      }
      if (pair.propertyStorage !== 'json') {
        expect(propertyColumns.has(pair.propertyColumn ?? pair.propertyField)).toBe(true);
      }
    }
  });

  it('keeps the renamed field mapped, rather than dropping the pair', async () => {
    if (!applied.length) return;

    const config = await matchingConfig();
    const renamedNames = new Set(applied.map((r) => r.to));
    const touched = config.fieldMap.filter((p) => renamedNames.has(p.propertyField));

    // The point of a permanent field ID: the pair survives the rename and is
    // still pointed at the same column underneath.
    expect(touched.length).toBe(applied.length);
    for (const pair of touched) {
      expect(pair.propertyColumn).toBeTruthy();
      expect(pair.propertyColumn).not.toBe(pair.propertyField);
    }
  });
});
