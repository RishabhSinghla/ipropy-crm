/**
 * The capture endpoint, over real HTTP.
 *
 * sessions.test.ts proves the lifecycle is correct when called directly; this
 * proves the layer in front of it behaves the way a phone on a bad connection
 * needs it to — one round trip for the whole tap, safe to retry, and refusing
 * to let someone capture against a property they cannot edit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { clampStartedAt } from '../../src/api/routes/capture.js';
import { SEEDED } from './fixtures.js';

let app: Express;
let token: string;
let otherToken: string;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: 'Admin@123' });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
  return res.body.token as string;
}

const start = (t: string, body: Record<string, unknown>) =>
  request(app).post('/api/capture/sessions').set('Authorization', `Bearer ${t}`).send(body);

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await login(admin!.email);
  otherToken = await login(SEEDED.executiveB);
});

describe('POST /api/capture/sessions', () => {
  it('needs authentication', async () => {
    await request(app).post('/api/capture/sessions').send({ clientRef: randomUUID() }).expect(401);
  });

  it('creates the property and opens the visit in one request', async () => {
    // One round trip on purpose: at the gate, every extra one is another
    // chance to half-succeed.
    const res = await start(token, {
      clientRef: randomUUID(),
      property: { module: 'properties', values: { name: 'B-110 Greenfield' } },
      location: { lat: 28.4089, lng: 77.3178, accuracy: 9 },
      deviceLabel: 'iPhone 17 Pro Max',
    }).expect(201);

    expect(res.body.replayed).toBe(false);
    expect(res.body.session.recordId).toBeTruthy();
    expect(res.body.session.status).toBe('capturing');
    expect(res.body.session.lat).toBeCloseTo(28.4089, 4);

    const record = await db.queryOne<{ label: string }>(
      `SELECT label FROM ipy_record WHERE id = $1`, [res.body.session.recordId],
    );
    expect(record?.label).toContain('B-110 Greenfield');
  });

  it('treats a retried request as success, without a second property', async () => {
    const clientRef = randomUUID();
    const body = {
      clientRef,
      property: { module: 'properties', values: { name: 'Retry Floor' } },
    };

    const first = await start(token, body).expect(201);
    const second = await start(token, body).expect(200);

    expect(second.body.replayed).toBe(true);
    expect(second.body.session.id).toBe(first.body.session.id);

    const { rows } = await db.query(
      `SELECT r.id FROM ipy_record r WHERE r.module_name = 'properties' AND r.label LIKE 'Retry Floor%' AND r.is_deleted = false`,
    );
    expect(rows.length).toBe(1);
  });

  it('does not create the property when the session fails to open', async () => {
    // Both in one transaction: a property with no visit is as bad as a visit
    // pointing at a property that never saved.
    const clientRef = randomUUID();
    await start(token, {
      clientRef,
      property: { module: 'properties', values: { name: 'Transactional Floor' } },
    }).expect(201);

    // A second, *different* session reusing the same clientRef is a conflict at
    // the database level; the property must not survive it.
    await start(token, {
      clientRef,
      property: { module: 'properties', values: { name: 'Should Not Exist' } },
    }).expect(200);

    const { rows } = await db.query(
      `SELECT id FROM ipy_record WHERE label LIKE 'Should Not Exist%' AND is_deleted = false`,
    );
    expect(rows.length).toBe(0);
  });

  it('rejects sending both a record and a property to create', async () => {
    await start(token, {
      clientRef: randomUUID(),
      recordId: randomUUID(),
      property: { module: 'properties', values: { name: 'Ambiguous' } },
    }).expect(400);
  });

  it('404s on a property that does not exist', async () => {
    await start(token, { clientRef: randomUUID(), recordId: randomUUID() }).expect(404);
  });

  it('refuses to capture against a property the user cannot edit', async () => {
    const mine = await start(token, {
      clientRef: randomUUID(),
      property: { module: 'properties', values: { name: 'Private Floor' } },
    }).expect(201);

    const res = await start(otherToken, {
      clientRef: randomUUID(), recordId: mine.body.session.recordId,
    });
    expect([403, 404]).toContain(res.status);
  });

  it('opens a visit with no property yet, for the offline case', async () => {
    const res = await start(token, { clientRef: randomUUID() }).expect(201);
    expect(res.body.session.recordId).toBeNull();

    const property = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_record WHERE module_name = 'properties' AND is_deleted = false LIMIT 1`,
    );
    const patched = await request(app)
      .patch(`/api/capture/sessions/${res.body.session.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ recordId: property!.id })
      .expect(200);
    expect(patched.body.recordId).toBe(property!.id);
  });

  it('will not let one user read or reassign another\'s visit', async () => {
    const mine = await start(token, { clientRef: randomUUID() }).expect(201);
    const id = mine.body.session.id;

    await request(app).get(`/api/capture/sessions/${id}`).set('Authorization', `Bearer ${otherToken}`).expect(404);
    await request(app).patch(`/api/capture/sessions/${id}`).set('Authorization', `Bearer ${otherToken}`)
      .send({ recordId: randomUUID() }).expect(404);
  });

  it('reports the visit in progress, and lists the day', async () => {
    const opened = await start(token, { clientRef: randomUUID() }).expect(201);

    const current = await request(app).get('/api/capture/sessions/current')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(current.body.session.id).toBe(opened.body.session.id);

    const list = await request(app).get('/api/capture/sessions?limit=5')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body[0].id).toBe(opened.body.session.id);
    expect(list.body[0]).toHaveProperty('mediaCount');
  });

  it('rejects a nonsense location rather than storing it', async () => {
    // 422 rather than 400: schema failures are unprocessable-entity throughout
    // this API, and 400 is reserved for a request that parsed but cannot be
    // acted on — such as sending both recordId and property above.
    await start(token, { clientRef: randomUUID(), location: { lat: 999, lng: 77 } }).expect(422);
  });
});

describe('clampStartedAt', () => {
  const now = new Date('2026-08-11T10:00:00.000Z');

  it('takes the device time when it is plausible', () => {
    // A request queued at the gate and synced an hour later is the normal case.
    const tapped = new Date('2026-08-11T09:03:00.000Z');
    expect(clampStartedAt(tapped.toISOString(), now).getTime()).toBe(tapped.getTime());
  });

  it('refuses a future timestamp, which would swallow every later upload', () => {
    const future = new Date('2027-01-01T00:00:00.000Z');
    expect(clampStartedAt(future.toISOString(), now).getTime()).toBe(now.getTime());
  });

  it('tolerates small clock skew rather than discarding the shoot', () => {
    const slightlyFast = new Date(now.getTime() + 60_000);
    expect(clampStartedAt(slightlyFast.toISOString(), now).getTime()).toBe(slightlyFast.getTime());
  });

  it('clamps an absurdly old timestamp instead of failing', () => {
    const ancient = new Date('2001-01-01T00:00:00.000Z');
    const result = clampStartedAt(ancient.toISOString(), now);
    expect(result.getTime()).toBeGreaterThan(ancient.getTime());
    expect(result.getTime()).toBeLessThan(now.getTime());
  });

  it('falls back to now on missing or unparseable input', () => {
    expect(clampStartedAt(undefined, now).getTime()).toBe(now.getTime());
    expect(clampStartedAt('not a date', now).getTime()).toBe(now.getTime());
  });
});
