/**
 * The HTTP surface, driven through the real Express app.
 *
 * recordService.test.ts proves the engine is correct when called directly.
 * This proves the layer in front of it is wired correctly: that auth is
 * actually required, that a token identifies the right user, that route
 * handlers pass the caller's own scope down rather than a privileged one, and
 * that the unauthenticated public router exposes only what it is supposed to.
 *
 * A permission engine that works in isolation but is handed the wrong context
 * by a route would pass every test in the other file and still leak data, so
 * these go through supertest rather than calling services directly.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { SEEDED } from './fixtures.js';

let app: Express;
let adminToken: string;
let executiveToken: string;
let telecallerToken: string;

/** Log in over HTTP so the token is minted the same way a browser gets one. */
async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
  return res.body.token as string;
}

beforeAll(async () => {
  // The API normally warms these during boot (index.ts); supertest bypasses
  // that, and the record routes need the registry populated.
  await registry.warmup();
  app = createApp();

  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  // Seeded demo users share one password — see db/seed/rbac.ts.
  adminToken = await login(admin!.email, 'Admin@123');
  executiveToken = await login(SEEDED.executiveA, 'Admin@123');
  telecallerToken = await login(SEEDED.telecaller, 'Admin@123');
});

describe('authentication', () => {
  it('rejects an unauthenticated request to a data route', async () => {
    await request(app).get('/api/records/leads').expect(401);
  });

  it('rejects a garbage bearer token', async () => {
    await request(app)
      .get('/api/records/leads')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('rejects a wrong password without revealing whether the email exists', async () => {
    const badPassword = await request(app)
      .post('/api/auth/login').send({ email: SEEDED.executiveA, password: 'wrong-password' });
    const noSuchUser = await request(app)
      .post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' });

    expect(badPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // Identical responses — a difference here is a user-enumeration oracle.
    expect(badPassword.body.error).toEqual(noSuchUser.body.error);
  });

  it('identifies the caller from their token', async () => {
    const res = await request(app)
      .get('/api/auth/me').set('Authorization', `Bearer ${executiveToken}`).expect(200);
    expect(res.body.email).toBe(SEEDED.executiveA);
  });

  it('reports health without a token', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('connected');
  });
});

describe('records API', () => {
  it('creates, reads, updates and deletes through HTTP', async () => {
    const create = await request(app)
      .post('/api/records/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ first_name: 'Api', last_name: `Roundtrip-${Date.now()}`, mobile: '+919812345678' })
      .expect(201);

    const id = create.body.id as string;
    expect(id).toBeTruthy();

    await request(app)
      .patch(`/api/records/leads/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ first_name: 'Renamed' })
      .expect(200);

    const read = await request(app)
      .get(`/api/records/leads/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(read.body.values.first_name).toBe('Renamed');

    await request(app)
      .delete(`/api/records/leads/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app)
      .get(`/api/records/leads/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('rejects a create that violates a mandatory field, naming the field', async () => {
    // 422 rather than 400: the body parsed fine, it just isn't semantically
    // acceptable. The named field is what lets the form highlight the input.
    const res = await request(app)
      .post('/api/records/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ first_name: 'NoSurname' })
      .expect(422);

    expect(res.body.error).toBe('validation_error');
    // `mobile` is the mandatory one. last_name is NOT NULL DEFAULT '' at the
    // DB level but deliberately not marked mandatory in metadata, so a lead
    // captured from a webform with only a phone number is still valid.
    expect(res.body.details.fields.map((f: { field: string }) => f.field)).toContain('mobile');
  });

  it('404s an unknown module rather than leaking a SQL error', async () => {
    const res = await request(app)
      .get('/api/records/definitely_not_a_module')
      .set('Authorization', `Bearer ${adminToken}`);
    expect([400, 404]).toContain(res.status);
    expect(res.text).not.toMatch(/syntax error|relation .* does not exist/i);
  });
});

describe('permission boundaries over HTTP', () => {
  it('strips field-permission-hidden values from the API response too', async () => {
    // The route must hand recordService the caller's scope, not a privileged
    // one. Same policy as the service-level test: a tele-caller cannot see
    // property pricing.
    const list = await request(app)
      .get('/api/records/properties?pageSize=1')
      .set('Authorization', `Bearer ${telecallerToken}`)
      .expect(200);

    expect(list.body.rows).toHaveLength(1);
    const values = list.body.rows[0].values as Record<string, unknown>;
    expect(Object.keys(values)).not.toContain('base_price');
    expect(Object.keys(values)).not.toContain('rate_per_sqft');

    // And the admin genuinely can see them, so the assertion above is not
    // passing merely because the field is absent for everyone.
    const asAdmin = await request(app)
      .get('/api/records/properties?pageSize=1')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Object.keys(asAdmin.body.rows[0].values)).toContain('base_price');
  });

  it('refuses a module the caller has no access to', async () => {
    const res = await request(app)
      .get('/api/records/payments')
      .set('Authorization', `Bearer ${telecallerToken}`);
    expect([403, 404]).toContain(res.status);
  });
});

describe('public API', () => {
  it('serves projects with no authentication', async () => {
    const res = await request(app).get('/api/public/projects').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('exposes only whitelisted fields, never internal ones', async () => {
    const res = await request(app).get('/api/public/projects').expect(200);
    const project = res.body.items[0];
    if (!project) return;

    // public.ts hand-picks its SELECT precisely so record-level bookkeeping
    // and commercially sensitive columns can't ride along.
    for (const leaked of ['owner_id', 'created_by', 'is_deleted', 'custom_fields']) {
      expect(Object.keys(project)).not.toContain(leaked);
    }
  });

  it('does not accept writes on the public router', async () => {
    const res = await request(app).post('/api/public/projects').send({ name: 'Injected' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('hides records that are not published to the web', async () => {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM ipy_e_projects p
         JOIN ipy_record r ON r.id = p.record_id
        WHERE r.is_deleted = false
          AND COALESCE((p.custom_fields->>'publish_to_web')::boolean, true) = false`,
    );
    const unpublished = Number(rows[0].count);

    const res = await request(app).get('/api/public/projects?pageSize=200').expect(200);
    const total = res.body.total as number;

    const { rows: allRows } = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM ipy_e_projects p
         JOIN ipy_record r ON r.id = p.record_id WHERE r.is_deleted = false`,
    );
    // The public list is at most "everything minus the explicitly unpublished"
    // — status filtering narrows it further, which is why this is an
    // inequality rather than an exact match.
    expect(total).toBeLessThanOrEqual(Number(allRows[0].count) - unpublished);
  });
});

/**
 * The general /api budget is keyed per signed-in user, not per IP.
 *
 * This matters for how the product is actually used: a sales team works from
 * one office behind one NAT, so IP keying would put everyone in a single
 * 600/min bucket and let one busy user throttle their colleagues. It is the
 * kind of thing that looks fine in dev — one developer, one IP, one user — and
 * only shows up once a real team is on it.
 *
 * Asserted through the response headers rather than by exhausting the limit,
 * which would need 600 requests and leave the bucket spent for later tests.
 */
describe('API rate limiting', () => {
  const remaining = (res: request.Response): number => Number(res.headers['ratelimit-remaining']);

  const asUser = (token: string) =>
    request(app).get('/api/meta/modules').set('Authorization', `Bearer ${token}`);

  it('gives each signed-in user their own budget', async () => {
    const before = remaining(await asUser(executiveToken).expect(200));

    // Spend some of the admin's budget. If the two shared a bucket, this would
    // come straight out of the executive's.
    for (let i = 0; i < 10; i++) await asUser(adminToken).expect(200);

    const after = remaining(await asUser(executiveToken).expect(200));
    // Only the executive's own two probes are charged to them.
    expect(before - after).toBe(1);
  });

  it('charges the admin their own requests', async () => {
    const before = remaining(await asUser(adminToken).expect(200));
    await asUser(adminToken).expect(200);
    const after = remaining(await asUser(adminToken).expect(200));
    expect(before - after).toBe(2);
  });

  it('does not mint a fresh budget for an unverifiable token', async () => {
    // Otherwise anyone could sidestep the limit entirely by sending a new
    // made-up token with every request.
    const first = remaining(
      await request(app).get('/api/meta/modules').set('Authorization', 'Bearer forged.token.one'),
    );
    const second = remaining(
      await request(app).get('/api/meta/modules').set('Authorization', 'Bearer forged.token.two'),
    );
    expect(second).toBeLessThan(first);
  });
});
