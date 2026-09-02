/**
 * Renaming a dropdown field does not empty its dropdown.
 *
 * It did. `renameFieldEverywhere` does a blind string replace of the old field
 * name across every field's `config` on that module — which is right, because a
 * config names other fields in `dependsOn`, in formula operands and in
 * conditional-visibility rules.
 *
 * But it also names its **picklist**, and a picklist is a separate thing that
 * merely happens to share the field's name. So renaming `funding_type` to
 * `funding_readiness` repointed it at a picklist called `funding_readiness`,
 * which does not exist. The field kept its label and its stored values and
 * offered zero options.
 *
 * Silent, and squarely against the promise the product is built on: an admin
 * renames a field, and the field quietly stops working.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { renameFieldEverywhere } from '../../src/core/metadata/fieldRename.js';
import { registry } from '../../src/core/metadata/registry.js';

let moduleId: string;
let fieldId: string;
let original: string;

beforeAll(async () => {
  await registry.warmup();
  const row = await db.queryOne<{ id: string; module_id: string; name: string }>(
    `SELECT f.id, f.module_id, f.name
       FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
      WHERE m.name = 'leads' AND f.config->>'picklist' IS NOT NULL AND f.is_active
      LIMIT 1`,
  );
  if (!row) throw new Error('no dropdown field on leads to test with');
  fieldId = row.id;
  moduleId = row.module_id;
  original = row.name;
});

afterAll(async () => {
  await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [fieldId, original]);
  registry.invalidate();
});

describe('renaming a dropdown field', () => {
  it('leaves it pointing at the same picklist', async () => {
    const before = await db.queryOne<{ picklist: string }>(
      `SELECT config->>'picklist' AS picklist FROM ipy_field WHERE id = $1`, [fieldId],
    );

    // Both halves, in the order the PATCH route does them: the field's own row,
    // then every reference to it elsewhere.
    await db.query(`UPDATE ipy_field SET name = $2 WHERE id = $1`, [fieldId, `${original}_renamed`]);
    await renameFieldEverywhere(moduleId, 'leads', original, `${original}_renamed`);

    const after = await db.queryOne<{ name: string; picklist: string }>(
      `SELECT name, config->>'picklist' AS picklist FROM ipy_field WHERE id = $1`, [fieldId],
    );

    expect(after?.name, 'the rename itself must happen').toBe(`${original}_renamed`);
    expect(
      after?.picklist,
      'the dropdown pointer is a picklist name, not a field name — rewriting it '
      + 'points the field at a picklist that does not exist and it offers nothing',
    ).toBe(before?.picklist);
  });

  it('still offers its options afterwards', async () => {
    // The symptom an admin would actually see: the field is there, the data is
    // there, and the list is empty.
    const row = await db.queryOne<{ options: string }>(
      `SELECT count(v.id)::text AS options
         FROM ipy_field f
         JOIN ipy_picklist p ON p.name = f.config->>'picklist'
         LEFT JOIN ipy_picklist_value v ON v.picklist_id = p.id
        WHERE f.id = $1
        GROUP BY f.id`,
      [fieldId],
    );

    expect(Number(row?.options ?? 0), 'a renamed dropdown must still have options')
      .toBeGreaterThan(0);
  });

  it('does not disturb any other field on the module', async () => {
    // The blind replace runs across every field's config, so a rename must be
    // checked for collateral damage as well as for its own correctness.
    const broken = await db.query<{ name: string; picklist: string }>(
      `SELECT f.name, f.config->>'picklist' AS picklist
         FROM ipy_field f
        WHERE f.module_id = $1
          AND f.config->>'picklist' IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ipy_picklist p WHERE p.name = f.config->>'picklist')`,
      [moduleId],
    );

    expect(
      broken.rows.map((r) => `${r.name} -> ${r.picklist}`),
      'these fields now point at a picklist that does not exist',
    ).toEqual([]);
  });
});
