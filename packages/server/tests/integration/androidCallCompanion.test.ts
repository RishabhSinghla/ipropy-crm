/**
 * The Android companion, from pairing to a contact that has moved to Contacted.
 *
 * The team starts working from this on 12 September 2026, and until the day
 * before it was broken on production in a way no test could see: `syncCalls`
 * stamped `last_contacted_at` and `contact_attempts`, both permanently deleted
 * there, so every answered call that matched a contact raised 42703. The call
 * row was already written by then, so the call appeared and the contact never
 * moved — and the sync endpoint answered an error to the phone, which retries.
 *
 * So this walks the whole path rather than any one endpoint: pair, check in,
 * upload a call log, re-upload it, and assert the contact moved. Each step is
 * something a rep does on a normal morning.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let deviceToken = '';
let deviceId = '';
let leadId = '';
const stamp = Date.now();
const MOBILE = `98${String(stamp).slice(-8)}`;

// Android's CallLog.Calls types: 1 incoming, 2 outgoing, 3 missed.
const OUTGOING = 2;
const MISSED = 3;

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');

  const lead = await request(app).post('/api/records/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ full_name: `QA Android ${stamp}`, mobile: MOBILE, lead_status: 'New' });
  leadId = lead.body.id;
});

describe('the Android call companion', () => {
  it('pairs a phone and hands back a token exactly once', async () => {
    const res = await request(app).post('/api/telephony/devices')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'QA Pixel', phoneNumber: '+919000000001', model: 'Pixel 7' });

    expect(res.status).toBe(201);
    expect(res.body.token, 'the phone has nothing to authenticate with').toBeTruthy();
    deviceToken = res.body.token;
    deviceId = res.body.deviceId;
  });

  it('lets the phone check in and read its policy', async () => {
    const ping = await request(app).get('/api/device/ping')
      .set('Authorization', `Bearer ${deviceToken}`);
    expect(ping.status).toBe(200);

    const policy = await request(app).get('/api/device/policy')
      .set('Authorization', `Bearer ${deviceToken}`);
    expect(policy.status).toBe(200);
    // Location reporting ships off and must stay off until somebody turns it on.
    expect(policy.body.location?.enabled).toBe(false);
  });

  it('files a call log, matches the contact, and skips a private number', async () => {
    const entries = [
      { externalId: `qa-${stamp}-1`, number: MOBILE, type: OUTGOING, timestamp: stamp - 600_000, durationSeconds: 95 },
      { externalId: `qa-${stamp}-2`, number: MOBILE, type: MISSED, timestamp: stamp - 300_000, durationSeconds: 0 },
      // Withheld numbers arrive empty; there is nothing to file against.
      { externalId: `qa-${stamp}-3`, number: '', type: OUTGOING, timestamp: stamp - 200_000, durationSeconds: 0 },
    ];
    const res = await request(app).post('/api/device/calls')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ entries });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.skipped).toBe(1);
    expect(res.body.matched, 'the call did not find the contact by number').toBeGreaterThanOrEqual(1);
  });

  it('creates no duplicates when the phone re-sends its whole log', async () => {
    // Which it does on every sync — the log is not a queue it can drain.
    const entries = [
      { externalId: `qa-${stamp}-1`, number: MOBILE, type: OUTGOING, timestamp: stamp - 600_000, durationSeconds: 95 },
      { externalId: `qa-${stamp}-2`, number: MOBILE, type: MISSED, timestamp: stamp - 300_000, durationSeconds: 0 },
    ];
    const res = await request(app).post('/api/device/calls')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ entries });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.duplicates).toBeGreaterThanOrEqual(2);
  });

  it('moves the contact to Contacted — the step that was raising 42703', async () => {
    const res = await request(app).get(`/api/records/leads/${leadId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const status = res.body.values?.lead_status ?? res.body.values?.status;
    expect(status).toBe('Contacted');
  });

  /**
   * The prompt is the whole point of the morning.
   *
   * A rep rings somebody from their own handset; the phone uploads the log a
   * few seconds later; the CRM has to ask what happened while they still
   * remember. If the synced call never reaches `/needs-disposition` the
   * feature is a call log, and the pipeline stays exactly as wrong as it was
   * before anybody picked up a phone.
   */
  it('asks what happened about the call the phone just filed', async () => {
    const pending = await request(app).get('/api/telephony/needs-disposition')
      .set('Authorization', `Bearer ${token}`);
    expect(pending.status).toBe(200);

    const answered = pending.body.find(
      (c: { duration_seconds: number; record_id: string | null }) =>
        c.record_id === leadId && c.duration_seconds === 95,
    );
    expect(answered, 'the answered call is not being asked about').toBeTruthy();

    // A missed call is not a conversation, and asking about one every morning
    // is how a prompt gets dismissed without being read.
    const missed = pending.body.find(
      (c: { duration_seconds: number; record_id: string | null }) =>
        c.record_id === leadId && c.duration_seconds === 0,
    );
    expect(missed, 'a missed call should not be asked about').toBeFalsy();

    const answer = await request(app).post(`/api/telephony/calls/${answered.id}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'Site Visit Scheduled', notes: 'Sunday 11am' });
    expect(answer.status).toBe(200);

    // And it stops asking, or the rep answers the same call all day.
    const after = await request(app).get('/api/telephony/needs-disposition')
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.some((c: { id: string }) => c.id === answered.id)).toBe(false);
  });

  it('shows the calls in the CRM and lets one be dispositioned', async () => {
    const list = await request(app).get('/api/telephony/calls?pageSize=50')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    // A bare array, not a paged envelope.
    const rows = Array.isArray(list.body) ? list.body : (list.body.rows ?? []);
    const mine = rows.filter((c: { record_id?: string }) => c.record_id === leadId);
    expect(mine.length).toBeGreaterThanOrEqual(2);

    const dispo = await request(app).post(`/api/telephony/calls/${mine[0].id}/disposition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'Interested', notes: 'QA' });
    expect(dispo.status).toBeLessThan(400);
  });

  it('refuses a phone once it is revoked', async () => {
    const revoke = await request(app).delete(`/api/telephony/devices/${deviceId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(revoke.status).toBe(200);

    const after = await request(app).get('/api/device/ping')
      .set('Authorization', `Bearer ${deviceToken}`);
    expect(after.status).toBe(401);
  });
});
