/**
 * The outcome of a call has to be one the admin's list offers.
 *
 * `POST /calls/:id/disposition` — the button a rep presses after every call —
 * validated the outcome as `z.string().min(1).max(60)` and wrote whatever
 * arrived. Production holds three calls recorded against `NotARealOption`,
 * written by a probe with an API key; nothing in the UI could produce it, but
 * anything holding a key could, and every report that groups by disposition
 * silently grew a category nobody chose.
 *
 * Two halves, and the second is the one that matters: a guard that refuses
 * junk but also refuses "Interested" is an outage on the morning the team
 * starts using this.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';

let app: ReturnType<typeof createApp>;
let token = '';
let callId = '';
const stamp = Date.now();
const MOBILE = `98${String(stamp).slice(-8)}`;

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;

  const call = await request(app).post('/api/telephony/log')
    .set('Authorization', `Bearer ${token}`)
    .send({ to: MOBILE, direction: 'outbound', durationSeconds: 60 });
  expect(call.status).toBe(201);
  callId = call.body.callId;
});

describe('a call disposition', () => {
  it('accepts a value the picklist offers', async () => {
    const res = await request(app).post(`/api/telephony/calls/${callId}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'Interested', notes: 'wants a 3 BHK' });
    expect(res.status).toBe(200);

    const row = await db.queryOne<{ disposition: string }>(
      `SELECT disposition FROM ipy_call WHERE id = $1`, [callId],
    );
    expect(row?.disposition).toBe('Interested');
  });

  it('refuses one it does not, and says what is allowed', async () => {
    const res = await request(app).post(`/api/telephony/calls/${callId}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'NotARealOption' });
    expect(res.status).toBe(400);
    expect(String(res.body.error?.message ?? res.body.message)).toContain('Interested');

    // And nothing was written: a refused request must not leave the call
    // half-updated, nor log a revision against a value it rejected.
    const row = await db.queryOne<{ disposition: string }>(
      `SELECT disposition FROM ipy_call WHERE id = $1`, [callId],
    );
    expect(row?.disposition).toBe('Interested');
  });

  /**
   * Case matters. "do not call" looks right to a human and is invisible to the
   * `=== 'Do Not Call'` branch below it, which is the one that records a TRAI
   * opt-out in the consent store.
   */
  it('refuses the right words in the wrong case', async () => {
    const res = await request(app).post(`/api/telephony/calls/${callId}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'do not call' });
    expect(res.status).toBe(400);
  });

  it('guards the edit path and the manual log too', async () => {
    const patched = await request(app).patch(`/api/telephony/calls/${callId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'NotARealOption' });
    expect(patched.status).toBe(400);

    const logged = await request(app).post('/api/telephony/log')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: MOBILE, direction: 'outbound', durationSeconds: 30, disposition: 'NotARealOption' });
    expect(logged.status).toBe(400);
  });

  /**
   * The admin owns the list, so adding to it in Settings must be enough.
   *
   * Through the same endpoint the picklist editor uses, not an INSERT: the
   * server validates against the metadata registry's cache, and what proves
   * the loop closed is that an admin's save invalidates it. A direct INSERT
   * passes the database and leaves the running server still refusing the
   * value, which is precisely the bug this asserts against.
   */
  it('accepts a value the admin added a moment ago', async () => {
    const before = await request(app).get('/api/meta/picklists/call_disposition')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    const value = `QA Outcome ${stamp}`;
    const values = [...before.body, { value, label: value, isActive: true }]
      .map((v: { value: string; label: string; color?: string | null; isActive?: boolean }) => ({
        value: v.value, label: v.label, color: v.color ?? null, isActive: v.isActive ?? true,
      }));

    const saved = await request(app).put('/api/meta/picklists/call_disposition/values')
      .set('Authorization', `Bearer ${token}`).send({ values });
    expect(saved.status).toBe(200);

    try {
      const res = await request(app).post(`/api/telephony/calls/${callId}/disposition`)
        .set('Authorization', `Bearer ${token}`)
        .send({ disposition: value });
      expect(res.status).toBe(200);
    } finally {
      await request(app).delete(
        `/api/meta/picklists/call_disposition/values?value=${encodeURIComponent(value)}`,
      ).set('Authorization', `Bearer ${token}`);
      await db.query(`UPDATE ipy_call SET disposition = 'Interested' WHERE id = $1`, [callId]);
    }
  });
});
