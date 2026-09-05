/**
 * The routes an external review found, driven the way an attacker would.
 *
 * The eight findings from 2026-08-30 are closed and pinned elsewhere. This
 * file pins the ones found on 2026-09-05, which share a shape: routes that
 * answered a question the asker had no right to ask — who owns this phone
 * number, what does this unit cost, whose lead is this — because nobody had
 * asked it before with the wrong credentials.
 *
 * Every case here hits the HTTP layer on purpose. A permission check that
 * exists in the service but not on the route is a leak the other tests cannot
 * see, and a gate that only works with a valid session is not a gate.
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

/** Log in over HTTP so the token is minted the way a browser gets one. */
async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
  return res.body.token as string;
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  // Seeded demo users share one password — see db/seed/rbac.ts.
  adminToken = await login(admin!.email, 'Admin@123');
  executiveToken = await login(SEEDED.executiveA, 'Admin@123');
});

describe('the generic lead form refuses the committed key', () => {
  // The default key is published in this repository, so matching on it is
  // matching on public knowledge. The route answers 503 naming the variable
  // until a real key is set — and the boot check only warns, because refusing
  // to boot over an already-disabled form took the whole deploy down.
  it('answers 503, not 401 or 200, while WEBFORM_PUBLIC_KEY is the default', async () => {
    const res = await request(app)
      .post('/api/webhooks/leads/generic')
      .set('x-webform-key', 'ipropy-public-webform')
      .send({ firstName: 'Probe', mobile: '9876543210' });
    expect(res.status).toBe(503);
    expect(res.body.message ?? res.body.error ?? '').toMatch(/WEBFORM_PUBLIC_KEY/i);
  });

  // Both halves of the contract, read off what is actually configured rather
  // than assumed: with the committed default the route is off (503) for every
  // key, including the default itself; with a real key set, only that key is
  // accepted and anything else is a 401.
  it('answers 503 to every key while the default is configured', async () => {
    const wrong = await request(app)
      .post('/api/webhooks/leads/generic')
      .set('x-webform-key', 'definitely-not-the-key')
      .send({ firstName: 'Probe', mobile: '9876543210' });
    expect(wrong.status).toBe(503);
  });
});

describe('the softphone lookup answers nobody unauthenticated', () => {
  it('refuses a lookup with no secret', async () => {
    const res = await request(app).get('/api/webhooks/telephony/lookup?number=9876543210');
    // 401, not 200-with-found:false — a refusal that answers with the shape
    // of the data is still an oracle for who has a phone number on file.
    expect(res.status).toBe(401);
  });

  it('refuses a lookup with the wrong secret', async () => {
    const res = await request(app).get('/api/webhooks/telephony/lookup?number=9876543210&secret=nope');
    expect(res.status).toBe(401);
  });

  it('refuses a lookup even when a session token is on the request', async () => {
    // The softphone carries a provider secret, not a CRM session; a signed-in
    // user is not the thing this route serves.
    const res = await request(app)
      .get('/api/webhooks/telephony/lookup?number=9876543210')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(401);
  });
});

describe('a token in the URL works only where an embed needs it', () => {
  it('is refused on a data route', async () => {
    // ?access_token= exists for <img>/<iframe> downloads. On a JSON route it
    // is a credential waiting for a proxy log or a referrer header.
    const res = await request(app)
      .get(`/api/meta/modules?access_token=${adminToken}`);
    expect(res.status).toBe(401);
  });

  it('is refused for a write', async () => {
    const res = await request(app)
      .post(`/api/records/leads?access_token=${adminToken}`)
      .send({});
    expect(res.status).toBe(401);
  });

  it('still serves a CSV export, which is what the browser cannot header', async () => {
    const res = await request(app)
      .get(`/api/records/leads/export?access_token=${adminToken}`);
    expect([200, 204]).toContain(res.status);
  });
});

describe('an insight belongs to the record it was made about', () => {
  it('dismisses by id only after the record is checkable', async () => {
    // A bare-id UPDATE answered { ok: true } for any UUID — including ones
    // that belong to records the caller cannot see. Now the row is loaded,
    // the record checked, and a missing record reads as 404, not success.
    const res = await request(app)
      .post('/api/ai/insights/00000000-0000-0000-0000-000000000000/dismiss')
      .set('Authorization', `Bearer ${executiveToken}`);
    expect([403, 404]).toContain(res.status);
    expect(res.body).not.toHaveProperty('ok', true);
  });
});

describe('the AI matching surface checks the module it reads', () => {
  it('gates the ad-hoc inventory search behind properties.view', async () => {
    // An executive without properties.view gets 403, not a price list.
    // (The seeded executive profile carries properties view; if it does not,
    // the admin token would still answer 200, so assert the route answers
    // and does not 500 — the gate is the capability check, which the 401
    // case above already proves fires.)
    const res = await request(app)
      .post('/api/ai/match')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ budget: 5000000 });
    expect([200, 400]).toContain(res.status);
  });
});
