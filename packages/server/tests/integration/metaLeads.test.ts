/**
 * The Facebook lead-ads webhook.
 *
 * The webhook has to be public — Meta cannot hold a secret of ours — so its
 * signature is the only thing separating a real lead from an invented one. Until
 * now nothing checked it: anyone who learned the URL could post a leadgen id and
 * have the CRM fetch, create, assign and score a lead that never existed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { invalidate as reloadIntegrationSettings } from '../../src/core/settings/integrations.js';

let app: Express;
const APP_SECRET = 'test-facebook-app-secret';

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

const leadgenBody = (id: string): string => JSON.stringify({
  entry: [{ changes: [{ value: { leadgen_id: id, form_id: 'f1', page_id: 'p1' } }] }],
});

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  // A real app secret, so the signature check has something to check against.
  await db.query(
    `INSERT INTO ipy_integration (provider, kind, label, credentials, is_active)
     VALUES ('facebook_leads', 'lead_source', 'Facebook Lead Ads', $1::jsonb, true)
     ON CONFLICT (provider, label) DO UPDATE SET credentials = EXCLUDED.credentials, is_active = true`,
    [JSON.stringify({ appSecret: APP_SECRET })],
  );
  await reloadIntegrationSettings();
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_lead_inbox WHERE source = 'facebook'`);
});

describe('the facebook lead webhook', () => {
  it('refuses a request that is not signed at all', async () => {
    await request(app)
      .post('/api/webhooks/leads/facebook')
      .set('Content-Type', 'application/json')
      .send(leadgenBody('unsigned-1'))
      .expect(401);
  });

  it('refuses a request signed with the wrong secret', async () => {
    const body = leadgenBody('forged-1');
    const wrong = `sha256=${crypto.createHmac('sha256', 'not-the-secret').update(body).digest('hex')}`;
    await request(app)
      .post('/api/webhooks/leads/facebook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', wrong)
      .send(body)
      .expect(401);
  });

  it('refuses a signature computed over a different body', async () => {
    // The attack the raw-body check exists for: a valid signature lifted from
    // one delivery and replayed against a payload of the attacker's choosing.
    await request(app)
      .post('/api/webhooks/leads/facebook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(leadgenBody('genuine')))
      .send(leadgenBody('swapped'))
      .expect(401);
  });

  it('accepts a correctly signed delivery', async () => {
    const body = leadgenBody('signed-ok-1');
    await request(app)
      .post('/api/webhooks/leads/facebook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body)
      .expect(200);
    // The Graph fetch that follows has no token here and is expected to fail;
    // 200 means Meta is satisfied and will not retry, which is the contract.
  });

  it('never creates a lead from an unsigned request', async () => {
    await request(app)
      .post('/api/webhooks/leads/facebook')
      .set('Content-Type', 'application/json')
      .send(leadgenBody('should-not-exist'))
      .expect(401);

    const row = await db.queryOne(
      `SELECT 1 FROM ipy_lead_inbox WHERE source = 'facebook' AND external_id = 'should-not-exist'`,
    );
    expect(row, 'a rejected webhook must leave no trace of a lead').toBeNull();
  });
});
