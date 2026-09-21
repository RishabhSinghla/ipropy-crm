/**
 * What the call console writes when a rep presses Save.
 *
 * The console offers Hot / Warm / Cold beside the notes, and the obvious home
 * for that — the record's `rating` — is the wrong one: that field is read-only
 * because the scorer owns it and overwrites anything a person types. So the
 * rep's read of one conversation lives on the call, and this proves it
 * survives the round trip rather than being accepted and dropped.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

let app: Express;
let token = '';
let recordId = '';

beforeAll(async () => {
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  const created = await request(app).post('/api/records/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ full_name: 'Console Test Buyer', mobile: '9812345678', country_code: '91' })
    .expect(201);
  recordId = created.body.id;
});

describe('saving from the call console', () => {
  it('keeps how warm they sounded on the call, not on the record', async () => {
    await request(app).post('/api/telephony/log')
      .set('Authorization', `Bearer ${token}`)
      .send({
        to: '9812345678', recordId, module: 'leads', direction: 'outbound',
        durationSeconds: 130, disposition: 'Interested', notes: 'Wants a site visit',
        intent: 'hot',
      })
      .expect(201);

    const row = await db.queryOne<{ intent: string | null; disposition: string | null }>(
      `SELECT intent, disposition FROM ipy_call WHERE record_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [recordId],
    );
    expect(row?.intent).toBe('hot');
    expect(row?.disposition).toBe('Interested');

    // And the record's own rating is untouched — the scorer owns that column.
    const record = await request(app).get(`/api/records/leads/${recordId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(record.body.values.rating ?? null).not.toBe('hot');
  });

  it('refuses an intent that is not one of the three', async () => {
    await request(app).post('/api/telephony/log')
      .set('Authorization', `Bearer ${token}`)
      .send({
        to: '9812345678', recordId, module: 'leads', direction: 'outbound',
        durationSeconds: 60, disposition: 'Interested', intent: 'boiling',
      })
      // Validation refusals answer 422 here, not 400.
      .expect(422);
  });

  it('a call with no intent is ordinary, not an error', async () => {
    await request(app).post('/api/telephony/log')
      .set('Authorization', `Bearer ${token}`)
      .send({
        to: '9812345678', recordId, module: 'leads', direction: 'outbound',
        durationSeconds: 45, disposition: 'Not Reachable',
      })
      .expect(201);
  });

  it('the calls list hands the intent back, so a call can be read as it was recorded', async () => {
    const res = await request(app).get(`/api/telephony/calls?recordId=${recordId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    const withIntent = (res.body as { intent?: string | null }[]).filter((c) => c.intent === 'hot');
    expect(withIntent.length).toBeGreaterThan(0);
  });
});
