/**
 * Renaming the Area field does not empty its unit list.
 *
 * Same shape as the dropdown bug next door, and it bites harder.
 * `renameFieldEverywhere` string-replaces the old field name across every
 * field's `config`, which is right — a config names other fields in
 * `dependsOn`, in formula operands, in visibility rules.
 *
 * But `unitMaster` holds a *kind*, 'area' or 'budget_demand', not a field
 * name. Renaming Area to Area / Size wrote `unitMaster: 'area_size'`, which
 * matches no master, so `syncUnitMasters` filled in nothing and the Sq Ft /
 * Sq Yd / Bigha list came back empty — on a field whose whole purpose is to
 * carry a unit. Renaming Demand to Base Price did it to Cr and Lac.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { renameFieldEverywhere } from '../../src/core/metadata/fieldRename.js';
import { registry } from '../../src/core/metadata/registry.js';

let moduleId = '';
let fieldId = '';
let original = '';
const RENAMED = `area_size_qa_${Date.now().toString(36)}`;

beforeAll(async () => {
  await registry.warmup();
  const row = await db.queryOne<{ id: string; module_id: string; name: string }>(
    `SELECT f.id, f.module_id, f.name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
      WHERE m.name = 'leads' AND f.uitype = 'area' AND f.config ? 'unitMaster' AND f.is_active
      ORDER BY f.sequence LIMIT 1`);
  if (!row) throw new Error('no area field with a unit master to rename');
  moduleId = row.module_id; fieldId = row.id; original = row.name;
});

afterAll(async () => {
  await renameFieldEverywhere(moduleId, 'leads', RENAMED, original).catch(() => undefined);
  await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [fieldId, original]);
  registry.invalidate();
});

describe('renaming a field that carries a unit', () => {
  it('keeps pointing at the unit master, which is a kind and not a field', async () => {
    await renameFieldEverywhere(moduleId, 'leads', original, RENAMED);
    await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [fieldId, RENAMED]);
    registry.invalidate();

    const after = await db.queryOne<{ master: string; unit_field: string }>(
      `SELECT config->>'unitMaster' AS master, config->>'unitField' AS unit_field
         FROM ipy_field WHERE id = $1`, [fieldId]);
    expect(after?.master, 'a kind, not the new field name').toBe('area');
    expect(after?.unit_field, 'and the companion it points at is a field name, so it follows renames')
      .toBe('unit_field' in (after ?? {}) ? after!.unit_field : 'area_unit');

    // The point of all of it: the field still offers the units.
    const leads = await registry.requireModule('leads');
    const field = leads.fields.find((f) => f.name === RENAMED);
    expect((field?.config.unitOptions as unknown[] | undefined)?.length,
      'the Sq Ft / Sq Yd / Bigha list is still there').toBeGreaterThan(0);
  });
});
