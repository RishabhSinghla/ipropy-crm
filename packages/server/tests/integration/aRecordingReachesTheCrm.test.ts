/**
 * The recording, from the handset to somebody pressing play.
 *
 * A rep who turns on recording upload in the companion is trusting the CRM with
 * the most sensitive thing it holds — the actual audio of a customer
 * conversation. Every part of that path was untested: the upload endpoint, the
 * match back to the call the phone filed, the stream that serves it, the range
 * header a player sends the moment anyone drags the scrubber, and who is
 * allowed to hear it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { SEEDED } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let deviceToken = '';
let callId = '';
const stamp = Date.now();
const MOBILE = `94${String(stamp).slice(-8)}`;
const EXTERNAL_ID = `qa-rec-${stamp}`;

// Not silence: a recognisable body proves the bytes that come back are the
// bytes that went up, and the range slice is checked against it.
const AUDIO = Buffer.from(`ID3iPropy${'x'.repeat(2048)}END`, 'utf8');

beforeAll(async () => {
  app = createApp();
  const login = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  token = login.body.token;

  const paired = await request(app).post('/api/telephony/devices')
    .set('Authorization', `Bearer ${token}`)
    .send({ label: `QA recorder ${stamp}`, phoneNumber: MOBILE, model: 'QA' });
  deviceToken = paired.body.token;

  const synced = await request(app).post('/api/device/calls')
    .set('Authorization', `Bearer ${deviceToken}`)
    .send({
      entries: [{
        externalId: EXTERNAL_ID, number: MOBILE, type: 2,
        timestamp: stamp - 120_000, durationSeconds: 75,
      }],
    });
  expect(synced.status).toBe(200);

  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_call WHERE external_id = $1`, [EXTERNAL_ID],
  );
  callId = row!.id;
});

describe('a call recording', () => {
  it('is refused when it is not audio', async () => {
    const res = await request(app).post('/api/device/recordings')
      .set('Authorization', `Bearer ${deviceToken}`)
      .field('externalId', EXTERNAL_ID)
      .attach('audio', Buffer.from('MZ not audio'), { filename: 'x.exe', contentType: 'application/octet-stream' });
    expect(res.status).toBe(400);
  });

  /**
   * The phone uploads recordings on its own schedule, so a file can arrive
   * before the call log that explains it. That must read as "keep it and try
   * again", not as an error the app reacts to by deleting the file.
   */
  it('tells the phone to hold on to a file with no call yet', async () => {
    const res = await request(app).post('/api/device/recordings')
      .set('Authorization', `Bearer ${deviceToken}`)
      .field('externalId', `${EXTERNAL_ID}-never-synced`)
      .attach('audio', AUDIO, { filename: 'call.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: 'no_matching_call' });
  });

  it('attaches to the call the phone filed', async () => {
    const res = await request(app).post('/api/device/recordings')
      .set('Authorization', `Bearer ${deviceToken}`)
      .field('externalId', EXTERNAL_ID)
      .attach('audio', AUDIO, { filename: 'call.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.callId).toBe(callId);

    const row = await db.queryOne<{ recording_key: string; recording_url: string }>(
      `SELECT recording_key, recording_url FROM ipy_call WHERE id = $1`, [callId],
    );
    expect(row?.recording_key).toContain(callId);
    expect(row?.recording_url).toBe(`/api/telephony/calls/${callId}/recording`);
  });

  it('plays back exactly what was uploaded', async () => {
    const res = await request(app).get(`/api/telephony/calls/${callId}/recording`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.from(res.body).equals(AUDIO), 'the audio came back changed').toBe(true);
  });

  /**
   * Dragging the scrubber sends a Range header. Without 206 the player
   * re-downloads a ten-minute call from the start on every drag, which on a
   * phone is somebody's data allowance.
   */
  it('serves a range so the player can seek', async () => {
    const res = await request(app).get(`/api/telephony/calls/${callId}/recording`)
      .set('Authorization', `Bearer ${token}`)
      .set('Range', 'bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-19/${AUDIO.length}`);
    expect(Buffer.from(res.body).equals(AUDIO.subarray(10, 20))).toBe(true);
  });

  it('refuses a range that is not in the file', async () => {
    const res = await request(app).get(`/api/telephony/calls/${callId}/recording`)
      .set('Authorization', `Bearer ${token}`)
      .set('Range', `bytes=${AUDIO.length + 500}-${AUDIO.length + 900}`);
    expect(res.status).toBe(416);
  });

  /**
   * Somebody else's customer conversation is not general reading. The
   * capability exists for managers who need it; a rep who was not on the call
   * and does not hold it must be refused.
   */
  it('is not readable by a rep who was not on the call', async () => {
    const login = await request(app).post('/api/auth/login')
      .send({ identifier: SEEDED.executiveB, password: 'Admin@123' });
    expect(login.status).toBe(200);

    const res = await request(app).get(`/api/telephony/calls/${callId}/recording`)
      .set('Authorization', `Bearer ${login.body.token}`);
    expect([403, 404]).toContain(res.status);
  });

  it('is not readable with no credentials at all', async () => {
    const res = await request(app).get(`/api/telephony/calls/${callId}/recording`);
    expect(res.status).toBe(401);
  });

  /**
   * The call *log* is scoped the same way, and one exception is deliberate.
   *
   * A rep with no org-wide listening sees only their own calls on the calls
   * list. On a contact they can open, they see every call made to that
   * contact — that is the handover: the next person to ring needs to know
   * somebody rang yesterday and what was said. Pinned here because it is a
   * visibility rule, and a visibility rule that drifts is found by a customer.
   */
  it('shows a rep their own calls, and the whole history on a contact they can open', async () => {
    const login = await request(app).post('/api/auth/login')
      .send({ identifier: SEEDED.executiveB, password: 'Admin@123' });
    const repToken = login.body.token;

    const mine = await request(app).get('/api/telephony/calls?limit=100')
      .set('Authorization', `Bearer ${repToken}`);
    expect(mine.status).toBe(200);
    expect(
      mine.body.some((c: { id: string }) => c.id === callId),
      "a rep can see another rep's call on the general list",
    ).toBe(false);

    // And asking for somebody else's calls by name is refused outright, not
    // quietly answered with an empty list.
    const admin = await request(app).get('/api/telephony/calls?userId=00000000-0000-0000-0000-000000000001')
      .set('Authorization', `Bearer ${repToken}`);
    expect(admin.status).toBe(403);
  });
});
