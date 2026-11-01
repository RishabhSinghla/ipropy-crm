import { describe, expect, it } from 'vitest';
import { mergeByHandle, type InboxConversation } from '../src/integrations/whatsapp/business/inbox.js';

const row = (over: Partial<InboxConversation>): InboxConversation => ({
  id: 'x', handle: '9800000001', contactName: null, recordId: null, recordModule: null, recordLabel: null,
  assignedTo: null, assignedName: null, status: 'open', unreadCount: 0, lastMessageAt: null, lastMessagePreview: null,
  lastDirection: null, lastStatus: null, lane: 'chat', lanes: ['chat'], windowOpen: false, windowExpiresAt: null,
  optedOut: false, waId: null, owners: [], ...over,
});

describe('mergeByHandle', () => {
  it('one chat per person: newest row speaks, unread adds, lanes union', () => {
    const merged = mergeByHandle([
      row({ id: 'api', lane: 'api', lanes: ['api'], lastMessagePreview: 'newer', unreadCount: 1 }),
      row({ id: 'chat', lane: 'chat', lanes: ['chat'], lastMessagePreview: 'older', unreadCount: 2, recordId: 'r1' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('api');
    expect(merged[0]!.lastMessagePreview).toBe('newer');
    expect(merged[0]!.unreadCount).toBe(3);
    expect(merged[0]!.lanes).toEqual(['api', 'chat']);
    expect(merged[0]!.recordId).toBe('r1');
  });
  it('different people stay separate', () => {
    expect(mergeByHandle([row({ handle: '1' }), row({ handle: '2' })])).toHaveLength(2);
  });
});
