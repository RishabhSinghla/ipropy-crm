/**
 * "Do not call me again", from the two directions a call can come from.
 *
 * This is the one disposition with a legal weight behind it: under TRAI the
 * request has to be recorded and obeyed, and the CRM's own comment on the
 * endpoint says it "is honoured even for a caller the CRM holds no record
 * for". Both halves of that sentence are tested here because both were false.
 *
 * The opt-out is keyed on the number, so the only question that matters is
 * *whose* number got stored — and on an inbound call the customer is at the
 * other end from where an outbound call has them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';

let app: ReturnType<typeof createApp>;
let token = '';
const stamp = Date.now();
const STRANGER = `97${String(stamp).slice(-8)}`;
const CALLER = `96${String(stamp).slice(-8)}`;

async function optedOut(number: string): Promise<boolean> {
  const row = await db.queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM ipy_channel_optout
      WHERE channel = 'call' AND right(regexp_replace(handle,'\\D','','g'), 10) = $1`,
    [number.slice(-10)],
  );
  return (row?.n ?? 0) > 0;
}

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;
});

describe('a Do Not Call request', () => {
  it('is recorded for a number the CRM has no lead for', async () => {
    const call = await request(app).post('/api/telephony/log')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: STRANGER, direction: 'outbound', durationSeconds: 20 });
    expect(call.status).toBe(201);

    const res = await request(app).post(`/api/telephony/calls/${call.body.callId}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'Do Not Call' });
    expect(res.status).toBe(200);

    expect(await optedOut(STRANGER), 'the request was recorded nowhere').toBe(true);
  });

  /**
   * An inbound call reverses the two numbers. Storing `to_number` there opts
   * out the agent's own handset — the CRM stops calling itself, and rings the
   * person who asked it not to.
   */
  it('is recorded against the caller, not the agent, on an inbound call', async () => {
    const call = await request(app).post('/api/telephony/log')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: CALLER, direction: 'inbound', durationSeconds: 30 });
    expect(call.status).toBe(201);

    const row = await db.queryOne<{ from_number: string; to_number: string }>(
      `SELECT from_number, to_number FROM ipy_call WHERE id = $1`, [call.body.callId],
    );
    expect(row?.from_number).toContain(CALLER.slice(-10));

    const res = await request(app).post(`/api/telephony/calls/${call.body.callId}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'Do Not Call' });
    expect(res.status).toBe(200);

    expect(await optedOut(CALLER), 'the caller can still be rung').toBe(true);
    // And the agent's own number was not opted out along the way.
    const agent = row!.to_number;
    if (agent && /\d{6,}/.test(agent)) {
      expect(await optedOut(agent), 'the CRM opted out its own number').toBe(false);
    }
  });
});
