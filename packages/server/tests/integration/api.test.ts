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
      .get('/api/auth/me').set('Authorization', `Bearer ${executiveToken}`);

    /*
      Asserted with the body, not `.expect(200)`.

      This has failed intermittently in CI and passes both alone and in a full
      local run, and `.expect(200)` reports only "got 401" — which is the same
      line whether the token was never minted, the account was deactivated, or
      the user no longer exists. `requireAuth` distinguishes all three in the
      message it returns, and throwing that away is what makes a rare failure
      cost an hour of hypotheses instead of a glance.
    */
    expect(res.status, `GET /api/auth/me said ${res.status}: ${res.text}`).toBe(200);
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
    const originalName = `API Roundtrip-${Date.now()}`;
    const create = await request(app)
      .post('/api/records/leads')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ full_name: originalName, mobile: '9812345678' })
      .expect(201);

    const id = create.body.id as string;
    expect(id).toBeTruthy();

    await request(app)
      .patch(`/api/records/leads/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ full_name: 'Renamed Lead' })
      .expect(200);

    const read = await request(app)
      .get(`/api/records/leads/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(read.body.values.full_name).toBe('Renamed Lead');

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
      .send({ full_name: 'No Mobile' })
      .expect(422);

    expect(res.body.error).toBe('validation_error');
    // The one-name form requires both a name and a national mobile number.
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

describe('metadata field administration', () => {
  it('adds and removes a custom field, and safely hides and restores a built-in field', async () => {
    const fieldModules = await request(app)
      .get('/api/meta/modules/field-builder')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(fieldModules.body.some((m: { name: string }) => m.name === 'leads')).toBe(true);

    await request(app)
      .get('/api/meta/modules/field-builder')
      .set('Authorization', `Bearer ${executiveToken}`)
      .expect(403);

    const before = await request(app)
      .get('/api/meta/modules/leads?includeInactive=true')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const blockId = before.body.blocks[0]?.id as string | undefined;
    expect(blockId).toBeTruthy();

    const name = `qa_removable_${Date.now().toString(36)}`;
    let customId: string | undefined;
    const builtIn = before.body.fields.find((f: {
      name: string; isCustom: boolean; isActive: boolean; isMandatory: boolean;
    }) => !f.isCustom && f.isActive && !f.isMandatory
      && !['lead_number', 'full_name', 'mobile'].includes(f.name)) as
      | { id: string; name: string; displayType: string }
      | undefined;
    expect(builtIn).toBeTruthy();

    try {
      const created = await request(app)
        .post('/api/meta/modules/leads/fields')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name, label: 'QA removable field', uitype: 'string', blockId, config: {} })
        .expect(201);
      customId = created.body.id as string;
      expect(customId).toBeTruthy();

      const withCustom = await request(app)
        .get('/api/meta/modules/leads?includeInactive=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(withCustom.body.fields.some((f: { name: string }) => f.name === name)).toBe(true);

      // An ordinary delete is a soft delete now, for a custom field as much as
      // a built-in one: it goes to the recycle bin with its values intact and
      // comes back whole. Removing it for good is a separate, explicit act.
      const removed = await request(app)
        .delete(`/api/meta/fields/${customId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(removed.body.deactivated).toBe(true);

      const binned = await request(app)
        .get('/api/meta/modules/leads?includeInactive=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(binned.body.fields.find((f: { name: string }) => f.name === name))
        .toMatchObject({ isActive: false, displayType: 'hidden' });

      await request(app)
        .patch(`/api/meta/fields/${customId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: true })
        .expect(200);
      const restoredCustom = await request(app)
        .get('/api/meta/modules/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(restoredCustom.body.fields.some((f: { name: string }) => f.name === name)).toBe(true);

      await request(app)
        .delete(`/api/meta/fields/${customId}?permanent=true`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const gone = await request(app)
        .get('/api/meta/modules/leads?includeInactive=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(gone.body.fields.some((f: { name: string }) => f.name === name)).toBe(false);
      customId = undefined;

      const hidden = await request(app)
        .delete(`/api/meta/fields/${builtIn!.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(hidden.body.deactivated).toBe(true);

      const hiddenDescribe = await request(app)
        .get('/api/meta/modules/leads?includeInactive=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(hiddenDescribe.body.fields.find((f: { name: string }) => f.name === builtIn!.name))
        .toMatchObject({ isActive: false, displayType: 'hidden' });

      await request(app)
        .patch(`/api/meta/fields/${builtIn!.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: true })
        .expect(200);

      const restored = await request(app)
        .get('/api/meta/modules/leads')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(restored.body.fields.some((f: { name: string }) => f.name === builtIn!.name)).toBe(true);
    } finally {
      if (customId) {
        await request(app)
          .delete(`/api/meta/fields/${customId}?permanent=true`)
          .set('Authorization', `Bearer ${adminToken}`);
      }
      if (builtIn) {
        await request(app)
          .patch(`/api/meta/fields/${builtIn.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ isActive: true, displayType: builtIn.displayType });
      }
    }
  });

  it('keeps field management available while a module is disabled', async () => {
    const suffix = Date.now().toString(36);
    const moduleName = `qa_fields_${suffix}`;
    let moduleCreated = false;
    let fieldId: string | undefined;

    try {
      await request(app)
        .post('/api/meta/modules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: moduleName,
          label: 'QA Disabled Modules',
          singularLabel: 'QA Disabled Module',
          icon: 'box',
          color: '#6366f1',
          menuGroup: 'Custom',
          showInMenu: false,
        })
        .expect(201);
      moduleCreated = true;

      await request(app)
        .post(`/api/meta/modules/${moduleName}/toggle`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false, reason: 'Integration verification' })
        .expect(200);

      const modules = await request(app)
        .get('/api/meta/modules/field-builder')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(modules.body.find((m: { name: string }) => m.name === moduleName))
        .toMatchObject({ isActive: false });

      const described = await request(app)
        .get(`/api/meta/modules/${moduleName}?includeInactive=true`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const blockId = described.body.blocks[0]?.id as string | undefined;
      expect(blockId).toBeTruthy();

      const createdField = await request(app)
        .post(`/api/meta/modules/${moduleName}/fields`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'qa_disabled_field',
          label: 'QA Disabled Field',
          uitype: 'string',
          blockId,
          config: {},
        })
        .expect(201);
      fieldId = createdField.body.id as string;
      expect(fieldId).toBeTruthy();

      await request(app)
        .delete(`/api/meta/fields/${fieldId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      fieldId = undefined;
    } finally {
      if (fieldId) {
        await request(app)
          .delete(`/api/meta/fields/${fieldId}`)
          .set('Authorization', `Bearer ${adminToken}`);
      }
      if (moduleCreated) {
        await request(app)
          .post(`/api/meta/modules/${moduleName}/toggle`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ isActive: true });
        await request(app)
          .delete(`/api/meta/modules/${moduleName}?force=true`)
          .set('Authorization', `Bearer ${adminToken}`);
      }
    }
  });
});

describe('public API', () => {
  // /api/public/projects still exists for the customer-facing website, but a
  // "project" is now an aggregate over the units that share a project_name
  // rather than a record of its own — see api/routes/public.ts.
  it('serves projects with no authentication', async () => {
    const res = await request(app).get('/api/public/projects').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('exposes only whitelisted fields, never internal ones', async () => {
    const res = await request(app).get('/api/public/projects');
    expect(res.status, res.text).toBe(200);
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
      `SELECT count(DISTINCT btrim(p.project_name)) AS count FROM ipy_e_properties p
         JOIN ipy_record r ON r.id = p.record_id
        WHERE r.is_deleted = false AND p.project_name IS NOT NULL
          AND COALESCE((p.custom_fields->>'publish_to_web')::boolean, true) = false`,
    );
    const unpublished = Number(rows[0].count);

    const res = await request(app).get('/api/public/projects?pageSize=200').expect(200);
    const total = res.body.total as number;

    const { rows: allRows } = await db.query<{ count: string }>(
      `SELECT count(DISTINCT btrim(p.project_name)) AS count FROM ipy_e_properties p
         JOIN ipy_record r ON r.id = p.record_id
        WHERE r.is_deleted = false AND p.project_name IS NOT NULL`,
    );
    // The public list is at most "everything minus the explicitly unpublished"
    // — status filtering narrows it further, which is why this is an
    // inequality rather than an exact match.
    expect(total).toBeLessThanOrEqual(Number(allRows[0].count) - unpublished);
  });
});

describe('outreach automation API', () => {
  it('prepares and completes a one-tap WhatsApp queue item', async () => {
    const prepared = await request(app)
      .post('/api/outreach/device-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ handle: '+91 99999 91234', body: 'Hi there, shall I share the floor plan?', render: false });
    expect(prepared.status, prepared.text).toBe(200);
    expect(prepared.body.link).toBe(
      'https://wa.me/919999991234?text=Hi%20there%2C%20shall%20I%20share%20the%20floor%20plan%3F',
    );

    const queued = await request(app)
      .post('/api/outreach/device-queue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ handle: '+91 99999 91234', body: 'Queue integration message', reason: 'Integration test' })
      .expect(201);
    const id = queued.body.id as string;
    expect(id).toBeTruthy();

    const pending = await request(app)
      .get('/api/outreach/device-queue')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(pending.body.some((item: { id: string; link: string }) => (
      item.id === id && item.link.startsWith('https://wa.me/919999991234?text=')
    ))).toBe(true);

    await request(app)
      .post(`/api/outreach/device-queue/${id}/opened`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const sent = await request(app)
      .post(`/api/outreach/device-queue/${id}/sent`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(sent.body).toHaveProperty('messageId');

    const after = await request(app)
      .get('/api/outreach/device-queue')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(after.body.some((item: { id: string }) => item.id === id)).toBe(false);
  });

});

describe('Android companion API', () => {
  it('pairs, authenticates, deduplicates call logs and revokes a phone', async () => {
    const paired = await request(app)
      .post('/api/telephony/devices')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Integration phone', phoneNumber: '+919800000001', model: 'Test handset' })
      .expect(201);

    const deviceId = paired.body.deviceId as string;
    const deviceToken = paired.body.token as string;
    expect(deviceId).toBeTruthy();
    expect(deviceToken).toBeTruthy();

    const ping = await request(app)
      .get('/api/device/ping')
      .set('Authorization', `Bearer ${deviceToken}`)
      .expect(200);
    expect(ping.body.deviceId).toBe(deviceId);

    const externalId = `integration-${Date.now()}`;
    const payload = {
      appVersion: '1.0-test',
      entries: [{
        externalId,
        number: '+919812345678',
        type: 2,
        timestamp: Date.now() - 60_000,
        durationSeconds: 42,
        contactName: 'Integration lead',
      }],
    };

    const first = await request(app)
      .post('/api/device/calls')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send(payload)
      .expect(200);
    expect(first.body).toMatchObject({ received: 1, created: 1, duplicates: 0, skipped: 0 });

    const retry = await request(app)
      .post('/api/device/calls')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send(payload);
    expect(retry.status, retry.text).toBe(200);
    expect(retry.body).toMatchObject({ received: 1, created: 0, duplicates: 1, skipped: 0 });

    const calls = await request(app)
      .get('/api/telephony/calls?limit=200')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(calls.body.some((call: { device_id: string; source: string }) => (
      call.device_id === deviceId && call.source === 'device'
    ))).toBe(true);

    await request(app)
      .delete(`/api/telephony/devices/${deviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app)
      .get('/api/device/ping')
      .set('Authorization', `Bearer ${deviceToken}`)
      .expect(401);
  });

  /**
   * The INSERT read the duration parameter twice — once into an integer column and
   * once concatenated into an interval string — so Postgres refused to deduce a type
   * and every manual log returned a 500. Nothing typechecks a SQL literal, so the
   * guard has to be a real round trip.
   */
  it('logs a call an agent made from their own handset', async () => {
    const logged = await request(app)
      .post('/api/telephony/log')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ to: '+919812345000', direction: 'outbound', durationSeconds: 60, disposition: 'Call Back Later' });

    expect(logged.status, logged.text).toBe(201);
    expect(logged.body.callId).toBeTruthy();

    const calls = await request(app)
      .get('/api/telephony/calls?limit=200')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const call = calls.body.find((c: { id: string }) => c.id === logged.body.callId);
    expect(call).toMatchObject({ source: 'manual', duration_seconds: 60 });

    await request(app)
      .patch(`/api/telephony/calls/${logged.body.callId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ disposition: 'Interested', notes: 'Site visit requested for Saturday' })
      .expect(200);

    const history = await request(app)
      .get(`/api/telephony/calls/${logged.body.callId}/history`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0]).toMatchObject({
      previous_disposition: 'Call Back Later',
      previous_notes: null,
      new_disposition: 'Interested',
      new_notes: 'Site visit requested for Saturday',
    });
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
