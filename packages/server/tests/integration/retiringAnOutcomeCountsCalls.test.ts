/**
 * Retiring or renaming a call outcome has to see the calls.
 *
 * The picklist editor tells an admin what a value is used by before they
 * delete it, and rewrites every record when they rename it. Both walk
 * `ipy_field`, so both were blind to `ipy_call.disposition` — a column on one
 * of the CRM's own tables, which belongs to no module and appears in no field
 * list.
 *
 * It happened: "Site Visit Scheduled" was retired on production on 6 September
 * against a usage count of zero, and a call from 16 August still holds it.
 * Nobody could have known, and since outcomes became validated it is a value
 * that can never be written again.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { countRecordsWithValue, replaceValueInRecords } from '../../src/core/metadata/picklists.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let callId = '';
const stamp = Date.now();
const OUTCOME = `QA Retire ${stamp}`;

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');

  const call = await request(app).post('/api/telephony/log')
    .set('Authorization', `Bearer ${token}`)
    .send({ to: `95${String(stamp).slice(-8)}`, direction: 'outbound', durationSeconds: 40 });
  callId = call.body.callId;
  // Written directly: the endpoint now refuses an outcome the list does not
  // offer, and this is about a call that already holds one.
  await db.query(`UPDATE ipy_call SET disposition = $2 WHERE id = $1`, [callId, OUTCOME]);
});

describe('an outcome in use by a call', () => {
  it('is counted before it is deleted', async () => {
    const usage = await countRecordsWithValue('call_disposition', OUTCOME);
    expect(usage.total, 'the editor would report this value as unused').toBeGreaterThanOrEqual(1);
    expect(usage.byField.some((f) => f.module === 'Calls')).toBe(true);
  });

  it('moves with a rename', async () => {
    const renamed = `${OUTCOME} v2`;
    await replaceValueInRecords('call_disposition', OUTCOME, renamed);

    const row = await db.queryOne<{ disposition: string }>(
      `SELECT disposition FROM ipy_call WHERE id = $1`, [callId],
    );
    expect(row?.disposition, 'the call was left holding the old value').toBe(renamed);

    await db.query(`UPDATE ipy_call SET disposition = NULL WHERE id = $1`, [callId]);
  });

  it('moves a saved list filtering on the last call outcome too', async () => {
    const before = `${OUTCOME} list`;
    const after = `${OUTCOME} list v2`;
    const view = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_view (module_id, name, filter, is_public)
       SELECT id, $1, $2::jsonb, false FROM ipy_module WHERE name = 'leads' RETURNING id`,
      [`QA outcome list ${stamp}`, JSON.stringify({ logic: 'AND', conditions: [{ field: 'last_call_disposition', operator: 'in', value: [before] }] })],
    );
    try {
      await replaceValueInRecords('call_disposition', before, after);
      const row = await db.queryOne<{ filter: { conditions: { value: string[] }[] } }>(
        `SELECT filter FROM ipy_view WHERE id = $1`, [view!.id],
      );
      expect(row?.filter.conditions[0]?.value, 'the saved list still asked for the old outcome').toEqual([after]);
    } finally {
      await db.query(`DELETE FROM ipy_view WHERE id = $1`, [view!.id]);
    }
  });
});
