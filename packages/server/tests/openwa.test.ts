import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  chatIdFor, deliveryFreshness, describeSessionStatus, explainOpenWaRefusal, maskPhone,
  normaliseMessageId, parseOpenWaWebhook, phoneFromJid, toE164, toWaDigits, verifyOpenWaSignature,
} from '../src/integrations/whatsapp/business/openwa.js';

const SECRET = 'a-shared-secret-of-sufficient-length';
const sign = (body: string, secret = SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('phone numbers', () => {
  it('puts the organisation\'s country code in front of ten digits, and never invents one otherwise', () => {
    expect(toWaDigits('98912 22206')).toBe('919891222206');
    expect(toWaDigits('098912 22206')).toBe('919891222206');
    expect(toWaDigits('+91 98912-22206')).toBe('919891222206');
    expect(toWaDigits('0091 9891222206')).toBe('919891222206');
    expect(toWaDigits('98912 22206', '')).toBeNull();
    expect(toWaDigits('12345')).toBeNull();
    expect(toWaDigits('')).toBeNull();
    expect(toWaDigits(null)).toBeNull();
  });
  it('keeps a number that already has another country code', () => {
    expect(toWaDigits('+971 50 123 4567')).toBe('971501234567');
    expect(toE164('971501234567')).toBe('+971501234567');
    expect(toE164('9891222206')).toBe('+919891222206');
  });
  it('refuses more than fifteen digits', () => {
    expect(toWaDigits('1234567890123456')).toBeNull();
  });
  it('builds and reads chat ids, and refuses ids that are not a person\'s phone', () => {
    expect(chatIdFor('919891222206')).toBe('919891222206@c.us');
    expect(phoneFromJid('919891222206@c.us')).toBe('919891222206');
    expect(phoneFromJid('919891222206:12@s.whatsapp.net')).toBe('919891222206');
    expect(phoneFromJid('120363025@g.us')).toBeNull();
    expect(phoneFromJid('8812345@lid')).toBeNull();
    expect(phoneFromJid('status@broadcast')).toBeNull();
    expect(phoneFromJid(undefined)).toBeNull();
  });
  it('masks all but the last three digits', () => {
    expect(maskPhone('919891222206')).toBe('+91 ••••• •206');
    expect(maskPhone('12')).toBe('••••');
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('919891222206')).not.toContain('9891');
  });
});

describe('message ids', () => {
  it('reduces the long form the send call returns to the short form webhooks use', () => {
    expect(normaliseMessageId('true_919891222206@c.us_3EB0ABCD')).toBe('3EB0ABCD');
    expect(normaliseMessageId('false_919891222206@c.us_3EB0ABCD')).toBe('3EB0ABCD');
    expect(normaliseMessageId('3EB0ABCD')).toBe('3EB0ABCD');
    expect(normaliseMessageId('true_120363-1@g.us_3EB0AA_919891222206@c.us')).toBe('3EB0AA');
    expect(normaliseMessageId(undefined)).toBe('');
  });
});

describe('webhook signature', () => {
  const body = JSON.stringify({ event: 'message.received', timestamp: new Date().toISOString() });
  it('accepts the signature made with the shared secret', () => {
    expect(verifyOpenWaSignature(body, sign(body), SECRET)).toBe(true);
  });
  it('rejects a wrong secret, an edited body, a missing or malformed header, and no configured secret', () => {
    expect(verifyOpenWaSignature(body, sign(body, 'another-secret-entirely-xx'), SECRET)).toBe(false);
    expect(verifyOpenWaSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(verifyOpenWaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyOpenWaSignature(body, 'sha256=zz', SECRET)).toBe(false);
    expect(verifyOpenWaSignature(body, sign(body).replace('sha256=', ''), SECRET)).toBe(false);
    expect(verifyOpenWaSignature(body, sign(body), '')).toBe(false);
  });
  it('does not throw on a header of the wrong length', () => {
    expect(verifyOpenWaSignature(body, `sha256=${'a'.repeat(10)}`, SECRET)).toBe(false);
  });
});

describe('replay protection', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const at = (iso: string): string => JSON.stringify({ event: 'x', timestamp: iso });
  const WINDOW = 30 * 60_000;
  it('accepts a fresh delivery', () => {
    expect(deliveryFreshness(at('2026-10-24T11:59:00Z'), WINDOW, now)).toEqual({ ok: true });
  });
  it('rejects a captured delivery replayed later', () => {
    expect(deliveryFreshness(at('2026-10-24T11:00:00Z'), WINDOW, now)).toEqual({ ok: false, reason: 'stale' });
  });
  it('rejects a delivery from the far future and one with no timestamp', () => {
    expect(deliveryFreshness(at('2026-10-24T13:00:00Z'), WINDOW, now)).toEqual({ ok: false, reason: 'from-the-future' });
    expect(deliveryFreshness('{}', WINDOW, now)).toEqual({ ok: false, reason: 'no-timestamp' });
    expect(deliveryFreshness('not json', WINDOW, now)).toEqual({ ok: false, reason: 'unreadable' });
  });
});

const received = (data: Record<string, unknown>, event = 'message.received') => ({
  event, timestamp: new Date().toISOString(), sessionId: 's',
  data: {
    id: '3EB0AAA', from: '919891222206@c.us', to: '911100000000@c.us', chatId: '919891222206@c.us',
    body: 'hello', type: 'chat', timestamp: 1_790_000_000, isGroup: false, kind: 'individual', fromMe: false,
    contact: { pushName: 'Ravi K' }, ...data,
  },
});

