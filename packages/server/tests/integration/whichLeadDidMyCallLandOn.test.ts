/**
 * Two contacts, one number — which record does the call attach to?
 *
 * It happens constantly and it is not a data-quality problem to be fixed: a
 * husband and wife on one handset, a broker's number against three of their
 * clients, a number entered as somebody's mobile and somebody else's alternate.
 * The sync has to pick one, and the rep has to be able to predict which, or the
 * call lands on a record nobody looks at and the follow-up never happens.
 *
 * The rule, from `matchContact`: a contact already deep in the pipeline wins
 * over one that is not, and after that the most recently touched record wins.
 * A live call is far more likely to be about the deal in progress.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';

let app: ReturnType<typeof createApp>;
let token = '';
let deviceToken = '';
let inPlay = '';
let dormant = '';
const stamp = Date.now();
const SHARED = `93${String(stamp).slice(-8)}`;

async function lead(name: string, values: Record<string, unknown>): Promise<string> {
  const res = await request(app).post('/api/records/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ full_name: `${name} ${stamp}`, ...values });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
  return res.body.id;
}

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;

  // The number is one contact's mobile and the other's alternate — the shape
  // this actually turns up in, and both are matched against.
  dormant = await lead('QA Dormant', { mobile: SHARED, lead_status: 'New' });
  inPlay = await lead('QA InPlay', {
    mobile: `92${String(stamp).slice(-8)}`, alternate_phone: SHARED, lead_status: 'Negotiation',
  });

  // Touch the dormant one last, so "most recent" alone would pick the wrong
  // record and only the pipeline rule gets this right.
  await request(app).patch(`/api/records/leads/${dormant}`)
    .set('Authorization', `Bearer ${token}`).send({ city: 'Pune' });

  const paired = await request(app).post('/api/telephony/devices')
    .set('Authorization', `Bearer ${token}`)
    .send({ label: `QA shared ${stamp}`, phoneNumber: SHARED, model: 'QA' });
  deviceToken = paired.body.token;
});

describe('a call to a number two contacts share', () => {
  it('lands on the one the deal is with', async () => {
    const res = await request(app).post('/api/device/calls')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        entries: [{
          externalId: `qa-shared-${stamp}`, number: SHARED, type: 2,
          timestamp: stamp - 60_000, durationSeconds: 60,
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBeGreaterThanOrEqual(1);

    const call = await db.queryOne<{ record_id: string }>(
      `SELECT record_id FROM ipy_call WHERE external_id = $1`, [`qa-shared-${stamp}`],
    );
    expect(call?.record_id, 'the call landed on the dormant contact').toBe(inPlay);
  });

  /**
   * A deleted contact is not a candidate. Its rows are still in the payload
   * table, so a matcher that forgets `is_deleted` files calls against records
   * that appear nowhere in the CRM — see the soft-delete blind spots that have
   * cost this system before.
   */
  it('ignores a contact that has been deleted', async () => {
    await request(app).delete(`/api/records/leads/${inPlay}`)
      .set('Authorization', `Bearer ${token}`);

    const res = await request(app).post('/api/device/calls')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        entries: [{
          externalId: `qa-shared-${stamp}-b`, number: SHARED, type: 2,
          timestamp: stamp - 30_000, durationSeconds: 45,
        }],
      });
    expect(res.status).toBe(200);

    const call = await db.queryOne<{ record_id: string }>(
      `SELECT record_id FROM ipy_call WHERE external_id = $1`, [`qa-shared-${stamp}-b`],
    );
    expect(call?.record_id, 'the call was filed against a deleted contact').toBe(dormant);
  });
});
