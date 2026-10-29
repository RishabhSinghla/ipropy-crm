/**
 * A customer writes in, and the person who owns the lead is handed everything the
 * corner card needs: the thread to answer, the number, the record and the name.
 * The card in the browser is useless without these, and nothing else checks that
 * the push carries them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const pushed: Array<{ userId: string; payload: Record<string, unknown> }> = [];
vi.mock('../../src/realtime.js', async (original) => ({
  ...(await original<typeof import('../../src/realtime.js')>()),
  pushNotification: (userId: string, payload: Record<string, unknown>) => { pushed.push({ userId, payload }); },
}));

import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { receiveInbound } from '../../src/integrations/whatsapp/business/inbound.js';
import { metaCloudProvider } from '../../src/integrations/whatsapp/business/metaCloud.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const NUMBER = `96${String(stamp).slice(-8)}`;
let recordId = '';

beforeAll(async () => {
  const lead = await recordService.createRecord(await adminContext(), 'leads', {
    full_name: `Live card ${stamp}`, mobile: NUMBER, status: 'New',
  });
  recordId = lead.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_wa_webhook_event WHERE provider = 'whatsapp_meta'`);
  await db.query(`DELETE FROM ipy_notification WHERE record_id = $1`, [recordId]);
  await db.query(`DELETE FROM ipy_conversation WHERE handle = $1`, [NUMBER]);
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

describe('the live card event', () => {
  it('carries the thread, number, record and name for the corner card', async () => {
    const [message] = metaCloudProvider.parseWebhook({
      entry: [{ changes: [{ value: {
        metadata: { display_phone_number: '918800000000' },
        contacts: [{ wa_id: `91${NUMBER}`, profile: { name: 'Card Test' } }],
        messages: [{ from: `91${NUMBER}`, id: `wamid.card.${stamp}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello card' } }],
      } }] }],
    }).messages;
    const stored = await receiveInbound('whatsapp_meta', message);
    expect(stored).not.toBeNull();
    const mine = pushed.filter((p) => p.payload.recordId === recordId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]!.payload).toMatchObject({
      kind: 'whatsapp', conversationId: stored!.conversationId, handle: NUMBER, module: 'leads', recordId,
    });
    expect(String(mine[0]!.payload.body)).toContain('hello card');
  });
});
