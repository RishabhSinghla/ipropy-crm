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

  it('lets the app close its own instruction when the plugin cannot place the call', async () => {
    /*
      The route that makes this work at all today. Every copy of the app in the
      field predates `placeCall`, so the native plugin fails, nothing is posted
      with the device token, and the instruction expires uncollected — 130 of
      them on production and not one ever taken. The app's own webview can
      still hand the number to the phone's dialler, and it closes the command
      through the signed-in session, which is the only credential it holds.
    */
    const res = await request(app)
      .post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '9811100001' })
      .expect(200);

    await request(app)
      .post(`/api/telephony/dial/${res.body.commandId}/result`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ok: true, via: 'dialler' })
      .expect(200);

    // And the desk is told *which* it was, because one of the two needs the
    // rep to pick the phone up and press the green button.
    const status = await request(app)
      .get(`/api/telephony/dial/${res.body.commandId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(status.body.status).toBe('done');
    expect(status.body.via).toBe('dialler');
  });

  it('lets a phone claim a call it missed while the app was asleep', async () => {
    /*
      Empty the queue first, and that is about the endpoint's contract rather
      than about tidiness. `/dial/pending` hands back the **oldest** waiting
      command — correct, because it is a queue and a phone that has been
      offline owes its earliest caller first. An earlier case in this file
      leaves one behind, so without this the assertion below reads that one
      and fails with two unrelated uuids, which looks like the endpoint
      picking at random.
    */
    await db.query(
      `DELETE FROM ipy_device_command
        WHERE kind = 'dial' AND status = 'queued'
          AND user_id = (SELECT id FROM ipy_user WHERE email = 'admin@ipropy.com')`,
    );

    const queued = await request(app)
      .post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '9811100003' })
      .expect(200);

    const pending = await request(app)
      .get('/api/telephony/dial/pending')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(pending.body.command.id).toBe(queued.body.commandId);
    expect(pending.body.command.number).toBe('9811100003');

    const claimed = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_device_command WHERE id = $1`, [queued.body.commandId],
    );
    expect(claimed?.status).toBe('delivered');

    const another = await request(app)
      .get('/api/telephony/dial/pending')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(another.body.command).toBeNull();
  });

  it('will not let one person close another person\'s call instruction', async () => {
    const res = await request(app)
      .post('/api/telephony/dial')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '9811100002' })
      .expect(200);

    const other = await signIn(app, 'priya.sharma@ipropy.com');
    await request(app)
      .post(`/api/telephony/dial/${res.body.commandId}/result`)
      .set('Authorization', `Bearer ${other}`)
      .send({ ok: true, via: 'dialler' })
      .expect(404);

    const untouched = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_device_command WHERE id = $1`, [res.body.commandId],
    );
    expect(untouched?.status).toBe('queued');
  });
});
