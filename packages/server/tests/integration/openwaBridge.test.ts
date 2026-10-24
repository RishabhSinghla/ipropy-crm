/**
 * The OpenWA bridge, end to end against a real database and a pretend OpenWA.
 *
 * Nothing here touches WhatsApp: `fakeOpenWa` answers the few routes the CRM
 * uses and records what it was asked to send. What this proves, and a unit test
 * cannot, is the wiring — that a signed webhook becomes a message on the right
 * contact, that a send reaches OpenWA with the right chat id, and above all that
 * every guard-rail refuses *before* anything reaches OpenWA.
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { invalidate as reloadIntegrations, saveIntegration } from '../../src/core/settings/integrations.js';
import { __resetOpenWaCaches, OPENWA_PROVIDER, openWaProvider, openWaStats } from '../../src/integrations/whatsapp/business/openwa.js';
import { __resetLinkHealth, checkOpenWaNow } from '../../src/integrations/whatsapp/business/openwaHealth.js';
import { sendOnBusinessNumber } from '../../src/integrations/whatsapp/business/send.js';
import { adminContext, adminToken, leadInput } from './fixtures.js';
import { inboundMessage, startFakeOpenWa, type FakeOpenWa } from '../fakes/fakeOpenWa.js';

const SECRET = 'integration-webhook-secret-123456';
const stamp = Date.now();
const tail = (n: number): string => `${String(stamp).slice(-7)}${n}`;
const KNOWN = `98${tail(1)}`;          // a contact the CRM has
const STRANGER = `97${tail(2)}`;       // a number the CRM has never heard of
const OTHER = `96${tail(3)}`;          // on no record at all

let app: ReturnType<typeof createApp>;
let token = '';
let fake: FakeOpenWa;
let recordId = '';
let userId = '';
const previouslyActive: string[] = [];

const bearer = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });

function signed(event: string, data: Record<string, unknown>, opts: { at?: string; secret?: string; unsigned?: boolean } = {}) {
  const body = JSON.stringify({
    event, timestamp: opts.at ?? new Date().toISOString(), sessionId: 'company',
    idempotencyKey: `msg_company_${String(data.id ?? data.messageId)}`, deliveryId: 'dlv_x', data,
  });
  const header = opts.unsigned ? {} : {
    'x-openwa-signature': `sha256=${createHmac('sha256', opts.secret ?? SECRET).update(body).digest('hex')}`,
  };
  return request(app).post('/api/webhooks/whatsapp/openwa').set('content-type', 'application/json').set(header).send(body);
}

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value as T;
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** Let the spacing rule pass without the test sleeping through it. */
const letTimePass = (): Promise<unknown> => db.query(
  `UPDATE ipy_message SET created_at = created_at - interval '30 seconds'
    WHERE provider = $1 AND created_at > now() - interval '10 minutes'`, [OPENWA_PROVIDER],
);

const rows = (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
  db.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);

