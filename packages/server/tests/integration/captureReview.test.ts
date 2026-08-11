/**
 * Confirming a visit.
 *
 * The contract this screen depends on: parsed values are shown, not applied,
 * until somebody says so — and when they do say so, the write goes through the
 * ordinary record service so validation, permissions and the audit trail all
 * behave exactly as they would from any other screen. This endpoint must not be
 * a side door into the record.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { SEEDED } from './fixtures.js';

let app: Express;
let token: string;
let otherToken: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'Admin@123' });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.body.token as string;
}

/** A finished visit carrying the sort of parse a voice note produces. */
async function visitWithParse(parsed: unknown, name = `Review ${randomUUID().slice(0, 6)}`): Promise<{ sessionId: string; recordId: string }> {
  const res = await request(app).post('/api/capture/sessions')
    .set('Authorization', `Bearer ${token}`)
    .send({ clientRef: randomUUID(), property: { module: 'properties', values: { name } } })
    .expect(201);

  const sessionId = res.body.session.id as string;
  await db.query(
    `UPDATE ipy_shoot_session
        SET parsed = $2::jsonb, transcript = $3, status = 'ready', ended_at = now(), voice_status = 'done'
      WHERE id = $1`,
    [sessionId, JSON.stringify(parsed), 'four BHK, asking three point two five crore'],
  );
  return { sessionId, recordId: res.body.session.recordId as string };
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await login(admin!.email);
  otherToken = await login(SEEDED.executiveB);
});

describe('GET /api/capture/sessions/:id — what the review screen sees', () => {
  it('shows what was heard beside what it became', async () => {
    // Without the heard text there is no way to tell a good decode from a
    // plausible-sounding bad one.
    const { sessionId } = await visitWithParse({
      values: { base_price: 32_500_000 },
      heard: { base_price: '3.25 cr' },
      unmatched: ['owner Sharma ji'],
    });

    const res = await request(app).get(`/api/capture/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);

    const price = res.body.suggestions.find((s: { field: string }) => s.field === 'base_price');
    expect(price).toBeTruthy();
    expect(price.heard).toBe('3.25 cr');
    expect(price.value).toBe(32_500_000);
    expect(price.formatted).toContain('3.25');
    expect(res.body.unmatched).toEqual(['owner Sharma ji']);
    // Field metadata comes along so a wrong value is correctable in place.
    expect(res.body.fields.base_price?.uitype).toBe('currency');
  });

  it('marks a suggestion that changes nothing, so it can be left out', async () => {
    const { sessionId, recordId } = await visitWithParse({ values: { base_price: 9_900_000 }, heard: {} });
    await db.query(`UPDATE ipy_e_properties SET base_price = 9900000 WHERE record_id = $1`, [recordId]);
    registry.invalidate();

    const res = await request(app).get(`/api/capture/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    const price = res.body.suggestions.find((s: { field: string }) => s.field === 'base_price');
    expect(price.changes).toBe(false);
  });

  it('drops a field name the model invented', async () => {
    const { sessionId } = await visitWithParse({ values: { not_a_real_field: 'x', base_price: 1_000_000 }, heard: {} });
    const res = await request(app).get(`/api/capture/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.suggestions.map((s: { field: string }) => s.field)).toEqual(['base_price']);
  });

  it('never offers a field that cannot be written', async () => {
    // total_price is the readonly "All-inclusive Price" formula. Offering it
    // would let somebody tick a value, press Confirm, and be told it saved
    // while updateRecord silently ignored it.
    const { sessionId } = await visitWithParse({
      values: { total_price: 50_000_000, base_price: 4_000_000 }, heard: {},
    });
    const res = await request(app).get(`/api/capture/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.suggestions.map((s: { field: string }) => s.field)).toEqual(['base_price']);
  });

  it('is not readable by another user', async () => {
    const { sessionId } = await visitWithParse({ values: {}, heard: {} });
    await request(app).get(`/api/capture/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${otherToken}`).expect(404);
  });
});

describe('POST /api/capture/sessions/:id/review — confirming', () => {
  it('writes only what was accepted, and marks the visit done', async () => {
    const { sessionId, recordId } = await visitWithParse({
      values: { base_price: 32_500_000, configuration: '4 BHK' },
      heard: { base_price: '3.25 cr' },
    });

    // The reviewer unticked the configuration; only the price should land.
    await request(app).post(`/api/capture/sessions/${sessionId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({ values: { base_price: 32_500_000 } })
      .expect(200);

    const row = await db.queryOne<{ base_price: string; configuration: string | null }>(
      `SELECT base_price, configuration FROM ipy_e_properties WHERE record_id = $1`, [recordId],
    );
    expect(Number(row!.base_price)).toBe(32_500_000);
    expect(row!.configuration).toBeNull();

    const session = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_shoot_session WHERE id = $1`, [sessionId],
    );
    expect(session?.status).toBe('reviewed');
  });

  it('takes a corrected value over the parsed one', async () => {
    // The case the screen exists for: 3.25 heard when 3.35 was said.
    const { sessionId, recordId } = await visitWithParse({
      values: { base_price: 32_500_000 }, heard: { base_price: '3.25 cr' },
    });

    await request(app).post(`/api/capture/sessions/${sessionId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({ values: { base_price: 33_500_000 } })
      .expect(200);

    const row = await db.queryOne<{ base_price: string }>(
      `SELECT base_price FROM ipy_e_properties WHERE record_id = $1`, [recordId],
    );
    expect(Number(row!.base_price)).toBe(33_500_000);
  });

  it('accepts nothing at all — "none of that was right"', async () => {
    const { sessionId, recordId } = await visitWithParse({ values: { base_price: 1 }, heard: {} });

    await request(app).post(`/api/capture/sessions/${sessionId}/review`)
      .set('Authorization', `Bearer ${token}`).send({ values: {} }).expect(200);

    const row = await db.queryOne<{ base_price: string | null }>(
      `SELECT base_price FROM ipy_e_properties WHERE record_id = $1`, [recordId],
    );
    expect(row!.base_price).toBeNull();
    const session = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_shoot_session WHERE id = $1`, [sessionId],
    );
    expect(session?.status).toBe('reviewed');
  });

  it('still validates — it is not a side door into the record', async () => {
    const { sessionId } = await visitWithParse({ values: {}, heard: {} });
    const res = await request(app).post(`/api/capture/sessions/${sessionId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({ values: { base_price: 'not a number at all' } });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const session = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_shoot_session WHERE id = $1`, [sessionId],
    );
    // A rejected write must not leave the visit marked as dealt with.
    expect(session?.status).toBe('ready');
  });

  it('cannot be used to confirm somebody else\'s visit', async () => {
    const { sessionId } = await visitWithParse({ values: {}, heard: {} });
    await request(app).post(`/api/capture/sessions/${sessionId}/review`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ values: { base_price: 1_000_000 } })
      .expect(404);
  });

  it('needs authentication', async () => {
    const { sessionId } = await visitWithParse({ values: {}, heard: {} });
    await request(app).post(`/api/capture/sessions/${sessionId}/review`).send({ values: {} }).expect(401);
  });
});
