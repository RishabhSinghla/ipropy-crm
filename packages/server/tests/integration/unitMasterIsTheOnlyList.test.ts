/**
 * The Area / Budget unit masters are the list the CRM offers.
 *
 * There were two. Every area and currency field carried a frozen copy of its
 * options in `config.unitOptions`, written when the field was seeded — Sq.ft.
 * and Sq.yd. and nothing else — while `ipy_unit_master` held eight of each
 * behind its own admin screen. Adding Bigha there changed a table nothing
 * read.
 *
 * Migration 118 tagged the fields to close that and the seed undid it on the
 * next cold start, because `config` is replaced wholesale for any field an
 * admin has not customised. Production re-seeds roughly hourly, so the fix
 * lasted about an hour and looked like it had worked. That is what the second
 * test here is for.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { seed } from '../../src/db/seed/index.js';

const EXTRA = 'qa_ropani';

beforeAll(async () => { await registry.warmup(); });
afterAll(async () => {
  await db.query(`DELETE FROM ipy_unit_master WHERE value = $1`, [EXTRA]);
  registry.invalidate();
});

describe('area and budget units', () => {
  it('come from the master, not from a copy inside the field', async () => {
    const leads = await registry.requireModule('leads');
    const area = leads.fields.find((f) => f.name === 'area');
    if (!area) return;

    expect(area.config.unitMaster, 'the field must point at a master').toBe('area');
    const master = await db.query<{ label: string }>(
      `SELECT label FROM ipy_unit_master WHERE kind = 'area' AND is_active ORDER BY sequence`,
    );
    const options = (area.config.unitOptions ?? []) as { label: string }[];
    expect(options.map((o) => o.label)).toEqual(master.rows.map((r) => r.label));

    // A unit added to the master reaches the field with no other step.
    await db.query(
      `INSERT INTO ipy_unit_master (kind, value, label, sequence) VALUES ('area', $1, 'Ropani', 999)
       ON CONFLICT (kind, value) DO NOTHING`, [EXTRA],
    );
    registry.invalidate();
    const after = (await registry.requireModule('leads')).fields.find((f) => f.name === 'area');
    expect(((after!.config.unitOptions ?? []) as { value: string }[]).some((o) => o.value === EXTRA),
      'a unit added to the master must appear on the field').toBe(true);
  });

  it('keeps pointing at the master after a re-seed', async () => {
    // The seed runs on every cold start. Migration 118's tag did not survive
    // one, which is the only reason the two lists stayed apart for so long.
    await seed();
    registry.invalidate();
    const leads = await registry.requireModule('leads');
    for (const name of ['area', 'budget']) {
      const field = leads.fields.find((f) => f.name === name);
      if (!field) continue;
      expect(field.config.unitMaster, `${name} lost its master after a re-seed`).toBeTruthy();
      expect(((field.config.unitOptions ?? []) as unknown[]).length,
        `${name} has no options after a re-seed`).toBeGreaterThan(2);
    }
  });
});
