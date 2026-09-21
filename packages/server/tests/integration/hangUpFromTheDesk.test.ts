/**
 * Ending the call from the computer.
 *
 * **21 September 2026, the owner:** *"I need to end call from popup."* What
 * makes this answerable at all is one line of Android's own reference, read on
 * the day: `TelecomManager.endCall()` needs `ANSWER_PHONE_CALLS` and **not**
 * the default-dialler role — so the rep keeps the phone app they already use.
 *
 * The server's half is a command on the same queue as a dial, and the rules
 * below are the ones that stop it being dangerous.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

let app: Express;
let token = '';
let deviceId = '';

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  await db.query(
    `UPDATE ipy_device SET is_active = false
      WHERE user_id = (SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com')`,
  );
  const paired = await request(app).post('/api/telephony/devices')
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'Hang-up test handset' })
    .expect(201);
  deviceId = paired.body.deviceId;
});

describe('hanging up from the desk', () => {
  it('refuses rather than queueing for a phone that cannot end a call', async () => {
    // A command queued for a handset with no permission would sit there until
    // it expired while the desk waited for a hang-up that was never possible.
    const res = await request(app).post('/api/telephony/hangup')
      .set('Authorization', `Bearer ${token}`).send({}).expect(200);
    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toBe('not-the-dialler');
    expect(String(res.body.detail)).toMatch(/only the handset/i);
  });

  it('the phone says it can, and then it is asked', async () => {
    await request(app).post('/api/telephony/devices/app-open')
      .set('Authorization', `Bearer ${token}`)
      .send({ canEndCall: true })
      .expect(200);

    const res = await request(app).post('/api/telephony/hangup')
      .set('Authorization', `Bearer ${token}`).send({}).expect(200);
    expect(res.body.sent).toBe(true);
    expect(res.body.commandId).toBeTruthy();

    const row = await db.queryOne<{ kind: string; expires_at: string }>(
      `SELECT kind, expires_at FROM ipy_device_command WHERE id = $1`, [res.body.commandId],
    );
    expect(row?.kind).toBe('hangup');

    /*
      Seconds, not minutes. A dial that arrives late rings somebody who was
      going to be rung anyway; a hang-up that arrives late cuts off the *next*
      conversation, and there is no undoing that.
    */
    const secondsLeft = (new Date(row!.expires_at).getTime() - Date.now()) / 1000;
    expect(secondsLeft).toBeLessThanOrEqual(25);
    expect(secondsLeft).toBeGreaterThan(5);
  });

  it('the phone collects it from the same queue a dial comes from', async () => {
    /*
      Anything this admin already had waiting comes off first. Another suite
      dialling from the same account leaves a queued row behind, the claim
      hands over the oldest, and this reads as a hang-up that never arrived —
      a test reporting the machine it ran on rather than the feature.
    */
    let taken = await request(app).get('/api/telephony/dial/pending')
      .set('Authorization', `Bearer ${token}`).expect(200);
    for (let i = 0; i < 20 && taken.body.command && taken.body.command.kind !== 'hangup'; i += 1) {
      taken = await request(app).get('/api/telephony/dial/pending')
        .set('Authorization', `Bearer ${token}`).expect(200);
    }
    expect(taken.body.command?.kind).toBe('hangup');
    // A hang-up carries no number by design: the phone ends whatever call it
    // is on, and a number here would invite ending the wrong one.
    expect(taken.body.command?.number).toBeNull();
  });

  it('a phone that loses the permission stops being asked', async () => {
    await request(app).post('/api/telephony/devices/app-open')
      .set('Authorization', `Bearer ${token}`)
      .send({ canEndCall: false })
      .expect(200);

    const res = await request(app).post('/api/telephony/hangup')
      .set('Authorization', `Bearer ${token}`).send({}).expect(200);
    expect(res.body.sent).toBe(false);
  });

  it('the phones list says which handsets can do it, so a screen never guesses', async () => {
    const res = await request(app).get('/api/telephony/devices')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const phone = (res.body as { id: string; can_end_call?: boolean }[]).find((r) => r.id === deviceId);
    expect(phone).toHaveProperty('can_end_call');
  });
});
