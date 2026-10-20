/**
 * The AI caller, connected end to end: a lost webhook is found by asking Sarvam, a finished call leaves an outcome, a
 * summary, a follow-up and a recording a rep can play, a number on the DND register is never dialled again, and a call
 * made outside the CRM lands on the right record. Sarvam itself is stubbed at the network edge only; everything after
 * is the real code against a real database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { saveIntegration } from '../../src/core/settings/integrations.js';
import { reconcileSarvam } from '../../src/integrations/voiceagent/reconcile.js';
import { isOptedOut } from '../../src/core/consent/index.js';
import { adminContext, adminToken, leadInput } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
const stamp = Date.now();
const agent = `Reconcile-agent-${stamp}`;
const lostAttempt = `lost-${stamp}`;
const outsideAttempt = `outside-${stamp}`;
const ndncAttempt = `ndnc-${stamp}`;
let callbackRecord = '';
let outsideRecord = '';
let ndncRecord = '';
let outsidePhone = '';
let ndncPhone = '';
let lostCallId = '';
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString().replace('Z', '');
const e164 = (value: unknown) => `+91${String(value).replace(/\D/g, '').slice(-10)}`;
const WAV = Buffer.from('RIFF....WAVEfmt ');

const attempts = () => ({
  items: [
    { attempt_id: lostAttempt, interaction_id: `20261020/lost-${stamp}`, connectivity_status: 'connected', duration_in_seconds: 95, attempted_at: minutesAgo(30), start_datetime: minutesAgo(30), end_datetime: minutesAgo(28), channel_direction: 'outbound', is_debug_call: 0 },
    { attempt_id: outsideAttempt, interaction_id: `20261020/outside-${stamp}`, user_contact: outsidePhone, connectivity_status: 'connected', duration_in_seconds: 140, attempted_at: minutesAgo(45), start_datetime: minutesAgo(45), channel_direction: 'outbound', is_debug_call: 0 },
    { attempt_id: ndncAttempt, user_contact: ndncPhone, connectivity_status: 'failed', failure_reason: 'exotel: Phone number is registered under TRAI NDNC', attempted_at: minutesAgo(20), channel_direction: 'outbound', is_debug_call: 0 },
    { attempt_id: `debug-${stamp}`, connectivity_status: 'connected', user_contact: '+919000000009', channel_direction: 'outbound', is_debug_call: 1, attempted_at: minutesAgo(10) },
  ],
  next_page_uri: '',
});
const interactions = () => ({
  items: [
    { interaction_id: `20261020/lost-${stamp}`, job_id: lostAttempt, translate_transcript: [
      { role: 'agent', text: 'Hello, am I speaking with Mr. Sharma?' }, { role: 'user', text: 'Yes.' },
      { role: 'agent', text: 'Are you looking for a three BHK?' }, { role: 'user', text: 'I am driving, please call me tomorrow.' }], agent_variables: {} },
    { interaction_id: `20261020/outside-${stamp}`, job_id: outsideAttempt, translate_transcript: [
      { role: 'agent', text: 'Hello?' }, { role: 'user', text: 'Yes, three BHK in Greenfields, budget two crore.' }, { role: 'agent', text: 'Noted.' },
      { role: 'user', text: 'Site visit on Saturday please.' }, { role: 'agent', text: 'Sure.' }, { role: 'user', text: 'Okay thanks.' }], agent_variables: {} },
  ],
  next_page_uri: '',
});

beforeAll(async () => {
  app = createApp(); token = await adminToken(app);
  await saveIntegration('sarvam_voice', { isActive: true, credentials: { apiKey: 'test-key', webhookSecret: 'reconcile-secret' },
    config: { orgId: 'test-org', workspaceId: 'test-ws', appId: agent, appVersion: '1', connectionId: 'conn', agentPhoneNumber: '+917965481133',
      agentsByModule: JSON.stringify({ leads: { appId: agent, appVersion: 1 } }) } });
  const ctx = await adminContext();
  const create = async (name: string) => recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${name} ${stamp}` }));
  const a = await create('Reconcile Callback'); callbackRecord = a.id;
  const b = await create('Reconcile Outside'); outsideRecord = b.id; outsidePhone = e164(b.values.mobile);
  const c = await create('Reconcile Ndnc'); ndncRecord = c.id; ndncPhone = e164(c.values.mobile);
  // A call the CRM placed ten minutes ago whose webhook never arrived.
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_call (direction, from_number, to_number, status, provider, provider_call_id, source, record_id, record_module, user_id, created_at, sarvam_app_id)
     VALUES ('outbound', '+917965481133', '+919000000001', 'queued', 'sarvam_voice', $1, 'sarvam', $2, 'leads', $3, now() - interval '40 minutes', $4) RETURNING id`,
    [lostAttempt, callbackRecord, ctx.user.id, agent]);
  lostCallId = row!.id;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/attempts')) return new Response(JSON.stringify(attempts()), { status: 200 });
    if (url.includes('/interactions')) return new Response(JSON.stringify(interactions()), { status: 200 });
    if (url.includes('/recordings/')) return new Response(WAV, { status: 200, headers: { 'content-type': 'audio/wav' } });
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => undefined);
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.query(`DELETE FROM ipy_channel_optout WHERE handle = ANY($1)`, [[ndncPhone.slice(-10)]]);
  await saveIntegration('sarvam_voice', { isActive: false });
});

describe('the AI caller agrees with Sarvam', () => {
  it('completes a call whose result never arrived, and gives it an outcome, a summary, a follow-up and a recording', async () => {
    const report = await reconcileSarvam({ hours: 24 });
    expect(report.ok).toBe(true);
    expect(report.completed).toBeGreaterThanOrEqual(1);

    const call = await db.queryOne<Record<string, unknown>>(`SELECT * FROM ipy_call WHERE id = $1`, [lostCallId]);
    expect(call).toMatchObject({ status: 'completed', duration_seconds: 95, sarvam_interaction_id: `20261020/lost-${stamp}`, recording_url: `sarvam:20261020/lost-${stamp}` });
    expect(String(call!.transcript)).toContain('Customer: I am driving, please call me tomorrow.');
    // Named from the dropdown this database has (production says "Call Back Request", a fresh seed "Call Back Later").
    expect(String(call!.disposition)).toMatch(/call ?back/i);
    expect(String(call!.ai_summary)).toContain('Asked to be called back');
    const followUp = await db.queryOne<{ next_followup_at: Date | null }>(`SELECT next_followup_at FROM ipy_e_leads WHERE record_id = $1`, [callbackRecord]);
    expect(followUp?.next_followup_at).not.toBeNull();
  });

  it('puts a call made outside the CRM on the right record, and a test call from the dashboard nowhere', async () => {
    const found = await db.queryOne<Record<string, unknown>>(`SELECT * FROM ipy_call WHERE provider_call_id = $1`, [outsideAttempt]);
    expect(found).toMatchObject({ record_id: outsideRecord, record_module: 'leads', status: 'completed', direction: 'outbound' });
    expect(String(found!.disposition)).toMatch(/connected|interested/i);
    expect((await db.query(`SELECT 1 FROM ipy_call WHERE provider_call_id = $1`, [`debug-${stamp}`])).rowCount).toBe(0);
  });

  it('never dials a number the telephone network says is on the DND register', async () => {
    const found = await db.queryOne<Record<string, unknown>>(`SELECT * FROM ipy_call WHERE provider_call_id = $1`, [ndncAttempt]);
    expect(found).toMatchObject({ record_id: ndncRecord, status: 'failed' });
    expect(await isOptedOut(ndncPhone, 'call')).toBe(true);
  });

  it('is safe to run again: nothing is added twice', async () => {
    const again = await reconcileSarvam({ hours: 24 });
    expect(again.ok).toBe(true);
    expect(again.completed).toBe(0);
    expect(again.backfilled).toBe(0);
    expect((await db.query(`SELECT 1 FROM ipy_call WHERE provider_call_id = ANY($1)`, [[lostAttempt, outsideAttempt, ndncAttempt]])).rowCount).toBe(3);
  });

  it('plays the AI call\'s recording through the CRM, with the key kept on the server', async () => {
    const res = await request(app).get(`/api/telephony/calls/${lostCallId}/recording`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/wav');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
