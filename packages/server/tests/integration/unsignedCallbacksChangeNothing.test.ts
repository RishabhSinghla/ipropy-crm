/**
 * A telephony callback answers 200 before it knows who sent it.
 *
 * That is deliberate — providers retry anything that is not a 200, and a
 * retry storm over a request that was never going to be accepted helps nobody
 * — but it means the status code says nothing about whether the request was
 * honoured. `webhookAuth.test.ts` covers the signature check itself
 * thoroughly; this covers the half it cannot see, which is whether an unsigned
 * request actually *changes* anything.
 *
 * It is worth having because the handler looks wrong. `res.sendStatus(200)` is
 * the first line and the verification is the second, so anyone reading it
 * quickly — or probing it from outside, as happened — concludes the endpoint is
 * open. The protection lives in the order of those two lines, and reversing
 * them would pass every existing test while letting a stranger rewrite call
 * records.
 *
 * That is not hypothetical: an external review in August 2026 found exactly
 * that, when these callbacks authenticated nobody at all and anyone could
 * invent calls or overwrite real ones.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';

let app: ReturnType<typeof createApp>;
let token = '';

const wait = (ms: number) => new Promise((r) => { setTimeout(r, ms); });
const listCalls = async (): Promise<Record<string, unknown>[]> => {
  const res = await request(app).get('/api/telephony/calls?pageSize=10').set('Authorization', `Bearer ${token}`);
  return (Array.isArray(res.body) ? res.body : res.body.rows ?? []) as Record<string, unknown>[];
};

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;
});

describe('an unsigned telephony callback', () => {
  it('is acknowledged with a 200 and changes nothing', async () => {
    const stamp = Date.now();
    const logged = await request(app).post('/api/telephony/log')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: `98${String(stamp).slice(-8)}`, direction: 'outbound', durationSeconds: 42, notes: 'QA real call' });
    expect(logged.status).toBeLessThan(400);

    const before = (await listCalls())[0];
    expect(before, 'no call to attack').toBeTruthy();

    /*
      Given the *provider's* id, not the CRM's.

      `updateCallStatus` matches on `provider_call_id`, so an attack quoting the
      internal id finds no row and changes nothing whether the signature is
      checked or not — which made the first version of this test pass even with
      the verification deleted. A stranger guessing at a `CallSid` has the same
      problem, but a stranger who has *seen* one — a forwarded provider email, a
      log, a shared screen — does not, and that is the case worth defending.
    */
    const providerCallId = `CA-qa-${stamp}`;
    await db.query(`UPDATE ipy_call SET provider_call_id = $2 WHERE id = $1`, [before.id, providerCallId]);

    const attack = await request(app).post('/api/webhooks/telephony/twilio/status').send({
      CallSid: providerCallId,
      CallStatus: 'failed',
      CallDuration: '9999',
      RecordingUrl: 'https://evil.example.com/x.mp3',
    });
    expect(attack.status, 'the provider would retry anything else').toBe(200);

    // The write, if it happened, happens after the response.
    await wait(1200);

    const after = (await listCalls()).find((c) => c.id === before.id);
    expect(after?.status, 'an unsigned callback rewrote the call status').toBe(before.status);
    expect(after?.duration_seconds, 'an unsigned callback rewrote the duration').toBe(before.duration_seconds);
    expect(after?.recording_url ?? null, 'an unsigned callback attached a recording').toBeNull();
  });

  it('cannot invent a call that never happened', async () => {
    const before = (await listCalls()).length;
    await request(app).post('/api/webhooks/telephony/twilio/status')
      .send({ CallSid: `CA-invented-${Date.now()}`, CallStatus: 'completed', CallDuration: '120' });
    await wait(1200);
    expect((await listCalls()).length, 'an unsigned callback created a call').toBe(before);
  });
});
