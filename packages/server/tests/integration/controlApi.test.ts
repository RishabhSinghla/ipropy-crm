/**
 * The operator console's API, over HTTP.
 *
 * The console is the only screen that can suspend a paying customer, so who is
 * allowed to call it matters more than what it renders. These tests drive the
 * real Express app rather than the functions behind it, because the thing worth
 * checking is the middleware order: a route that does its work before the auth
 * check would still pass a test that called the handler directly.
 */
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { startTrial } from '../../src/control/billing.js';
import { createControlApp } from '../../src/control/server.js';
import * as store from '../../src/control/store.js';

const SLUG = 'console_co';

/**
 * The token is read when the router is built; `isProd` is read on every request.
 * Both stay set until afterEach puts them back, or the production test would
 * make its request against a development config and pass for the wrong reason.
 */
function appWith(token: string, isProd = false): ReturnType<typeof createControlApp> {
  config.control.operatorToken = token;
  (config as { isProd: boolean }).isProd = isProd;
  return createControlApp();
}

/**
 * This file owns its fixture rather than borrowing the one control.test.ts
 * provisions. Sharing it worked only in the order the files happened to run,
 * which is not a property worth relying on.
 */
beforeAll(async () => {
  if (!await store.findBySlug(SLUG)) {
    const tenant = await store.createTenant({
      slug: SLUG, name: 'Console Co', templateKey: 'real-estate',
      adminEmail: 'ops@console.example',
    });
    await store.setDatabaseUrl(tenant.id, 'postgres://someone:secret@db.example.com:5432/console_co');
    await store.setStatus(tenant.id, 'active');
    // Provisioning writes this; the fixture skips provisioning, so it writes it
    // by hand rather than the console appearing to have lost a customer's history.
    await store.recordEvent(tenant.id, 'created', 'fixture');
    await startTrial(tenant.id, 'starter', 30);
  }
});

afterEach(() => {
  config.control.operatorToken = '';
  (config as { isProd: boolean }).isProd = false;
});

afterAll(async () => {
  await store.closeControlPool();
});

describe('who may use the console', () => {
  it('turns away a caller with no token when one is configured', async () => {
    const app = appWith('s3cret');
    await request(app).get('/api/overview').expect(401);
    await request(app).get('/api/tenants').expect(401);
    // The dangerous one: suspending a customer must never be reachable unauthenticated.
    await request(app).post(`/api/tenants/${SLUG}/suspend`).expect(401);
  });

  it('turns away a wrong token', async () => {
    await request(appWith('s3cret')).get('/api/overview')
      .set('Authorization', 'Bearer guess').expect(401);
  });

  it('lets the right token through', async () => {
    await request(appWith('s3cret')).get('/api/overview')
      .set('Authorization', 'Bearer s3cret').expect(200);
  });

  it('is open with no token configured, outside production', async () => {
    const res = await request(appWith('')).get('/api/overview').expect(200);
    // Says so on the way out, so nobody mistakes a local convenience for a policy.
    expect(res.headers['x-operator-auth']).toBe('open-in-development');
  });

  it('refuses to serve at all in production with no token', async () => {
    // Falling back to open in production would publish every customer's name.
    await request(appWith('', true)).get('/api/overview').expect(503);
  });

  it('leaves /health open, since a monitor cannot hold a token', async () => {
    await request(appWith('s3cret')).get('/health').expect(200);
  });
});

describe('what the console shows', () => {
  const app = (): ReturnType<typeof createControlApp> => appWith('');

  it('counts customers by status', async () => {
    const res = await request(app()).get('/api/overview').expect(200);
    expect(res.body.counts).toMatchObject({ total: expect.any(Number), active: expect.any(Number) });
    expect(res.body).toMatchObject({ billingConfigured: false, signupsOpen: false, openAccess: true });
  });

  it('never sends a connection string to the browser', async () => {
    const list = await request(app()).get('/api/tenants').expect(200);
    expect(list.body.length).toBeGreaterThan(0);
    for (const tenant of list.body) {
      expect(tenant).not.toHaveProperty('databaseUrl');
    }

    const one = await request(app()).get(`/api/tenants/${SLUG}`).expect(200);
    expect(one.body).not.toHaveProperty('databaseUrl');
    expect(JSON.stringify(one.body)).not.toMatch(/postgres:\/\//);
  });

  it('gives a customer their history and their subscription', async () => {
    const res = await request(app()).get(`/api/tenants/${SLUG}`).expect(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.subscription).toMatchObject({ planKey: expect.any(String) });
  });

  it('answers a name that does not exist with a readable message', async () => {
    const res = await request(app()).get('/api/tenants/nobody_here').expect(400);
    expect(res.body.error).toMatch(/No customer with the slug/);
  });

  it('suspends and resumes, and writes it to the history', async () => {
    await request(app()).post(`/api/tenants/${SLUG}/suspend`).expect(200);
    expect((await store.requireBySlug(SLUG)).status).toBe('suspended');

    await request(app()).post(`/api/tenants/${SLUG}/resume`).expect(200);
    expect((await store.requireBySlug(SLUG)).status).toBe('active');

    const tenant = await store.requireBySlug(SLUG);
    const details = (await store.listEvents(tenant.id)).map((e) => e.detail);
    expect(details).toContain('from the operator console');
  });

  it('lists the plans a customer can be put on', async () => {
    const res = await request(app()).get('/api/plans').expect(200);
    expect(res.body.map((p: { key: string }) => p.key)).toEqual(['trial', 'starter', 'growth']);
    expect(res.body.find((p: { key: string }) => p.key === 'starter').price).toBe('₹2,499');
  });

  it('has no route that creates a customer', async () => {
    // Provisioning runs migrations and creates databases. Deliberately not a button.
    await request(app()).post('/api/tenants').send({ slug: 'sneaky_co' }).expect(404);
  });
});
