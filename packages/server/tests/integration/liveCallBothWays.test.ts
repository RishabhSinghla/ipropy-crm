/**
 * The live call, seen and controlled from both the phone and the desk.
 *
 * **26 September 2026, the owner:** speaker, hold, mute and end from the web
 * and from the phone, each reflected on the other; and the timer starting
 * only once the call is answered, "ringing" before that.
 *
 * The server's half: the phone reports what its call is doing, the desk reads
 * it (and hears it over the socket), and the desk's switches reach the phone
 * as commands only a handset that is its own calling app will be sent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

let app: Express;
let token = '';
let phoneToken = '';

const phoneSays = (body: Record<string, unknown>) => request(app).post('/api/device/state')
  .set('Authorization', `Bearer ${phoneToken}`).send(body).expect(200);
const desk = () => request(app).get('/api/telephony/live-call').set('Authorization', `Bearer ${token}`).expect(200);

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  await db.query(
    `UPDATE ipy_device SET is_active = false
      WHERE user_id = (SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com')`,
  );
  const paired = await request(app).post('/api/telephony/devices')
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'Live-call test handset' })
    .expect(201);
  phoneToken = paired.body.token;
  await db.query(`DELETE FROM ipy_device_command WHERE user_id = (SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com')`);
});

describe('the call the phone is on, on the desk', () => {
  it('has no clock while it rings, and starts one when they answer', async () => {
    await phoneSays({ canControlCall: true, canEndCall: true, liveState: 'dialling', liveNumber: '9876543210', direction: 'outgoing', speaker: false, muted: false });
    let live = (await desk()).body;
    expect(live.state).toBe('dialling');
    expect(live.connectedSecondsAgo).toBeNull();

    await phoneSays({ liveState: 'active' });
    live = (await desk()).body;
    expect(live.state).toBe('active');
    expect(live.connectedSecondsAgo).toBeGreaterThanOrEqual(0);
    expect(live.canControlCall).toBe(true);
  });

  it('shows speaker, mute and hold switched on the phone', async () => {
    await phoneSays({ liveState: 'held', speaker: true, muted: true });
    const live = (await desk()).body;
    expect(live).toMatchObject({ state: 'held', speaker: true, muted: true });
    // Hold does not restart the clock.
    expect(live.connectedSecondsAgo).toBeGreaterThanOrEqual(0);
  });

  it('says how long they talked once it ends, and a new call starts from nothing', async () => {
    await phoneSays({ liveState: 'ended' });
    let live = (await desk()).body;
    expect(live.state).toBe('ended');
    expect(live.talkedSeconds).toBeGreaterThanOrEqual(0);
    expect(live.connectedSecondsAgo).toBeNull();

    await phoneSays({ liveState: 'dialling', liveNumber: '9876500000' });
    live = (await desk()).body;
    expect(live.state).toBe('dialling');
    expect(live.connectedSecondsAgo).toBeNull();
    expect(live.number).toBe('9876500000');
  });
});

describe('the desk switching things on the phone', () => {
  it('sends speaker, mute and hold to the phone, and the phone collects them', async () => {
    const sent = await request(app).post('/api/telephony/call-control')
      .set('Authorization', `Bearer ${token}`).send({ action: 'mute', on: true }).expect(200);
    expect(sent.body.sent).toBe(true);

    const next = await request(app).get('/api/device/commands/next')
      .set('Authorization', `Bearer ${phoneToken}`).expect(200);
    expect(next.body.command).toMatchObject({ kind: 'control', payload: { action: 'mute', on: true } });

    // Collected once, never twice.
    const again = await request(app).get('/api/device/commands/next')
      .set('Authorization', `Bearer ${phoneToken}`).expect(200);
    expect(again.body.command).toBeNull();
  });

  it('never hands the phone\'s call service a dial — that is the app\'s to place', async () => {
    await request(app).post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`).send({ to: '9876512345' }).expect(200);
    const next = await request(app).get('/api/device/commands/next')
      .set('Authorization', `Bearer ${phoneToken}`).expect(200);
    expect(next.body.command).toBeNull();
    await db.query(`DELETE FROM ipy_device_command WHERE kind = 'dial' AND payload->>'number' = '9876512345'`);
  });

  it('refuses, with the reason, when the phone is not its own calling app', async () => {
    await phoneSays({ canControlCall: false });
    const res = await request(app).post('/api/telephony/call-control')
      .set('Authorization', `Bearer ${token}`).send({ action: 'speaker', on: true }).expect(200);
    expect(res.body.sent).toBe(false);
    expect(String(res.body.detail)).toMatch(/calling app/i);
  });
});
