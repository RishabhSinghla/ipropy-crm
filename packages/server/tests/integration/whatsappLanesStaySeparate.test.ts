/**
 * The two WhatsApp screens never share a thread.
 *
 * Plain WhatsApp (OpenWA) and the official API (WhatsMarketing) used to write into one conversation per phone
 * number, so the same lead showed in both screens and each screen showed the other's messages. A conversation is
 * now (number, lane). This proves, on a real database, that a message on one route is invisible to the other
 * route's list, thread, preview, unread count and the sidebar number — and that the migration splits old mixed
 * threads by the provider each message came from, without deleting anything.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { receiveInbound } from '../../src/integrations/whatsapp/business/inbound.js';
import { conversationMessages, listConversations } from '../../src/integrations/whatsapp/business/inbox.js';
import { setChannelRolesInMemory } from '../../src/integrations/whatsapp/business/channelRoles.js';
import { recordCounts } from '../../src/core/entity/recordCounts.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const NUMBER = `96${String(stamp).slice(-8)}`;
const OLD = `95${String(stamp).slice(-8)}`;
let adminId = '';

function inbound(id: string, text: string, who = NUMBER) {
  return {
    providerMessageId: id, from: `91${who}`, to: null, type: 'text' as const,
    text, media: null, sentAt: new Date(), profileName: 'Lane Test',
  };
}

beforeAll(async () => {
  adminId = (await adminContext()).user.id;
  setChannelRolesInMemory({ automation: 'whatsapp_whatsmarketing', chat: 'whatsapp_openwa' });
});

afterAll(async () => {
  setChannelRolesInMemory({ automation: null, chat: null });
  await db.query(`DELETE FROM ipy_wa_webhook_event WHERE event_key LIKE $1`, [`lane-${stamp}%`]);
  await db.query(`DELETE FROM ipy_conversation WHERE handle IN ($1, $2)`, [NUMBER, OLD]);
});

describe('a customer on both WhatsApp routes', () => {
  it('has two separate conversations, one per route', async () => {
    await receiveInbound('whatsapp_openwa', inbound(`lane-${stamp}-a`, 'plain hello'));
    await receiveInbound('whatsapp_whatsmarketing', inbound(`lane-${stamp}-b`, 'api hello'));

    const rows = await db.query<{ id: string; lane: string }>(
      `SELECT id, lane FROM ipy_conversation WHERE handle = $1 ORDER BY lane`, [NUMBER],
    );
    expect(rows.rows.map((r) => r.lane)).toEqual(['api', 'chat']);
  });

  it('lists each conversation only on its own screen, with its own preview and unread count', async () => {
    const base = { userId: adminId, isAdmin: true, filter: 'all' as const, search: NUMBER };
    const chat = await listConversations({ ...base, route: 'chat' });
    const api = await listConversations({ ...base, route: 'api' });
    expect(chat).toHaveLength(1);
    expect(api).toHaveLength(1);
    expect(chat[0]!.lastMessagePreview).toBe('plain hello');
    expect(api[0]!.lastMessagePreview).toBe('api hello');
    expect(chat[0]!.unreadCount).toBe(1);
    expect(api[0]!.unreadCount).toBe(1);
    expect(chat[0]!.id).not.toBe(api[0]!.id);
  });

  it('never shows one route\'s messages in the other route\'s thread', async () => {
    const base = { userId: adminId, isAdmin: true, filter: 'all' as const, search: NUMBER };
    const chat = (await listConversations({ ...base, route: 'chat' }))[0]!;
    const api = (await listConversations({ ...base, route: 'api' }))[0]!;
    const chatBodies = (await conversationMessages(adminId, true, chat.id, 'chat')).map((m) => m.body);
    const apiBodies = (await conversationMessages(adminId, true, api.id, 'api')).map((m) => m.body);
    expect(chatBodies).toEqual(['plain hello']);
    expect(apiBodies).toEqual(['api hello']);
    // Asking for a thread through the other screen is refused, not quietly answered.
    await expect(conversationMessages(adminId, true, chat.id, 'api')).rejects.toThrow();
  });

  it('keeps the other route\'s chats out of search hits', async () => {
    const hits = await listConversations({
      userId: adminId, isAdmin: true, filter: 'all', search: 'api hello', route: 'chat',
    });
    expect(hits.find((h) => h.handle === NUMBER)).toBeUndefined();
  });

  it('counts each route\'s conversations separately for the sidebar', async () => {
    const counts = await recordCounts(await adminContext());
    const chat = (await listConversations({ userId: adminId, isAdmin: true, filter: 'all', route: 'chat', limit: 1000 })).length;
    const api = (await listConversations({ userId: adminId, isAdmin: true, filter: 'all', route: 'api', limit: 1000 })).length;
    expect(counts.whatsapp).toBe(chat);
    expect(counts.whatsappApi).toBe(api);
  });

  it('shows a rep (not an admin) only the plain route', async () => {
    const rep = await listConversations({ userId: adminId, isAdmin: false, filter: 'all', search: NUMBER, route: 'api' });
    expect(rep.every((r) => r.lastMessagePreview !== 'api hello')).toBe(true);
  });
});

describe('migration 229 on a thread that already mixes both routes', () => {
  it('splits it by provider, deletes nothing, and is safe to run twice', async () => {
    const conv = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_conversation (channel, handle, unread_count) VALUES ('whatsapp', $1, 2) RETURNING id`, [OLD],
    );
    const add = (provider: string | null, direction: string, body: string, at: string) => db.query(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status, provider, route, created_at)
       VALUES ($1, $2, 'whatsapp', 'text', $3, 'delivered', $4, 'business', $5::timestamptz)`,
      [conv!.id, direction, body, provider, at],
    );
    await add('whatsapp_openwa', 'inbound', 'p1', '2026-10-01T10:00:00Z');
    await add('whatsapp_openwa', 'outbound', 'p2', '2026-10-01T10:01:00Z');
    await add('whatsapp_whatsmarketing', 'outbound', 'a1', '2026-10-02T10:00:00Z');
    await add('whatsapp_whatsmarketing', 'inbound', 'a2', '2026-10-02T11:00:00Z');
    await add('whatsapp_whatsmarketing', 'outbound', 'a3', '2026-10-02T12:00:00Z');
    await add(null, 'outbound', 'unknown', '2026-10-03T10:00:00Z');

    const sql = readFileSync(new URL('../../src/db/migrations/229_whatsapp_conversation_lanes.sql', import.meta.url), 'utf8');
    await db.query(sql);
    await db.query(sql);

    const convs = await db.query<{ id: string; lane: string | null }>(
      `SELECT id, lane FROM ipy_conversation WHERE handle = $1 ORDER BY lane`, [OLD],
    );
    expect(convs.rows.map((c) => c.lane)).toEqual(['api', 'chat']);
    const bodies = async (lane: string) => (await db.query<{ body: string }>(
      `SELECT m.body FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
        WHERE c.handle = $1 AND c.lane = $2 ORDER BY m.created_at`, [OLD, lane],
    )).rows.map((r) => r.body);
    expect(await bodies('api')).toEqual(['a1', 'a2', 'a3', 'unknown']);
    expect(await bodies('chat')).toEqual(['p1', 'p2']);

    const total = await db.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id WHERE c.handle = $1`, [OLD],
    );
    expect(Number(total!.n)).toBe(6);
  });
});
