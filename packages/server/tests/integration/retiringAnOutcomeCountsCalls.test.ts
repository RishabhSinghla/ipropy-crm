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

let app: ReturnType<typeof createApp>;
let token = '';
let callId = '';
const stamp = Date.now();
const OUTCOME = `QA Retire ${stamp}`;

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;

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
});
