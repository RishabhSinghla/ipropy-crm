/**
 * The two outcomes that do more than fill in a column.
 *
 * A disposition nobody acts on is a form nobody fills in twice, so "Wrong
 * Number" junks the lead and a call back with a date becomes a real follow-up
 * the rep will be reminded about. Both reach past the call row into the lead's
 * own table, which is the part an admin can reshape underneath them — the
 * reason each one is guarded rather than assumed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';

let app: ReturnType<typeof createApp>;
let token = '';
const stamp = Date.now();

async function leadWithCall(suffix: string): Promise<{ leadId: string; callId: string; mobile: string }> {
  const mobile = `9${suffix}${String(stamp).slice(-8)}`;
  const lead = await request(app).post('/api/records/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ full_name: `QA Disposition ${suffix} ${stamp}`, mobile, lead_status: 'New' });
  expect(lead.status).toBeLessThan(400);

  const call = await request(app).post('/api/telephony/log')
    .set('Authorization', `Bearer ${token}`)
    .send({ to: mobile, recordId: lead.body.id, module: 'leads', direction: 'outbound', durationSeconds: 45 });
  expect(call.status).toBe(201);
  return { leadId: lead.body.id, callId: call.body.callId, mobile };
}

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;
});

describe('a disposition that acts on the lead', () => {
  it('junks the lead on Wrong Number', async () => {
    const { leadId, callId } = await leadWithCall('3');

    const res = await request(app).post(`/api/telephony/calls/${callId}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'Wrong Number' });
    expect(res.status).toBe(200);

    const row = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_e_leads WHERE record_id = $1`, [leadId],
    );
    expect(row?.status).toBe('Junk');
  });

  /**
   * The reminder is the deliverable, not the date column: a promise to ring
   * somebody back on Thursday that leaves no trace anyone will see is the
   * same as no promise.
   */
  it('books the callback and leaves a note on the lead', async () => {
    const { leadId, callId } = await leadWithCall('4');
    const when = new Date(Date.now() + 3 * 86_400_000).toISOString();

    const res = await request(app).post(`/api/telephony/calls/${callId}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'Call Back Later', notes: 'after his site visit', followUpAt: when });
    expect(res.status).toBe(200);

    const lead = await db.queryOne<{ next_followup_at: string | Date | null }>(
      `SELECT next_followup_at FROM ipy_e_leads WHERE record_id = $1`, [leadId],
    );
    expect(lead?.next_followup_at, 'no follow-up date was written').toBeTruthy();

    const note = await db.queryOne<{ body: string }>(
      `SELECT body FROM ipy_comment WHERE record_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leadId],
    );
    expect(note?.body ?? '').toContain('Call Back Later');
    expect(note?.body ?? '').toContain('after his site visit');

    // And the call itself carries the date, so the calls list can show it.
    const call = await db.queryOne<{ follow_up_at: string | Date | null }>(
      `SELECT follow_up_at FROM ipy_call WHERE id = $1`, [callId],
    );
    expect(call?.follow_up_at).toBeTruthy();
  });
});
