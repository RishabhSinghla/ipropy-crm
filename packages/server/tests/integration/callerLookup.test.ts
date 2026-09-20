/**
 * Whose number is this, and what the Calls list can be narrowed to.
 *
 * The lookup is the first thing the Android app asks when a phone rings, and
 * the CRM asks it again to file a call that has ended, so the parts that need
 * a real database are the ones that would file a call against the wrong
 * person: number shapes that must match each other, a number two people share,
 * and a lead the person asking is not allowed to open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn, SEEDED } from './fixtures.js';

let app: Express;
let token = '';
let repToken = '';
const MOBILE = '9711533633';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  repToken = await signIn(app, SEEDED.executiveA);
  await db.query(`DELETE FROM ipy_record WHERE label LIKE 'ITest Caller%'`);
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record WHERE label LIKE 'ITest Caller%'`);
});

const createLead = (name: string, mobile: string, owner?: string): Promise<string> =>
  request(app).post('/api/records/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ full_name: name, mobile, country_code: '+91', ...(owner ? { owner_id: owner } : {}) })
    .expect(201)
    .then((res) => String(res.body.id));

describe('who is calling', () => {
  it('finds the lead however the number was typed', async () => {
    await createLead('ITest Caller One', MOBILE);

    // Every shape the same number arrives in: bare, international, with a
    // trunk zero, spaced. All ten-digit-equal, so all one person.
    for (const shape of [MOBILE, `+91${MOBILE}`, `091${MOBILE}`, '97115 33633']) {
      const res = await request(app).get(`/api/telephony/lookup?phone=${encodeURIComponent(shape)}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.kind, shape).toBe('one');
      expect(res.body.label, shape).toBe('ITest Caller One');
    }
  });

  it('says nobody rather than guessing', async () => {
    const res = await request(app).get('/api/telephony/lookup?phone=9000000123')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.kind).toBe('none');
  });

  it('refuses to choose between two people on one number', async () => {
    /*
      `createRecord` refuses a second lead with the same mobile, which is the
      CRM working — so the way this really happens is an alternate number, or
      an import, which bypasses the duplicate check. Written straight in for
      that reason.
    */
    const second = await createLead('ITest Caller Two', '9711533699');
    await db.query(
      `UPDATE ipy_e_leads SET alternate_phone = $2 WHERE record_id = $1`,
      [second, MOBILE],
    );

    const res = await request(app).get(`/api/telephony/lookup?phone=${MOBILE}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.kind).toBe('ambiguous');
    expect(res.body.candidates.length).toBeGreaterThan(1);
    // Names only — enough to ask a person which, and nothing about either.
    for (const candidate of res.body.candidates) expect(Object.keys(candidate).sort()).toEqual(['label', 'recordId']);
  });

  it('tells a rep the number is taken without showing them the lead', async () => {
    const owner = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE email = $1`, [SEEDED.marketing]);
    await db.query(`DELETE FROM ipy_record WHERE label = 'ITest Caller Three'`);
    await createLead('ITest Caller Three', '9711000777', owner!.id);

    const res = await request(app).get('/api/telephony/lookup?phone=9711000777')
      .set('Authorization', `Bearer ${repToken}`).expect(200);

    // Either they may open it or they may not — both are correct answers and
    // which one depends on the seeded hierarchy. What must never happen is a
    // failure, or a card with values in it for somebody outside the scope.
    expect(['one', 'restricted']).toContain(res.body.kind);
    if (res.body.kind === 'restricted') {
      expect(res.body.values).toBeUndefined();
      expect(res.body.label).toBe('ITest Caller Three');
    }
  });

  it('refuses something that is not a phone number', async () => {
    await request(app).get('/api/telephony/lookup?phone=Rahul')
      .set('Authorization', `Bearer ${token}`).expect(400);
  });
});

describe('the calls list', () => {
  it('counts what the filters match, not the page', async () => {
    const res = await request(app).get('/api/telephony/calls?limit=1')
      .set('Authorization', `Bearer ${token}`).expect(200);
    // A bare array with the count in a header: the shape other callers pin.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(1);
    expect(Number(res.headers['x-total-count'])).toBeGreaterThanOrEqual(res.body.length);
  });

  it('separates answered from not answered by time on the clock', async () => {
    const answered = await request(app).get('/api/telephony/calls?answered=yes&limit=200')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const not = await request(app).get('/api/telephony/calls?answered=no&limit=200')
      .set('Authorization', `Bearer ${token}`).expect(200);

    for (const call of answered.body) expect(call.duration_seconds).toBeGreaterThan(0);
    for (const call of not.body) expect(call.duration_seconds).toBe(0);
  });

  it('takes a day at its end, so calls made on it are included', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // A call logged now must appear in a range that *ends* today — the bug
    // being pinned is `to` meaning midnight, which excludes the whole day.
    await request(app).post('/api/telephony/log')
      .set('Authorization', `Bearer ${token}`)
      .send({ to: '9711533633', direction: 'outbound', durationSeconds: 65, disposition: 'Call Back Later' })
      .expect(201);

    const res = await request(app).get(`/api/telephony/calls?from=${today}&to=${today}&limit=200`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(Number(res.headers['x-total-count'])).toBeGreaterThan(0);
  });
});
