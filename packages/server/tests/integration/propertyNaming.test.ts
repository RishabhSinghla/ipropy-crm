/**
 * Naming a property's files, when a field it names them from has been deleted.
 *
 * `propertyNamePrefix` built its SELECT by naming columns: `p.project_name`,
 * `p.locality`, and so on. `project_name` and `city` were deliberately removed
 * from this CRM — one area, one kind of stock, so a project grouping was noise —
 * and naming a dropped column in a SELECT is a Postgres 42703, which throws.
 *
 * So this function raised every time it ran, and it is what `notifyPropertyFinished`
 * calls to tell n8n a shoot is ready. The whole media handoff went with it. From
 * outside that reads as "the automation is down", with nothing pointing at a
 * column that is not there.
 *
 * This is the third time a hand-listed column list has broken a feature in this
 * repo after a field was deleted, so the test drops the column for real rather
 * than trusting the SQL by eye.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { createRecord } from '../../src/core/entity/recordService.js';
import { propertyNamePrefix } from '../../src/integrations/automation/n8n.js';
import { adminContext, propertyInput } from './fixtures.js';

let recordId: string;
let droppedType: string | null = null;

/*
  Its own property, not whichever one comes back first.

  This used to borrow `SELECT ... FROM ipy_record ... LIMIT 1` with no ORDER BY,
  and then assert that the prefix built from it is *not* the generic fallback.
  Which row that returns depends on what every earlier file in the suite
  happened to create, so the test was asserting on the contents of a record it
  had never seen — and it failed on a quiet machine when it drew one whose name
  slugged to the fallback.

  Naming it here makes the assertion about `propertyNamePrefix` rather than
  about the luck of the draw. The label is the one part that exists whatever
  shape the model is in, which matters because this suite runs against both a
  fresh seed and a mirror of production's much smaller column set.
*/
beforeAll(async () => {
  const admin = await adminContext();
  const created = await createRecord(
    admin,
    'properties',
    propertyInput({ full_name: `Naming Test ${Date.now()}` }),
  );
  recordId = created.id;
});

afterAll(async () => {
  // Put it back, so anything running afterwards sees the schema it expects.
  if (droppedType) {
    await db.query(`ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS project_name ${droppedType}`);
  }
  /*
    And take the property back out of circulation. Other files still borrow
    "whichever property comes first"; leaving one behind with a deliberately
    odd name would hand them the same problem this test just stopped having.
  */
  if (recordId) {
    await db.query(
      `UPDATE ipy_record SET is_deleted = true, deleted_at = now() WHERE id = $1`,
      [recordId],
    );
  }
});

describe('building a filename prefix', () => {
  it('names a property from what it has', async () => {
    const prefix = await propertyNamePrefix(recordId);

    expect(prefix).toBeTruthy();
    expect(prefix).not.toBe('property');
    // Lowercase, hyphenated, safe in a filename and a URL.
    expect(prefix).toMatch(/^[a-z0-9-]+$/);
  });

  it('leaves out a field that literally says "None"', async () => {
    /*
      A blank field is skipped by any emptiness check. A field containing the
      word "None" is not blank, so it used to be slugged and joined like a real
      value, and a buyer got `a1818-none-4-bhk-02.jpg`.
    */
    await db.query(
      `UPDATE ipy_e_properties SET locality = 'None' WHERE record_id = $1`,
      [recordId],
    );

    const prefix = await propertyNamePrefix(recordId);
    expect(prefix).not.toContain('none');
  });

  it('still names a property after the column it read is dropped', async () => {
    /*
      The actual bug. Not a hypothetical: `project_name` is gone from production
      and this function names every file the media pipeline produces.
    */
    const column = await db.queryOne<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'ipy_e_properties' AND column_name = 'project_name'`,
    );

    if (!column) {
      // Already gone, which is production's state. Then simply working is the assertion.
      expect(await propertyNamePrefix(recordId)).toBeTruthy();
      return;
    }

    droppedType = column.data_type === 'text' ? 'TEXT' : 'VARCHAR';
    await db.query(`ALTER TABLE ipy_e_properties DROP COLUMN project_name`);

    const prefix = await propertyNamePrefix(recordId);

    expect(prefix, 'a deleted column must read as a missing value, not an error').toBeTruthy();
    expect(prefix).not.toBe('property');
  });
});
