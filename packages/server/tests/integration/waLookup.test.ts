/** WhatsApp Lookup against a real database and a pretend OpenWA: the answer, the limits, who sees what, and Save. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { __resetOpenWaCaches, OPENWA_PROVIDER } from '../../src/integrations/whatsapp/business/openwa.js';
import { __resetLookupCache } from '../../src/integrations/whatsapp/business/lookup.js';
import { SEEDED, adminContext, adminToken, leadInput, signIn } from './fixtures.js';
import { startFakeOpenWa, type FakeOpenWa } from '../fakes/fakeOpenWa.js';

const stamp = String(Date.now()).slice(-7);
const ON = `98${stamp}1`.slice(0, 10);
const NOT_ON = `97${stamp}2`.slice(0, 10);
const NO_RECORD = `96${stamp}3`.slice(0, 10);
const full = (m: string): string => `91${m}`;

let app: ReturnType<typeof createApp>;
let fake: FakeOpenWa;
let admin = '';
let rep = '';
let leadId = '';
const previouslyActive: string[] = [];

const look = (token: string, number: string) => request(app).post('/api/whatsapp-business/lookup').set('Authorization', `Bearer ${token}`).send({ number });
/** The pause between two real lookups is the rule under test elsewhere; here it would only slow the suite. */
const letTimePass = (): Promise<unknown> => db.query(`UPDATE ipy_wa_lookup_log SET created_at = created_at - interval '1 minute' WHERE created_at > now() - interval '10 minutes'`);

beforeAll(async () => {
  app = createApp();
  admin = await adminToken(app);
  rep = await signIn(app, SEEDED.executiveA);
  fake = await startFakeOpenWa({ sessionName: 'company' });
  fake.onWhatsApp.set(full(ON), { pushName: 'Ravi Kumar' });
  fake.onWhatsApp.set(full(NO_RECORD), { pushName: 'Stranger Name' });

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
  __resetLookupCache();
  const lead = await recordService.createRecord(await adminContext(), 'leads', leadInput({ full_name: `Lookup ${stamp}`, mobile: ON, country_code: '+91' }));
  leadId = lead.id;
});

afterAll(async () => {
  await fake.close();
  await db.query(`DELETE FROM ipy_wa_lookup_log WHERE number = ANY($1)`, [[full(ON), full(NOT_ON), full(NO_RECORD)]]);
  await db.query(`DELETE FROM ipy_record WHERE id = $1`, [leadId]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = $1`, [OPENWA_PROVIDER]);
  for (const provider of previouslyActive) if (provider !== OPENWA_PROVIDER) await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = $1`, [provider]);
  await reloadIntegrations();
});

describe('looking a number up', () => {
  it('shows the name to anybody signed in, and the CRM contact only to somebody who may open it', async () => {
    const res = await look(rep, `+91 ${ON.slice(0, 5)}-${ON.slice(5)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'on_whatsapp', pushName: 'Ravi Kumar', number: full(ON), fromCache: false });
    // A rep who cannot open this contact is not shown it, nor that it exists; the administrator is.
    expect(res.body.matches).toEqual([]);
    const asAdmin = await look(admin, ON);
    expect(asAdmin.body.matches.map((m: { id: string }) => m.id)).toContain(leadId);
  });

  it('answers the same number again from memory, without asking WhatsApp or using up the allowance', async () => {
    const before = fake.requests.length;
    const again = await look(rep, ON);
    expect(again.body).toMatchObject({ status: 'on_whatsapp', fromCache: true });
    expect(fake.requests.length).toBe(before);
  });

  it('says plainly when the number is not on WhatsApp, and when nothing in the CRM holds it', async () => {
    await letTimePass();
    const res = await look(admin, NOT_ON);
    expect(res.body).toMatchObject({ status: 'not_on_whatsapp', pushName: null });
    expect(res.body.matches).toEqual([]);
    await letTimePass();
    const stranger = await look(admin, NO_RECORD);
    expect(stranger.body).toMatchObject({ status: 'on_whatsapp', pushName: 'Stranger Name', matches: [] });
  });

  it('asks a second lookup straight after the first to wait', async () => {
    await letTimePass();
    __resetLookupCache();
    const first = await look(rep, ON);
    expect(first.body.status).toBe('on_whatsapp');
    const second = await look(rep, NOT_ON);
    expect(second.body.status).toBe('rate_limited');
    expect(second.body.message).toMatch(/one at a time/i);
  });

  it('refuses nonsense, and says so when WhatsApp is not connected', async () => {
    await letTimePass();
    expect((await look(rep, 'abc')).body.status).toBe('invalid');
    fake.status = 'qr_ready'; __resetOpenWaCaches(); __resetLookupCache();
    const down = await look(rep, `95${stamp}9`.slice(0, 10));
    expect(down.body.status).toBe('disconnected');
    expect(down.body.message).toMatch(/not connected/i);
    fake.status = 'ready'; __resetOpenWaCaches();
  });
});

describe('saving to a record', () => {
  it('writes the WhatsApp name on a contact that really has the number, as the person pressing the button', async () => {
    await letTimePass(); __resetLookupCache();
    await look(admin, ON);
    const res = await request(app).post('/api/whatsapp-business/lookup/save').set('Authorization', `Bearer ${admin}`).send({ number: full(ON), recordId: leadId });
    expect(res.status).toBe(200);
    expect(res.body.savedName).toBe(true);
    const row = await db.queryOne<{ v: string }>(`SELECT whatsapp_name AS v FROM ipy_e_leads WHERE record_id = $1`, [leadId]);
    expect(row?.v).toBe('Ravi Kumar');
  });

  it('refuses a record that does not hold the number', async () => {
    const other = await recordService.createRecord(await adminContext(), 'leads', leadInput({ full_name: `Other ${stamp}`, mobile: `95${stamp}4`.slice(0, 10), country_code: '+91' }));
    const res = await request(app).post('/api/whatsapp-business/lookup/save').set('Authorization', `Bearer ${admin}`).send({ number: full(ON), recordId: other.id });
    expect(res.status).toBe(400);
    await db.query(`DELETE FROM ipy_record WHERE id = $1`, [other.id]);
  });
});

describe('the log', () => {
  it('is readable by administrators only', async () => {
    expect((await request(app).get('/api/whatsapp-business/lookup/log').set('Authorization', `Bearer ${rep}`)).status).toBe(403);
    const res = await request(app).get('/api/whatsapp-business/lookup/log').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.rows.some((r: { number: string }) => r.number === full(ON))).toBe(true);
  });
});
