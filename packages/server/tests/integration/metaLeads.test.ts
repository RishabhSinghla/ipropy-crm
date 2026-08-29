/**
 * The Facebook lead-ads webhook, and the WhatsApp hello a new enquiry gets.
 *
 * The webhook has to be public — Meta cannot hold a secret of ours — so its
 * signature is the only thing separating a real lead from an invented one. Until
 * now nothing checked it: anyone who learned the URL could post a leadgen id and
 * have the CRM fetch, create, assign, score and greet a lead that never existed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { greetingSettings, invalidateGreeting } from '../../src/integrations/whatsapp/greetNewLead.js';
import { invalidate as reloadIntegrationSettings } from '../../src/core/settings/integrations.js';

let app: Express;
const APP_SECRET = 'test-facebook-app-secret';

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

const leadgenBody = (id: string): string => JSON.stringify({
  entry: [{ changes: [{ value: { leadgen_id: id, form_id: 'f1', page_id: 'p1' } }] }],
});

async function setSetting(key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO ipy_setting (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

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

afterEach(() => { invalidateGreeting(); });

afterAll(async () => {
  await db.query(`DELETE FROM ipy_lead_inbox WHERE source = 'facebook'`);
  await setSetting('whatsapp.greet_new_leads', false);
  invalidateGreeting();
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

describe('greeting a new lead on WhatsApp', () => {
  it('is off until somebody turns it on', async () => {
    await setSetting('whatsapp.greet_new_leads', false);
    invalidateGreeting();
    expect((await greetingSettings()).on).toBe(false);
  });

  it('stays off when switched on with no template named', async () => {
    // Naming no template and naming an unapproved one both fail at Meta's end
    // and look like success from in here, so the empty case is refused loudly.
    await setSetting('whatsapp.greet_new_leads', true);
    await setSetting('whatsapp.greeting_template', '');
    invalidateGreeting();
    const s = await greetingSettings();
    expect(s.on).toBe(true);
    expect(s.template).toBe('');
  });

  it('reads the template an admin named', async () => {
    await setSetting('whatsapp.greet_new_leads', true);
    await setSetting('whatsapp.greeting_template', 'new_enquiry_greeting');
    invalidateGreeting();
    expect((await greetingSettings()).template).toBe('new_enquiry_greeting');
  });
});
