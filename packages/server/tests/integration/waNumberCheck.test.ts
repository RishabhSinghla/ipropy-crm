/** The name checker against a real database and a pretend OpenWA: what it writes, what it must never overwrite, who may start it. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { __resetOpenWaCaches, OPENWA_PROVIDER } from '../../src/integrations/whatsapp/business/openwa.js';
import { checkOne } from '../../src/integrations/whatsapp/business/numberCheck.js';
import { SEEDED, adminContext, adminToken, leadInput, signIn } from './fixtures.js';
import { startFakeOpenWa, type FakeOpenWa } from '../fakes/fakeOpenWa.js';

const stamp = String(Date.now()).slice(-7);
const ON = `98${stamp}1`.slice(0, 10);
const NOT_ON = `97${stamp}2`.slice(0, 10);
const HAS_NAME = `96${stamp}3`.slice(0, 10);
const full = (m: string): string => `91${m}`;

let app: ReturnType<typeof createApp>;
let fake: FakeOpenWa;
let admin = '';
let rep = '';
const ids: Record<string, string> = {};
const previouslyActive: string[] = [];

const valueOf = async (id: string): Promise<string | null> =>
  (await db.queryOne<{ v: string | null }>(`SELECT whatsapp_name AS v FROM ipy_e_leads WHERE record_id = $1`, [id]))?.v ?? null;

beforeAll(async () => {
  app = createApp();
  admin = await adminToken(app);
  rep = await signIn(app, SEEDED.executiveA);
  fake = await startFakeOpenWa({ sessionName: 'company' });
  fake.onWhatsApp.set(full(ON), { pushName: 'Ravi Kumar', photoUrl: 'http://127.0.0.1:1/not-whatsapp.jpg' });
  fake.onWhatsApp.set(full(HAS_NAME), { pushName: 'Whatever WhatsApp Says' });

  const active = await db.query(`SELECT provider FROM ipy_integration WHERE provider LIKE 'whatsapp\\_%' AND is_active`);
  previouslyActive.push(...active.rows.map((r) => String((r as { provider: string }).provider)));
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider LIKE 'whatsapp\\_%'`);
  await saveIntegration(OPENWA_PROVIDER, {
    config: { baseUrl: fake.baseUrl, sessionName: 'company' },
    credentials: { apiKey: fake.apiKey, webhookSecret: 'integration-webhook-secret-123456' },
    isActive: true,
  });
  await reloadIntegrations();
  __resetOpenWaCaches();

  const ctx = await adminContext();
  for (const [key, mobile, extra] of [['on', ON, {}], ['not', NOT_ON, {}], ['named', HAS_NAME, { whatsapp_name: 'Typed By A Rep' }]] as const) {
    const lead = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `Check ${key} ${stamp}`, mobile, country_code: '+91', ...extra }));
    ids[key] = lead.id;
  }
});

afterAll(async () => {
  await fake.close();
  await db.query(`DELETE FROM ipy_wa_lookup WHERE record_id = ANY($1)`, [Object.values(ids)]);
  await db.query(`DELETE FROM ipy_record WHERE id = ANY($1)`, [Object.values(ids)]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = $1`, [OPENWA_PROVIDER]);
  for (const provider of previouslyActive) {
    if (provider !== OPENWA_PROVIDER) await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = $1`, [provider]);
  }
  await reloadIntegrations();
});

describe('checking one contact', () => {
  it('fills the WhatsApp name the person chose, and keeps only a status when they are not on WhatsApp', async () => {
    await checkOne({ id: ids.on!, mobile: ON });
    expect(await valueOf(ids.on!)).toBe('Ravi Kumar');
    expect(await valueOf(ids.on!)).not.toBe('Saved Name In Company Book');
    const row = await db.queryOne<{ status: string; photo: string }>(`SELECT status, photo FROM ipy_wa_lookup WHERE record_id = $1`, [ids.on]);
    // The picture address was not WhatsApp's, so it is never fetched: the name still lands, the photo is skipped.
    expect(row).toMatchObject({ status: 'on_whatsapp', photo: 'skipped' });

    await checkOne({ id: ids.not!, mobile: NOT_ON });
    expect(await valueOf(ids.not!)).toBeNull();
    expect((await db.queryOne<{ status: string; push_name: string | null }>(`SELECT status, push_name FROM ipy_wa_lookup WHERE record_id = $1`, [ids.not]))).toMatchObject({ status: 'not_on_whatsapp', push_name: null });
  });

  it('never overwrites a name somebody typed', async () => {
    await checkOne({ id: ids.named!, mobile: HAS_NAME });
    expect(await valueOf(ids.named!)).toBe('Typed By A Rep');
  });
});

describe('who may start it', () => {
  it('refuses a rep on every route', async () => {
    for (const [method, path] of [['get', '/number-check'], ['post', '/number-check/start'], ['post', '/number-check/stop']] as const) {
      expect((await request(app)[method](`/api/whatsapp-business${path}`).set('Authorization', `Bearer ${rep}`).send({})).status, path).toBe(403);
    }
  });
  it('lets an admin read the numbers', async () => {
    const res = await request(app).get('/api/whatsapp-business/number-check').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ running: false, cap: 150 });
    expect(res.body.found).toBeGreaterThanOrEqual(1);
  });
});
