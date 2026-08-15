/**
 * The control plane against real databases.
 *
 * Everything here had only pure-function tests until now: `decide()` knew what a
 * failed payment means, but nothing checked that provisioning actually produces
 * a working CRM, that a connection string survives the round trip through
 * encryption, or that a webhook arriving twice only pays once. Those are the
 * parts that will run against real customers and real money, and they touch a
 * database, so they need one.
 *
 * Three databases are in play: the app's scratch database (`DATABASE_URL`), the
 * customer list (`CONTROL_DATABASE_URL`), and one more that a customer gets
 * provisioned into. globalSetup creates them.
 */
import crypto from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachRazorpaySubscription, getSubscription, handleRazorpayEvent,
  markInvoiced, startTrial, suspendLapsed,
} from '../../src/control/billing.js';
import { migrateTenant, provisionTenant } from '../../src/control/provision.js';
import * as store from '../../src/control/store.js';
import { approveSignup, listSignups, rejectSignup, submitSignup } from '../../src/control/signups.js';
import { testTenantDatabaseUrl } from './testDatabase.js';

const TENANT_URL = testTenantDatabaseUrl();

/** Read something out of a provisioned customer's own database. */
async function inTenantDatabase<T>(sql: string): Promise<T> {
  const client = new Client({ connectionString: TENANT_URL });
  await client.connect();
  try {
    const res = await client.query(sql);
    return res.rows[0] as T;
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  await store.closeControlPool();
});

describe('the customer list', () => {
  it('creates the control database, with its schema, on first connect', async () => {
    // globalSetup deliberately does not create it: a developer running
    // `npm run control` for the first time has not created it either, and that
    // path should not be exercised for the first time on their machine.
    //
    // Asserts the schema is queryable rather than that it is empty — another
    // file in this suite seeds its own fixture, and which runs first is not a
    // property worth depending on.
    const pool = await store.openControlPool();
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'ctl_%' ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'ctl_signup_request', 'ctl_subscription', 'ctl_tenant', 'ctl_tenant_event', 'ctl_webhook_event',
    ]);
  });

  it('keeps a connection string encrypted at rest and readable in code', async () => {
    const tenant = await store.createTenant({
      slug: 'crypto_check', name: 'Crypto Check', templateKey: 'real-estate',
      adminEmail: 'ops@example.com',
    });
    const secret = 'postgres://someone:very-secret@db.example.com:5432/theirs';
    await store.setDatabaseUrl(tenant.id, secret);

    const pool = await store.openControlPool();
    const raw = await pool.query<{ database_url: string }>(
      `SELECT database_url FROM ctl_tenant WHERE id = $1`, [tenant.id],
    );
    // The stored bytes must not contain the password anywhere.
    expect(raw.rows[0].database_url).toMatch(/^enc:v1:/);
    expect(raw.rows[0].database_url).not.toContain('very-secret');

    const readBack = await store.requireBySlug('crypto_check');
    expect(readBack.databaseUrl).toBe(secret);
  });

  it('never returns a connection string from the list', async () => {
    const listed = await store.listTenants();
    for (const tenant of listed) {
      expect(tenant).not.toHaveProperty('databaseUrl');
    }
  });

  it('refuses a second customer with the same slug', async () => {
    await expect(store.createTenant({
      slug: 'crypto_check', name: 'Impostor', templateKey: 'real-estate',
      adminEmail: 'other@example.com',
    })).rejects.toThrow();
  });
});

