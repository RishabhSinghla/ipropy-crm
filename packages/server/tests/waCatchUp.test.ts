import { describe, expect, it } from 'vitest';
import { lookbackStart, storedToWebhookData } from '../src/integrations/whatsapp/business/waCatchUp.js';
import { parseOpenWaWebhook } from '../src/integrations/whatsapp/business/openwa.js';

describe('catch-up reshaping', () => {
  const row = {
    id: 'internal-uuid', waMessageId: 'true_919811111111@c.us_3EB0ABCD', chatId: '919811111111@c.us',
    from: '919811111111@c.us', to: '919800000001@c.us', body: 'Is it available?', type: 'chat', direction: 'incoming', timestamp: 1_790_000_000,
  };
  it('turns a stored row into something the live parser accepts', () => {
    const batch = parseOpenWaWebhook({ event: 'message.received', sessionId: 's', data: storedToWebhookData(row) });
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0]).toMatchObject({ from: '919811111111', text: 'Is it available?' });
  });
  it('accepts a timestamp stored in milliseconds', () => {
    const d = storedToWebhookData({ ...row, timestamp: 1_790_000_000_000 });
    expect(d.timestamp).toBe(1_790_000_000);
  });
  it('never turns a group message into a customer chat', () => {
    const batch = parseOpenWaWebhook({ event: 'message.received', sessionId: 's', data: storedToWebhookData({ ...row, chatId: '120363@g.us', from: '120363@g.us' }) });
    expect(batch.messages).toHaveLength(0);
  });
});

describe('how far back to look', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  it('starts a little before the last catch-up', () => {
    expect(lookbackStart(new Date('2026-11-01T11:00:00Z'), now, 3_600_000).toISOString()).toBe('2026-11-01T10:55:00.000Z');
  });
  it('uses the fallback when there has never been one', () => {
    expect(lookbackStart(null, now, 3_600_000).toISOString()).toBe('2026-11-01T11:00:00.000Z');
  });
  it('never goes back more than 48 hours', () => {
    expect(lookbackStart(new Date('2026-10-01T00:00:00Z'), now, 3_600_000).toISOString()).toBe('2026-10-30T12:00:00.000Z');
  });
});
