/**
 * Pressing Call at a desk rings the rep's own phone.
 *
 * The laptop cannot place a phone call. It used to be handed the number as a
 * `tel:` link, which asks the browser which application should open it — on a
 * Mac a dialog naming FaceTime, on a desktop usually nothing at all. So the
 * CRM asks the paired handset instead.
 *
 * Three things only a real database can answer, and all three are the ones
 * that would hurt:
 *
 *   * a rep with no paired phone gets a plain "no device" rather than an
 *     error, because their fallback is a working answer;
 *   * the instruction expires, so a handset back from a flat battery cannot
 *     ring a customer for a button pressed hours ago;
 *   * the phone can close the command out, so the CRM never has to guess
 *     whether the call actually rang.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let deviceToken = '';
let deviceId = '';

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
});

describe('dialling from the CRM', () => {
  it('says so plainly when this person has no paired phone', async () => {
    // Any phone the admin already paired in another spec would answer this
    // differently, so start from none of their own.
    await db.query(
      `UPDATE ipy_device SET is_active = false
        WHERE user_id = (SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com')`,
    );

    const res = await request(app)
      .post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '+91 98765 43210' })
      .expect(200);

    expect(res.body.sent).toBe(false);
    expect(res.body.reason).toBe('no-device');
  });

  it('queues the call against the phone, and the phone can close it out', async () => {
    const paired = await request(app)
      .post('/api/telephony/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Dial test handset' })
      .expect(201);
    deviceToken = paired.body.token;
    deviceId = paired.body.deviceId;
    expect(deviceToken).toBeTruthy();

    const res = await request(app)
      .post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '+91 98765 43210' })
      .expect(200);

    expect(res.body.sent).toBe(true);
    expect(res.body.device).toBe('Dial test handset');

    const queued = await db.queryOne<{ id: string; status: string; payload: { number: string } }>(
      `SELECT id, status, payload FROM ipy_device_command
        WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [deviceId],
    );
    expect(queued?.status).toBe('queued');
    // Spaces and the plus are the rep's formatting, not the dialler's.
    expect(queued?.payload.number).toBe('+919876543210');

    await request(app)
      .post(`/api/device/commands/${queued!.id}/result`)
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ ok: true })
      .expect(200);

    const done = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_device_command WHERE id = $1`, [queued!.id],
    );
    expect(done?.status).toBe('done');
  });

  it('never rings for an instruction that has gone stale', async () => {
    // Age the row the way a flat battery would: queued, and past its minute.
    await db.query(
      `INSERT INTO ipy_device_command (device_id, user_id, kind, payload, expires_at)
       SELECT $1, user_id, 'dial', '{"number":"+919999999999"}'::jsonb, now() - interval '5 minutes'
         FROM ipy_device WHERE id = $1`,
      [deviceId],
    );

    // The next dial sweeps it, so nothing is left claiming to be about to happen.
    await request(app)
      .post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '9811100000' })
      .expect(200);

    const stale = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_device_command
        WHERE device_id = $1 AND payload->>'number' = '+919999999999'`,
      [deviceId],
    );
    expect(stale?.status).toBe('expired');
  });

  it('will not close out a command belonging to another phone', async () => {
    const other = await request(app)
      .post('/api/telephony/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Somebody else’s handset' })
      .expect(201);

    const mine = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_device_command WHERE device_id = $1 AND status = 'queued'
        ORDER BY created_at DESC LIMIT 1`,
      [deviceId],
    );

    await request(app)
      .post(`/api/device/commands/${mine!.id}/result`)
      .set('Authorization', `Bearer ${other.body.token}`)
      .send({ ok: true })
      .expect(200);

    // Answered 200 and changed nothing: the device id is part of the write, so
    // there is no shape of request that lets one handset speak for another.
    const untouched = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_device_command WHERE id = $1`, [mine!.id],
    );
    expect(untouched?.status).toBe('queued');
  });
});