describe('provisioning a customer', () => {
  let adminPassword = '';

  beforeAll(async () => {
    const result = await provisionTenant({
      slug: 'acme_realty',
      name: 'Acme Realty',
      adminEmail: 'ops@acmerealty.example',
      databaseUrl: TENANT_URL,
    });
    adminPassword = result.adminPassword;
  }, 120_000);

  it('leaves the customer active with a full history', async () => {
    const tenant = await store.requireBySlug('acme_realty');
    expect(tenant.status).toBe('active');

    const kinds = (await store.listEvents(tenant.id)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['created', 'database_ready', 'migrated', 'seeded', 'activated']));
  });

  it('migrates and seeds their database', async () => {
    const counts = await inTenantDatabase<{ modules: string; fields: string; migrations: string }>(
      `SELECT (SELECT count(*) FROM ipy_module) AS modules,
              (SELECT count(*) FROM ipy_field) AS fields,
              (SELECT count(*) FROM ipy_migration) AS migrations`,
    );
    expect(Number(counts.modules)).toBe(2);
    expect(Number(counts.fields)).toBeGreaterThan(100);
    expect(Number(counts.migrations)).toBeGreaterThan(30);
  });

  it('creates their admin and nobody else', async () => {
    // The demo users share a password published in this repository, so a
    // customer's database getting them would be a live vulnerability.
    const users = await inTenantDatabase<{ total: string | number; admin: string | number }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE email = 'ops@acmerealty.example') AS admin
         FROM ipy_user WHERE email <> 'system@ipropy'`,
    );
    expect(Number(users.admin)).toBe(1);
    expect(Number(users.total)).toBe(1);
  });

  it('generates a password strong enough to be worth generating', () => {
    expect(adminPassword).toHaveLength(24);
  });

  it('starts them with no records at all', async () => {
    const records = await inTenantDatabase<{ count: string | number }>(`SELECT count(*) FROM ipy_record`);
    expect(Number(records.count)).toBe(0);
  });

  it('is idempotent to re-migrate', async () => {
    const tenant = await store.requireBySlug('acme_realty');
    expect(await migrateTenant(tenant)).toMatchObject({ slug: 'acme_realty', ok: true });
  });

  it('records a failure instead of leaving a database nobody knows about', async () => {
    // The row is written before the work starts precisely so this leaves a trail.
    await expect(provisionTenant({
      slug: 'doomed_co',
      name: 'Doomed Co',
      adminEmail: 'ops@doomed.example',
      databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/nowhere',
    })).rejects.toThrow();

    const tenant = await store.requireBySlug('doomed_co');
    expect(tenant.status).toBe('failed');
    expect((await store.listEvents(tenant.id)).map((e) => e.kind)).toContain('failed');
  }, 120_000);

  it('refuses an unknown trade before creating anything', async () => {
    await expect(provisionTenant({
      slug: 'gym_chain', name: 'Gym Chain', adminEmail: 'ops@gym.example',
      templateKey: 'gyms', databaseUrl: TENANT_URL,
    })).rejects.toThrow(/Unknown seed template/);
    expect(await store.findBySlug('gym_chain')).toBeNull();
  });
});

describe('billing against the customer list', () => {
  const subscriptionId = 'sub_INTEGRATION';

  beforeAll(async () => {
    const tenant = await store.requireBySlug('acme_realty');
    await startTrial(tenant.id, 'starter', 30);
    await attachRazorpaySubscription(tenant.id, 'starter', subscriptionId);
  });

  const send = (event: string, id = crypto.randomUUID()): Promise<{ handled: boolean; duplicate: boolean }> =>
    handleRazorpayEvent(
      { event, payload: { subscription: { entity: { id: subscriptionId } } } },
      id,
    );

  it('extends service and records the payment when money arrives', async () => {
    const tenant = await store.requireBySlug('acme_realty');
    expect(await send('subscription.charged')).toMatchObject({ handled: true });

    const subscription = await getSubscription(tenant.id);
    expect(subscription).toMatchObject({ status: 'active', planKey: 'starter' });
    expect(subscription?.lastPaymentAt).not.toBeNull();
    expect(new Date(subscription!.servesUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it('pays once when the same delivery arrives twice', async () => {
    // Razorpay retries until it gets a 2xx, so this is ordinary traffic.
    const tenant = await store.requireBySlug('acme_realty');
    const eventId = crypto.randomUUID();

    expect(await send('subscription.charged', eventId)).toMatchObject({ handled: true, duplicate: false });
    const after = await getSubscription(tenant.id);

    expect(await send('subscription.charged', eventId)).toMatchObject({ duplicate: true });
    const afterRetry = await getSubscription(tenant.id);

    // Strings, not Dates — the mappers convert at the edge so a comparison like
    // this means what it looks like it means.
    expect(typeof afterRetry?.servesUntil).toBe('string');
    expect(afterRetry?.servesUntil).toBe(after?.servesUntil);
  });

  it('keeps a customer working when a charge fails', async () => {
    const tenant = await store.requireBySlug('acme_realty');
    await send('payment.failed');

    expect((await store.requireBySlug('acme_realty')).status).toBe('active');
    const subscription = await getSubscription(tenant.id);
    expect(subscription?.status).toBe('past_due');
    // Seven days of grace, not zero and not a month.
    const days = (new Date(subscription!.servesUntil!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
  });

  it('suspends only once the gateway gives up', async () => {
    await send('subscription.halted');
    expect((await store.requireBySlug('acme_realty')).status).toBe('suspended');
  });

  it('ignores an event for a subscription it has never heard of', async () => {
    const result = await handleRazorpayEvent(
      { event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_STRANGER' } } } },
      crypto.randomUUID(),
    );
    expect(result).toMatchObject({ handled: false, note: 'unknown subscription' });
  });

  it('suspends whoever has run out of paid time, and spares invoiced customers', async () => {
    const tenant = await store.requireBySlug('acme_realty');
    await store.setStatus(tenant.id, 'active');

    const pool = await store.openControlPool();
    await pool.query(`UPDATE ctl_subscription SET serves_until = now() - interval '1 day' WHERE tenant_id = $1`, [tenant.id]);

    expect(await suspendLapsed()).toContain('acme_realty');
    expect((await store.requireBySlug('acme_realty')).status).toBe('suspended');

    // Someone paying by cheque has no gateway clock and must not be swept up.
    await store.setStatus(tenant.id, 'active');
    await markInvoiced(tenant.id, 'starter', new Date(Date.now() - 86_400_000));
    expect(await suspendLapsed()).not.toContain('acme_realty');
  });
});

describe('the sign-up queue', () => {
  it('queues a request without provisioning anything', async () => {
    const request = await submitSignup({
      slug: 'bright_homes', name: 'Bright Homes', adminEmail: 'ops@bright.example',
      planKey: 'starter',
    });
    expect(request.status).toBe('pending');
    // The queue is the whole point: nothing exists for them yet.
    expect(await store.findBySlug('bright_homes')).toBeNull();
    expect((await listSignups('pending')).map((r) => r.slug)).toContain('bright_homes');
  });

  it.each([
    ['drop;--', /not a usable slug/],
    ['ab', /not a usable slug/],
  ])('refuses %s', async (slug, matcher) => {
    await expect(submitSignup({ slug, name: 'X', adminEmail: 'x@y.example' })).rejects.toThrow(matcher);
  });

  it('refuses a bad email and an unknown plan', async () => {
    await expect(submitSignup({ slug: 'good_slug', name: 'X', adminEmail: 'not-an-email' }))
      .rejects.toThrow(/email/i);
    await expect(submitSignup({ slug: 'good_slug', name: 'X', adminEmail: 'x@y.example', planKey: 'platinum' }))
      .rejects.toThrow(/Unknown plan/);
  });

  it('refuses a name already taken by a customer', async () => {
    await expect(submitSignup({ slug: 'acme_realty', name: 'Copycat', adminEmail: 'x@y.example' }))
      .rejects.toThrow(/taken/);
  });

  it('rejects a request, and will not reject it twice', async () => {
    const [pending] = await listSignups('pending');
    await rejectSignup(pending.id, 'a duplicate');
    await expect(rejectSignup(pending.id)).rejects.toThrow(/No pending request/);
    expect((await listSignups('rejected')).map((r) => r.id)).toContain(pending.id);
  });

  it('will not approve a decided request', async () => {
    const [rejected] = await listSignups('rejected');
    await expect(approveSignup(rejected.id)).rejects.toThrow(/already rejected/);
  });
});

describe('suspension actually stops the customer being served', () => {
  it('pauses their API, and leaves the health check answering', async () => {
    // The gap this closes: before, "suspended" was a word in the customer list
    // and their CRM — a different process against a different database — carried
    // on serving as if nothing had happened.
    const { createApp } = await import('../../src/app.js');
    const { setServiceStatus, forgetServiceStatus } = await import('../../src/core/serviceStatus.js');
    const request = (await import('supertest')).default;

    const app = createApp();
    await setServiceStatus(false);
    await request(app).get('/api/health').expect(200);
    // Unauthenticated, so 401 — the point is that it is not 402.
    await request(app).get('/api/records/leads').expect(401);

    await setServiceStatus(true, 'This account is paused.');
    forgetServiceStatus();

    const paused = await request(app).get('/api/records/leads').expect(402);
    expect(paused.body).toMatchObject({ error: 'service_paused', message: 'This account is paused.' });
    // A monitor cannot hold a token and still needs to know the box is alive.
    await request(app).get('/api/health').expect(200);
    // Everything is paused, including the public listings feed a suspended
    // customer's website would otherwise keep collecting leads through.
    await request(app).get('/api/public/properties').expect(402);

    await setServiceStatus(false);
    forgetServiceStatus();
    await request(app).get('/api/records/leads').expect(401);
  });

  it('writes the flag into the customer own database when the control plane suspends them', async () => {
    const { writeServiceFlag } = await import('../../src/control/service.js');

    expect(await writeServiceFlag(TENANT_URL, true)).toBe(true);
    const paused = await inTenantDatabase<{ value: { status: string } }>(
      `SELECT value FROM ipy_setting WHERE key = 'service.status'`,
    );
    expect(paused.value.status).toBe('suspended');

    expect(await writeServiceFlag(TENANT_URL, false)).toBe(true);
    const resumed = await inTenantDatabase<{ value: { status: string } }>(
      `SELECT value FROM ipy_setting WHERE key = 'service.status'`,
    );
    expect(resumed.value.status).toBe('active');
  });

  it('records the decision even when their database cannot be reached', async () => {
    // A Neon blip during a billing sweep must not leave a customer marked active
    // and unpaid; the customer list is the record, their database catches up.
    const { writeServiceFlag } = await import('../../src/control/service.js');
    expect(await writeServiceFlag('postgres://nobody:nothing@127.0.0.1:1/nowhere', true)).toBe(false);
  }, 30_000);
});