beforeAll(async () => {
  app = createApp();
  token = await adminToken(app);
  fake = await startFakeOpenWa({ sessionName: 'company' });
  userId = (await adminContext()).user.id;

  const active = await rows(`SELECT provider FROM ipy_integration WHERE provider LIKE 'whatsapp\\_%' AND is_active`);
  previouslyActive.push(...active.map((r) => String(r.provider)));
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider LIKE 'whatsapp\\_%'`);
  await saveIntegration(OPENWA_PROVIDER, {
    config: {
      baseUrl: fake.baseUrl, sessionName: 'company',
      dailyCapPerUser: '50', dailyCapPerNumber: '3', minSpacingSeconds: '3',
    },
    credentials: { apiKey: fake.apiKey, webhookSecret: SECRET },
    isActive: true,
  });
  await reloadIntegrations();

  const lead = await recordService.createRecord(await adminContext(), 'leads', leadInput({
    full_name: `OpenWA Test ${stamp}`, mobile: KNOWN,
  }));
  recordId = lead.id;
});

afterAll(async () => {
  await fake.close();
  await db.query(`DELETE FROM ipy_wa_webhook_event WHERE provider = $1`, [OPENWA_PROVIDER]);
  await db.query(
    `DELETE FROM ipy_message WHERE conversation_id IN
       (SELECT id FROM ipy_conversation WHERE right(handle, 7) = ANY($1))`,
    [[KNOWN.slice(-7), STRANGER.slice(-7), OTHER.slice(-7)]],
  );
  await db.query(`DELETE FROM ipy_conversation WHERE right(handle, 7) = ANY($1)`, [[KNOWN.slice(-7), STRANGER.slice(-7), OTHER.slice(-7)]]);
  await db.query(`DELETE FROM ipy_record WHERE id = $1 OR label LIKE $2`, [recordId, `%${STRANGER.slice(-7)}%`]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = $1`, [OPENWA_PROVIDER]);
  for (const provider of previouslyActive) {
    if (provider !== OPENWA_PROVIDER) await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = $1`, [provider]);
  }
  await reloadIntegrations();
});

describe('connecting', () => {
  it('shows the session state and a masked number, and never the API key', async () => {
    const res = await request(app).post(`/api/admin/integrations/${OPENWA_PROVIDER}/test`).set(bearer());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/ready/);
    expect(res.body.message).not.toContain(fake.phone);
    expect(res.body.message).toMatch(/•/);
    const card = await request(app).get(`/api/admin/integrations/${OPENWA_PROVIDER}`).set(bearer());
    expect(JSON.stringify(card.body)).not.toContain(fake.apiKey);
    expect(JSON.stringify(card.body)).not.toContain(SECRET);
  });

  it('explains a session that needs linking again', async () => {
    fake.status = 'qr_ready'; __resetOpenWaCaches();
    const res = await request(app).post(`/api/admin/integrations/${OPENWA_PROVIDER}/test`).set(bearer());
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/QR/);
    fake.status = 'ready'; __resetOpenWaCaches();
  });

  it('says so when the API key is wrong', async () => {
    await saveIntegration(OPENWA_PROVIDER, { credentials: { apiKey: 'wrong-key' } }); await reloadIntegrations(); __resetOpenWaCaches();
    const res = await request(app).post(`/api/admin/integrations/${OPENWA_PROVIDER}/test`).set(bearer());
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/API key/);
    await saveIntegration(OPENWA_PROVIDER, { credentials: { apiKey: fake.apiKey } }); await reloadIntegrations(); __resetOpenWaCaches();
  });

  it('switching OpenWA on switches the other WhatsApp connection off', async () => {
    await db.query(`UPDATE ipy_integration SET is_active = true WHERE provider = 'whatsapp_meta'`);
    await reloadIntegrations();
    const res = await request(app).put(`/api/admin/integrations/${OPENWA_PROVIDER}`).set(bearer()).send({ isActive: true });
    expect(res.status).toBe(200);
    const meta = await db.queryOne<{ is_active: boolean }>(`SELECT is_active FROM ipy_integration WHERE provider = 'whatsapp_meta'`);
    expect(meta!.is_active).toBe(false);
  });
});

describe('what arrives', () => {
  it('refuses a delivery with a bad or missing signature, and a stale one', async () => {
    const data = inboundMessage({ phone: `91${KNOWN}`, id: `BAD${stamp}` });
    expect((await signed('message.received', data, { secret: 'not-the-secret-not-the-secret' })).status).toBe(401);
    expect((await signed('message.received', data, { unsigned: true })).status).toBe(401);
    expect((await signed('message.received', data, { at: new Date(Date.now() - 2 * 3600_000).toISOString() })).status).toBe(401);
    const none = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_message WHERE provider_message_id = $1`, [`BAD${stamp}`]);
    expect(Number(none!.n)).toBe(0);
    expect(openWaStats.rejectedWebhooks).toBeGreaterThanOrEqual(3);
  });

  it('stores a customer\'s message on the contact that holds the number, once', async () => {
    const data = inboundMessage({ phone: `91${KNOWN}`, id: `IN${stamp}A` });
    expect((await signed('message.received', data)).status).toBe(200);
    const row = await until(() => db.queryOne<{ body: string; direction: string; record_id: string }>(
      `SELECT m.body, m.direction, c.record_id FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
        WHERE m.provider_message_id = $1`, [`IN${stamp}A`]));
    expect(row).toMatchObject({ body: 'Is the flat still available?', direction: 'inbound', record_id: recordId });

    // The same delivery again — a retry, or someone replaying a captured request.
    expect((await signed('message.received', data)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const count = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_message WHERE provider_message_id = $1`, [`IN${stamp}A`]);
    expect(Number(count!.n)).toBe(1);
  });

  it('keeps a stranger as an unmatched chat and does not invent a contact', async () => {
    const before = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_record WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'leads') AND is_deleted = false`);
    await signed('message.received', inboundMessage({ phone: `91${STRANGER}`, id: `IN${stamp}B`, contact: { pushName: 'Sunita Verma' } }));
    const convo = await until(() => db.queryOne<{ id: string; record_id: string | null; contact_name: string }>(
      `SELECT id, record_id, contact_name FROM ipy_conversation WHERE right(handle, 10) = $1`, [STRANGER]));
    expect(convo).toMatchObject({ record_id: null, contact_name: 'Sunita Verma' });
    const after = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_record WHERE module_id = (SELECT id FROM ipy_module WHERE name = 'leads') AND is_deleted = false`);
    expect(after!.n).toBe(before!.n);

    const list = await request(app).get('/api/whatsapp-business/conversations?filter=unmatched').set(bearer());
    expect(list.status).toBe(200);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(convo.id);
    // Linked-device chats have no 24-hour window to wait out.
    expect(list.body.find((c: { id: string }) => c.id === convo.id).windowOpen).toBe(true);
  });

  it('records a message the business sent from the phone, once', async () => {
    const data = inboundMessage({
      phone: `91${KNOWN}`, id: `OUT${stamp}A`, fromMe: true, body: 'Sent from the phone',
      from: '919800000001@c.us', to: `91${KNOWN}@c.us`, timestamp: Math.floor(Date.now() / 1000) - 120,
    });
    await signed('message.sent', data);
    const row = await until(() => db.queryOne<{ direction: string; body: string; sent_by: string | null }>(
      `SELECT direction, body, sent_by FROM ipy_message WHERE provider_message_id = $1`, [`OUT${stamp}A`]));
    expect(row).toMatchObject({ direction: 'outbound', body: 'Sent from the phone', sent_by: null });
    await signed('message.sent', data);
    await new Promise((r) => setTimeout(r, 300));
    const count = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_message WHERE provider_message_id = $1`, [`OUT${stamp}A`]);
    expect(Number(count!.n)).toBe(1);
  });

  it('keeps media as metadata only', async () => {
    await signed('message.received', inboundMessage({
      phone: `91${KNOWN}`, id: `IN${stamp}C`, type: 'image', body: 'photo',
      media: { mimetype: 'image/jpeg', filename: 'flat.jpg', data: 'QUJD'.repeat(500), sizeBytes: 1500 },
    }));
    const row = await until(() => db.queryOne<{ media: Record<string, unknown> }>(
      `SELECT media FROM ipy_message WHERE provider_message_id = $1`, [`IN${stamp}C`]));
    expect(row.media).toMatchObject({ mimeType: 'image/jpeg', filename: 'flat.jpg', sizeBytes: 1500 });
    expect(JSON.stringify(row.media)).not.toContain('QUJD');
    const attachments = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_attachment WHERE record_id = $1 AND category = 'whatsapp'`, [recordId]);
    expect(Number(attachments!.n)).toBe(0);
  });

  it('serves a received file only when asked, by fetching it from OpenWA', async () => {
    fake.media.set(`IN${stamp}C`, { mimeType: 'image/jpeg', data: Buffer.from('JPEGBYTES') });
    const msg = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_message WHERE provider_message_id = $1`, [`IN${stamp}C`]);
    const before = fake.requests.length;
    const res = await request(app).get(`/api/whatsapp-business/messages/${msg!.id}/file`).set(bearer());
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/inline|attachment/);
    expect(fake.requests.length).toBeGreaterThan(before);
  });

  it('moves a delivery receipt forward and never back', async () => {
    const sent = await sendOnBusinessNumber({ userId, to: `91${KNOWN}`, text: 'receipt test', recordId });
    const id = fake.sends.at(-1)!.chatId && (await db.queryOne<{ provider_message_id: string }>(`SELECT provider_message_id FROM ipy_message WHERE id = $1`, [sent.messageId]))!.provider_message_id;
    await signed('message.ack', { id, status: 'read', chatId: `91${KNOWN}@c.us` });
    await until(async () => (await db.queryOne<{ status: string }>(`SELECT status FROM ipy_message WHERE id = $1`, [sent.messageId]))?.status === 'read');
    await signed('message.ack', { id, status: 'delivered' });
    await new Promise((r) => setTimeout(r, 300));
    expect((await db.queryOne<{ status: string }>(`SELECT status FROM ipy_message WHERE id = $1`, [sent.messageId]))!.status).toBe('read');
    await letTimePass();
  });
});

