/**
 * The changes feed is for salespeople, not for the database.
 *
 * Two separate ways it stopped being readable:
 *
 * **IDs.** An audit row stores values exactly as written, so a reassignment
 * reads `671d65cc-… → de064965-…`. That is a true record of what happened and
 * it tells the person reading it nothing at all.
 *
 * **Stale labels.** The audit row also freezes the label the field had at the
 * time. Fields get renamed here constantly, so a feed read today was captioned
 * "Owner" for a field every other screen now calls "Assigned To" — two names
 * for one idea, which is exactly the confusion the rename was meant to end.
 *
 * Both are resolved on read rather than on write, so history written before
 * the fix reads correctly too. Neither is visible to a unit test: the ids are
 * resolved with SQL against three tables, and the label comes from the live
 * field metadata.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { buildTimeline } from '../../src/core/entity/timeline.js';
import { adminContext, authUser, SEEDED } from './fixtures.js';

let recordId: string;
let assignee: Awaited<ReturnType<typeof authUser>>;

beforeAll(async () => {
  const ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `Timeline Reads ${Date.now()}`,
    mobile: '9811500043',
  });
  recordId = lead.id;

  assignee = await authUser(SEEDED.executiveA);
  await recordService.updateRecord(ctx, 'leads', recordId, { owner_id: assignee.id });
});

afterAll(async () => {
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

describe('an assignment in the changes feed', () => {
  it('names the person instead of printing their id', async () => {
    const entries = await buildTimeline(recordId, { types: ['audit'] });
    const change = entries
      .flatMap((e) => (e.meta.changes as { field?: string; toDisplay?: string }[] | undefined) ?? [])
      .find((c) => c.field === 'owner_id');

    expect(change, 'the reassignment should be in the feed').toBeTruthy();
    expect(change?.toDisplay).toBe(assignee.fullName);
    expect(change?.toDisplay).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('captions it with the label the field carries now', async () => {
    const current = await db.queryOne<{ label: string }>(
      `SELECT f.label FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.column_name = 'owner_id'`,
    );
    // Stamp the row with a label nobody uses any more, the way a rename leaves
    // history behind.
    await db.query(
      `UPDATE ipy_audit
          SET changes = jsonb_set(changes, '{0,label}', '"Owner"')
        WHERE record_id = $1 AND changes @> '[{"field": "owner_id"}]'`,
      [recordId],
    );

    const entries = await buildTimeline(recordId, { types: ['audit'] });
    const change = entries
      .flatMap((e) => (e.meta.changes as { field?: string; label?: string }[] | undefined) ?? [])
      .find((c) => c.field === 'owner_id');

    expect(change?.label).toBe(current?.label);
    expect(change?.label).not.toBe('Owner');
  });
});
