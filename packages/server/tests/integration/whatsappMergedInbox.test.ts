/**
 * One inbox, both channels: a customer on plain chat AND the official API is ONE chat in the merged list and
 * ONE column in the merged thread, and every message still says which lane it belongs to. The database keeps
 * two conversations (one per lane); only the view merges them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { receiveInbound } from '../../src/integrations/whatsapp/business/inbound.js';
import { conversationMessages, listConversations, markRead } from '../../src/integrations/whatsapp/business/inbox.js';
import { setChannelRolesInMemory } from '../../src/integrations/whatsapp/business/channelRoles.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const NUMBER = `94${String(stamp).slice(-8)}`;
let adminId = '';

const inbound = (id: string, text: string) => ({
  providerMessageId: id, from: `91${NUMBER}`, to: null, type: 'text' as const,
  text, media: null, sentAt: new Date(), profileName: 'Merge Test',
});

beforeAll(async () => {
  adminId = (await adminContext()).user.id;
  setChannelRolesInMemory({ automation: 'whatsapp_whatsmarketing', chat: 'whatsapp_openwa' });
  await receiveInbound('whatsapp_openwa', inbound(`merge-${stamp}-a`, 'plain hello'));
  await receiveInbound('whatsapp_whatsmarketing', inbound(`merge-${stamp}-b`, 'api hello'));
});

afterAll(async () => {
  setChannelRolesInMemory({ automation: null, chat: null });
  await db.query(`DELETE FROM ipy_wa_webhook_event WHERE event_key LIKE $1`, [`merge-${stamp}%`]);
  await db.query(`DELETE FROM ipy_conversation WHERE handle = $1`, [NUMBER]);
});

describe('the merged inbox', () => {
  const base = { userId: '', isAdmin: true, filter: 'all' as const, search: NUMBER };

  it('lists a person once, with both lanes and the unread of both', async () => {
    const rows = await listConversations({ ...base, userId: adminId, merged: true });
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.lanes].sort()).toEqual(['api', 'chat']);
    expect(rows[0]!.unreadCount).toBe(2);
  });

  it('still lists each lane on its own when a lane is asked for', async () => {
    const api = await listConversations({ ...base, userId: adminId, merged: true, route: 'api' });
    expect(api).toHaveLength(1);
    expect(api[0]!.lanes).toEqual(['api']);
  });

  it('shows both lanes in one thread and every message names its lane', async () => {
    const row = (await listConversations({ ...base, userId: adminId, merged: true }))[0]!;
    const messages = await conversationMessages(adminId, true, row.id, undefined, true);
    expect(messages.map((m) => [m.body, m.lane]).sort()).toEqual([['api hello', 'api'], ['plain hello', 'chat']]);
  });

  it('the old per-lane thread is unchanged', async () => {
    const chat = (await listConversations({ ...base, userId: adminId, route: 'chat' }))[0]!;
    const bodies = (await conversationMessages(adminId, true, chat.id, 'chat')).map((m) => m.body);
    expect(bodies).toEqual(['plain hello']);
  });

  it('opening the merged thread marks both lanes read', async () => {
    const row = (await listConversations({ ...base, userId: adminId, merged: true }))[0]!;
    await markRead(adminId, true, row.id, true);
    const after = await listConversations({ ...base, userId: adminId, merged: true });
    expect(after[0]!.unreadCount).toBe(0);
  });
});