describe('sending', () => {
  it('sends one message to one contact, as the CRM user, with the OpenWA id stored short', async () => {
    const before = fake.sends.length;
    const res = await request(app).post('/api/whatsapp-business/send').set(bearer())
      .send({ to: `91${KNOWN}`, text: 'Yes, it is available.', recordId });
    expect(res.status).toBe(200);
    expect(fake.sends).toHaveLength(before + 1);
    const sent = fake.sends.at(-1)!;
    expect(sent).toMatchObject({ route: 'send-text', chatId: `91${KNOWN}@c.us`, text: 'Yes, it is available.' });
    expect(sent.idempotencyKey).toBeTruthy();
    const row = await db.queryOne<{ sent_by: string; status: string; provider_message_id: string }>(
      `SELECT sent_by, status, provider_message_id FROM ipy_message WHERE id = $1`, [res.body.messageId]);
    expect(row).toMatchObject({ sent_by: userId, status: 'sent' });
    expect(row!.provider_message_id).toMatch(/^FAKE[A-Z0-9]+$/);
    await letTimePass();
  });

  it('sends a single attachment as base64 and the bytes arrive intact', async () => {
    const bytes = Buffer.from('%PDF-1.4 pretend brochure');
    const id = await openWaProvider.uploadMedia({ data: bytes, mimeType: 'application/pdf', filename: 'brochure.pdf' });
    const outcome = await openWaProvider.sendMediaById({
      to: `91${KNOWN}`, type: 'document', mediaId: id, caption: 'Brochure', filename: 'brochure.pdf',
    });
    expect(outcome.providerMessageId).toMatch(/^FAKE[A-Z0-9]+$/);
    expect(fake.sends.at(-1)).toMatchObject({
      route: 'send-document', chatId: `91${KNOWN}@c.us`, caption: 'Brochure', filename: 'brochure.pdf', bytes: bytes.byteLength,
    });
    // The same upload cannot be sent twice.
    await expect(openWaProvider.sendMediaById({ to: `91${KNOWN}`, type: 'document', mediaId: id })).rejects.toThrow(/expired/);
    await letTimePass();
  });

  it('refuses a second send inside the minimum spacing, and names the wait', async () => {
    await letTimePass();
    await request(app).post('/api/whatsapp-business/send').set(bearer()).send({ to: `91${KNOWN}`, text: 'one', recordId });
    const before = fake.sends.length;
    const res = await request(app).post('/api/whatsapp-business/send').set(bearer()).send({ to: `91${KNOWN}`, text: 'two', recordId });
    expect(res.status).toBe(400);
    expect(res.body.error?.message ?? res.body.message).toMatch(/spaced out|wait/i);
    expect(fake.sends).toHaveLength(before);
    await letTimePass();
  });

  it('stops at the per-number daily cap even when the user has room', async () => {
    await db.query(`DELETE FROM ipy_message WHERE provider = $1 AND conversation_id IN (SELECT id FROM ipy_conversation WHERE right(handle,10) = $2)`, [OPENWA_PROVIDER, KNOWN]);
    for (let i = 0; i < 3; i += 1) {
      await letTimePass();
      const ok = await request(app).post('/api/whatsapp-business/send').set(bearer()).send({ to: `91${KNOWN}`, text: `n${i}`, recordId });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    }
    await letTimePass();
    const before = fake.sends.length;
    const res = await request(app).post('/api/whatsapp-business/send').set(bearer()).send({ to: `91${KNOWN}`, text: 'too many', recordId });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/already had 3 messages/);
    expect(fake.sends).toHaveLength(before);
  });

  it('refuses a number that is not on the record, and a typed-in stranger with no chat', async () => {
    const before = fake.sends.length;
    const wrongNumber = await request(app).post('/api/whatsapp-business/send').set(bearer())
      .send({ to: `91${OTHER}`, text: 'hi', recordId });
    expect(wrongNumber.status).toBe(403);
    const stranger = await request(app).post('/api/whatsapp-business/send').set(bearer())
      .send({ to: `91${OTHER}`, text: 'hi' });
    expect(stranger.status).toBe(403);
    expect(fake.sends).toHaveLength(before);
  });

  it('will not use the linked device for a template or a campaign', async () => {
    await expect(sendOnBusinessNumber({
      userId, to: `91${KNOWN}`, recordId, template: { name: 'promo', language: 'en', params: [] },
    })).rejects.toThrow(/cannot do/i);
  });

  it('refuses before writing anything when the phone is not linked', async () => {
    fake.status = 'disconnected'; __resetOpenWaCaches();
    const rowsBefore = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_message WHERE provider = $1`, [OPENWA_PROVIDER]);
    const sendsBefore = fake.sends.length;
    const res = await request(app).post('/api/whatsapp-business/send').set(bearer()).send({ to: `91${KNOWN}`, text: 'x', recordId });
    fake.status = 'ready'; __resetOpenWaCaches();
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not connected/i);
    expect(fake.sends).toHaveLength(sendsBefore);
    const rowsAfter = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM ipy_message WHERE provider = $1`, [OPENWA_PROVIDER]);
    expect(rowsAfter!.n).toBe(rowsBefore!.n);
  });

  it('shows OpenWA\'s own rate limit in plain words and marks the message failed', async () => {
    await db.query(`DELETE FROM ipy_message WHERE provider = $1 AND conversation_id IN (SELECT id FROM ipy_conversation WHERE right(handle,10) = $2)`, [OPENWA_PROVIDER, KNOWN]);
    fake.pacingRetryAfter = 42;
    const res = await request(app).post('/api/whatsapp-business/send').set(bearer()).send({ to: `91${KNOWN}`, text: 'paced', recordId });
    fake.pacingRetryAfter = null;
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/42 seconds/);
    expect(JSON.stringify(res.body)).not.toMatch(/SEND_PACING_LIMITED/);
    const failed = await db.queryOne<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM ipy_message WHERE provider = $1 AND body = 'paced'`, [OPENWA_PROVIDER]);
    expect(failed!.status).toBe('failed');
    expect(failed!.error_message).toMatch(/42 seconds/);
  });
});

describe('create a contact from an unmatched chat', () => {
  it('prefills the phone and the WhatsApp name, links the chat, and cannot be done twice', async () => {
    const convo = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_conversation WHERE right(handle, 10) = $1`, [STRANGER]);
    const res = await request(app).post(`/api/whatsapp-business/conversations/${convo!.id}/create-lead`).set(bearer());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lead = await recordService.getRecord(await adminContext(), 'leads', res.body.recordId);
    expect(lead.values.full_name).toBe('Sunita Verma');
    expect(String(lead.values.mobile)).toBe(STRANGER);
    const linked = await db.queryOne<{ record_id: string }>(`SELECT record_id FROM ipy_conversation WHERE id = $1`, [convo!.id]);
    expect(linked!.record_id).toBe(res.body.recordId);
    const again = await request(app).post(`/api/whatsapp-business/conversations/${convo!.id}/create-lead`).set(bearer());
    expect(again.status).toBe(400);
  });
});

