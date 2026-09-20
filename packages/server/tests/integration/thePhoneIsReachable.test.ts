/**
 * The loop the owner keeps meeting the broken end of: press Call at a desk,
 * the phone collects it, the CRM knows what happened — and, before any of
 * that, the desk can see whether the phone could be reached at all.
 *
 * Every step here failed in production for a different reason, so each is
 * asserted separately rather than as one happy path.
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
  // Start from one known handset of this person's own.
  await db.query(
    `UPDATE ipy_device SET is_active = false
      WHERE user_id = (SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com')`,
  );
  const paired = await request(app).post('/api/telephony/devices')
    .set('Authorization', `Bearer ${token}`)
    .send({ label: 'Reachability test handset' })
    .expect(201);
  deviceId = paired.body.deviceId;
});

describe('is the phone there', () => {
  it('knows a phone is open the moment its app says so', async () => {
    const before = await db.queryOne<{ app_open_at: string | null }>(
      `SELECT app_open_at FROM ipy_device WHERE id = $1`, [deviceId]);
    expect(before?.app_open_at).toBeNull();

    const res = await request(app).post('/api/telephony/devices/app-open')
      .set('Authorization', `Bearer ${token}`).send({}).expect(200);
    expect(res.body.deviceId).toBe(deviceId);

    const after = await db.queryOne<{ app_open_at: string | null; last_seen_at: string | null }>(
      `SELECT app_open_at, last_seen_at FROM ipy_device WHERE id = $1`, [deviceId]);
    expect(after?.app_open_at).toBeTruthy();
    // Seen and open move together: an app that is open has plainly been heard
    // from, and a list that says otherwise is confusing rather than precise.
    expect(after?.last_seen_at).toBeTruthy();
  });

  it('shows that state, and how the last call ended, on the phones list', async () => {
    const res = await request(app).get('/api/telephony/devices')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const phone = (res.body as { id: string; app_open_at: string | null }[])
      .find((row) => row.id === deviceId);
    expect(phone?.app_open_at).toBeTruthy();
    expect(phone).toHaveProperty('last_dial_status');
  });

  it('hands a waiting call to the phone that asks for it, exactly once', async () => {
    /*
      Clear anything this admin already has waiting. Another suite dialling
      from the same account leaves its own queued row behind, and then two
      callers each legitimately claim a *different* command — which fails this
      test while the claim it is about works perfectly. A test that depends on
      what is already in the database reports the machine it ran on.
    */
    await db.query(
      `UPDATE ipy_device_command SET status = 'expired'
        WHERE status = 'queued'
          AND user_id = (SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com')`,
    );

    const queued = await request(app).post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '9711533633' })
      .expect(200);
    expect(queued.body.sent).toBe(true);

    /*
      The whole point of the claim being one statement: two things look for a
      waiting call — the socket event and the phone's own timer — and they
      must not both be given it, or the customer's phone rings twice.
    */
    const [first, second] = await Promise.all([
      request(app).get('/api/telephony/dial/pending').set('Authorization', `Bearer ${token}`),
      request(app).get('/api/telephony/dial/pending').set('Authorization', `Bearer ${token}`),
    ]);
    const handed = [first.body.command, second.body.command].filter(Boolean);
    expect(handed).toHaveLength(1);
    expect(handed[0].number).toBe('9711533633');

    // And the phone closing it out is what the desk reads back.
    await request(app).post(`/api/telephony/dial/${handed[0].id}/result`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ok: true, via: 'dialler' })
      .expect(200);

    const status = await request(app).get(`/api/telephony/dial/${handed[0].id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.status).toBe('done');
    expect(status.body.via).toBe('dialler');
  });

  it('a collected call reads as delivered before the phone says how it went', async () => {
    /*
      The desk watches this for a few seconds after somebody presses Call. The
      phone collects the instruction in under a second and closes it out only
      once the rep has taken the phone out of their pocket, so `delivered` is
      the only honest answer in between -- and on 20 September a call that rang
      for a minute was reported as "not confirmed" because nothing read it.
    */
    const queued = await request(app).post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '9811533633' })
      .expect(200);

    await request(app).get('/api/telephony/dial/pending')
      .set('Authorization', `Bearer ${token}`).expect(200);

    const status = await request(app).get(`/api/telephony/dial/${queued.body.commandId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.status).toBe('delivered');
    expect(status.body.via).toBeNull();
  });

  it('marks a phone as heard from whenever it uses its own token', async () => {
    /*
      The signal that did not exist. The background worker only contacts the
      CRM when there are new calls to upload, so a phone that is on and quiet
      looked exactly like one that was off.
    */
    const paired = await request(app).post('/api/telephony/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Quiet handset' })
      .expect(201);

    await request(app).get('/api/device/ping')
      .set('Authorization', `Bearer ${paired.body.token}`).expect(200);

    // The stamp is deliberately not awaited by the request that triggers it —
    // a status column must never delay a call upload — so this reads it after
    // giving that write a moment.
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    const row = await db.queryOne<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM ipy_device WHERE id = $1`, [paired.body.deviceId]);
    expect(row?.last_seen_at).toBeTruthy();
  });
});
