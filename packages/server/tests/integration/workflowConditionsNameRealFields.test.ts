/**
 * No active workflow filters on a field that does not exist.
 *
 * The birthday greeting stopped running on 11 August and nobody noticed for
 * three weeks. Its condition asked for `do_not_whatsapp`, deleted that day.
 *
 * The failure shape is the dangerous part. `buildWhere` raises a 400 on an
 * unknown field, the scheduler catches it and logs "scheduled workflow failed",
 * and the tick carries on. Every other scheduled workflow keeps running, so
 * there is no outage, no alert and no missing feature anybody can point at —
 * just one automation that silently stopped.
 *
 * Deleting a field is a normal, supported thing for an admin to do here. What
 * is not acceptable is that doing so quietly disables an automation that
 * mentions it. Until the field editor warns about this at the point of deletion,
 * this test is the thing that catches it.
 */
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { isSystemField } from '../../src/core/query/builder.js';

interface Condition { field?: string }

/** Every field name mentioned anywhere in a condition tree, however nested. */
function fieldsIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) fieldsIn(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown> & Condition;
    if (typeof obj.field === 'string') out.push(obj.field);
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') fieldsIn(value, out);
    }
  }
  return out;
}

describe('workflow conditions', () => {
  it('never filter on a field that no longer exists', async () => {
    const workflows = await db.query<{
      name: string; module_name: string; conditions: unknown; is_active: boolean;
    }>(
      `SELECT w.name, m.name AS module_name, w.conditions, w.is_active
         FROM ipy_workflow w
         JOIN ipy_module m ON m.id = w.module_id
        WHERE w.is_active = true`,
    );

    expect(workflows.rowCount, 'no active workflows found, which cannot be right')
      .toBeGreaterThan(0);

    const broken: string[] = [];

    for (const wf of workflows.rows) {
      for (const field of new Set(fieldsIn(wf.conditions))) {
        /*
          `created_at`, `last_activity_at` and the rest resolve on every module
          without an ipy_field row — the query builder maps them onto ipy_record.
          Asking the builder rather than repeating its list here, because a
          second copy of that list is the same mistake this test exists to catch.
        */
        if (isSystemField(field)) continue;
        const known = await db.queryOne<{ n: string }>(
          `SELECT count(*) AS n FROM ipy_field f
             JOIN ipy_module m ON m.id = f.module_id
            WHERE m.name = $1 AND f.name = $2 AND f.is_active = true`,
          [wf.module_name, field],
        );

        if (Number(known?.n) === 0) {
          broken.push(
            `"${wf.name}" filters on ${wf.module_name}.${field}, which does not `
            + `exist — the whole workflow is skipped on every run, and only a log `
            + `line says so`,
          );
        }
      }
    }

    expect(
      broken,
      'a workflow naming a missing field does not error loudly, it just stops '
      + 'happening — remove the condition, or point it at a field that exists',
    ).toEqual([]);
  });

  it('the birthday greeting is one of the ones that runs', async () => {
    // Pinned by name because this is the one that was broken, and because it
    // fires once a year per person, so a regression could hide for a long time.
    const wf = await db.queryOne<{ conditions: unknown; is_active: boolean }>(
      `SELECT conditions, is_active FROM ipy_workflow WHERE name = 'Birthday greeting'`,
    );
    if (!wf) return; // not seeded in every environment

    expect(wf.is_active).toBe(true);
    expect(
      fieldsIn(wf.conditions),
      'consent is checked at send time against ipy_channel_optout; checking it '
      + 'again here on a deleted column is what killed this workflow',
    ).not.toContain('do_not_whatsapp');
  });
});