describe('when OpenWA is down', () => {
  it('fails the send visibly, keeps the CRM answering, and reports the state', async () => {
    await db.query(`DELETE FROM ipy_message WHERE provider = $1 AND conversation_id IN (SELECT id FROM ipy_conversation WHERE right(handle,10) = $2)`, [OPENWA_PROVIDER, KNOWN]);
    __resetLinkHealth(); __resetOpenWaCaches();
    await fake.close();
    const res = await request(app).post('/api/whatsapp-business/send').set(bearer()).send({ to: `91${KNOWN}`, text: 'hello?', recordId });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cannot reach OpenWA/i);

    const health = await checkOpenWaNow();
    expect(health.state).toBe('unreachable');
    const status = await request(app).get('/api/whatsapp-business/status').set(bearer());
    expect(status.status).toBe(200);
    expect(status.body.link.state).toBe('unreachable');
    const metrics = await request(app).get('/api/whatsapp-business/openwa/health').set(bearer());
    expect(metrics.status).toBe(200);
    expect(metrics.body).toHaveProperty('sendsToday');
    // No secret leaves the server in the health numbers.
    expect(JSON.stringify(metrics.body)).not.toContain(fake.apiKey);
    const lastPoll = await db.queryOne<{ value: { ok: boolean } }>(`SELECT value FROM ipy_setting WHERE key = 'whatsapp.last_poll'`);
    expect(lastPoll!.value.ok).toBe(false);
    // And the CRM itself carries on.
    expect((await request(app).get('/api/auth/me').set(bearer())).status).toBe(200);
    fake = await startFakeOpenWa({ sessionName: 'company' });
  });
});