describe('parsing an OpenWA delivery', () => {
  it('turns an inbound message into the CRM\'s own shape, with the WhatsApp name', () => {
    const batch = parseOpenWaWebhook(received({}));
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0]).toMatchObject({
      providerMessageId: '3EB0AAA', from: '919891222206', type: 'text', text: 'hello', profileName: 'Ravi K',
    });
    expect(batch.messages[0]!.sentAt.getTime()).toBe(1_790_000_000_000);
  });
  it('treats a message the business sent from another device as sent-elsewhere, not inbound', () => {
    const batch = parseOpenWaWebhook(received({ fromMe: true, from: '911100000000@c.us', to: '919891222206@c.us' }));
    expect(batch.messages).toHaveLength(0);
    expect(batch.sentElsewhere).toHaveLength(1);
    expect(batch.sentElsewhere![0]).toMatchObject({ to: '919891222206', text: 'hello' });
    expect(parseOpenWaWebhook(received({}, 'message.sent')).sentElsewhere).toHaveLength(1);
  });
  it('skips groups, channels and status posts', () => {
    expect(parseOpenWaWebhook(received({ isGroup: true, kind: 'group', chatId: '1203@g.us' })).messages).toHaveLength(0);
    expect(parseOpenWaWebhook(received({ kind: 'status', chatId: 'status@broadcast' })).messages).toHaveLength(0);
    expect(parseOpenWaWebhook(received({ chatId: '99@newsletter', kind: 'channel' })).messages).toHaveLength(0);
  });
  it('keeps media as metadata and drops the inline bytes', () => {
    const batch = parseOpenWaWebhook(received({
      type: 'image', body: 'the flat',
      media: { mimetype: 'image/jpeg', filename: 'a.jpg', data: 'AAAA'.repeat(1000), sizeBytes: 3000 },
    }));
    const media = batch.messages[0]!.media!;
    expect(media).toMatchObject({ mimeType: 'image/jpeg', filename: 'a.jpg', caption: 'the flat', sizeBytes: 3000 });
    expect(JSON.stringify(batch)).not.toContain('AAAAAAAA');
    expect(batch.messages[0]!.type).toBe('image');
  });
  it('uses the resolved phone for a privacy id, and counts the ones it cannot resolve', () => {
    const lid = { from: '8812345@lid', chatId: '8812345@lid' };
    const resolved = parseOpenWaWebhook(received({ ...lid, senderPhone: '919891222206' }));
    expect(resolved.messages[0]!.from).toBe('919891222206');
    const unresolved = parseOpenWaWebhook(received(lid));
    expect(unresolved.messages).toHaveLength(0);
    expect(unresolved.unresolvedSenders).toBe(1);
  });
  it('reads delivery receipts by the short message id, and failures', () => {
    const ack = parseOpenWaWebhook({ event: 'message.ack', data: { id: 'true_919891222206@c.us_3EB0AAA', status: 'read' } });
    expect(ack.statuses).toMatchObject([{ providerMessageId: '3EB0AAA', state: 'read' }]);
    const pending = parseOpenWaWebhook({ event: 'message.ack', data: { id: '3EB0AAA', status: 'pending' } });
    expect(pending.statuses).toHaveLength(0);
    const failed = parseOpenWaWebhook({ event: 'message.failed', data: { messageId: '3EB0AAA', status: 'failed' } });
    expect(failed.statuses[0]).toMatchObject({ state: 'failed' });
    expect(failed.statuses[0]!.error).toMatch(/could not deliver/i);
  });
  it('reports session changes', () => {
    expect(parseOpenWaWebhook({ event: 'session.status', data: { status: 'ready' } }).session).toEqual({ status: 'ready' });
    expect(parseOpenWaWebhook({ event: 'session.disconnected', data: {} }).session).toEqual({ status: 'disconnected' });
  });
  it('ignores events it does not use and garbage', () => {
    expect(parseOpenWaWebhook({ event: 'call.received', data: {} })).toMatchObject({ messages: [], statuses: [] });
    expect(parseOpenWaWebhook(null).messages).toEqual([]);
    expect(parseOpenWaWebhook('x').messages).toEqual([]);
  });
});

describe('plain-language refusals', () => {
  it('explains OpenWA\'s send pacing with the wait', () => {
    const text = explainOpenWaRefusal(429, { code: 'SEND_PACING_LIMITED', retryAfterSeconds: 42 });
    expect(text).toMatch(/42 seconds/);
    expect(text).not.toMatch(/SEND_PACING/);
  });
  it('says when sending comes back after a long daily-allowance pause, not a count of seconds', () => {
    const text = explainOpenWaRefusal(429, { code: 'SEND_PACING_LIMITED', retryAfterSeconds: 49_728 });
    expect(text).toMatch(/allowance/);
    expect(text).toMatch(/India time/);
    expect(text).not.toMatch(/49[, ]?728|seconds/);
  });
  it('explains a bad key, a missing session and a disconnected phone', () => {
    expect(explainOpenWaRefusal(401, {})).toMatch(/API key/);
    expect(explainOpenWaRefusal(404, { message: "Session 'x' not found" })).toMatch(/does not know that session/);
    expect(explainOpenWaRefusal(400, { message: 'Session is not active' })).toMatch(/not connected/);
  });
  it('describes the session states in words', () => {
    expect(describeSessionStatus('ready')).toMatch(/ready/);
    expect(describeSessionStatus('qr_ready')).toMatch(/QR/);
    expect(describeSessionStatus('disconnected')).toMatch(/disconnected/);
  });
});
