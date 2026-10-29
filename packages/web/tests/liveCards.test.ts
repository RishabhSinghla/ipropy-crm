import { describe, expect, it } from 'vitest';
import { chatIsInView, mayAutoDismiss, MAX_CARDS, MAX_LINES, nextCallCard, withMessage, type CallCard, type LiveCard } from '../src/lib/liveCards';
import type { LiveCallState } from '../src/lib/api';

const note = (over: Record<string, unknown> = {}) => ({ id: 'm1', body: 'hello', conversationId: 'c1', handle: '9891222206', contactName: 'Rishabh', recordId: 'r1', module: 'leads', ...over });
const live = (over: Partial<LiveCallState>): LiveCallState => ({
  state: null, number: null, direction: null, speaker: false, muted: false, connectedSecondsAgo: null,
  talkedSeconds: null, updatedSecondsAgo: null, canControlCall: false, canEndCall: false, ...over,
});

describe('WhatsApp cards', () => {
  it('makes one card per person and folds more messages into it', () => {
    let cards: LiveCard[] = withMessage([], note(), 1);
    cards = withMessage(cards, note({ id: 'm2', body: 'again' }), 2);
    expect(cards).toHaveLength(1);
    expect((cards[0] as { messages: unknown[] }).messages).toHaveLength(2);
  });
  it('ignores a message it has already shown', () => {
    const once = withMessage([], note(), 1);
    expect(withMessage(once, note(), 2)).toBe(once);
  });
  it('keeps only the latest few lines and the latest few people', () => {
    let cards: LiveCard[] = [];
    for (let i = 0; i < 6; i += 1) cards = withMessage(cards, note({ id: `x${i}` }), i);
    expect((cards[0] as { messages: unknown[] }).messages).toHaveLength(MAX_LINES);
    for (let i = 0; i < 8; i += 1) cards = withMessage(cards, note({ conversationId: `p${i}`, id: `p${i}` }), 10 + i);
    expect(cards).toHaveLength(MAX_CARDS);
  });
  it('shows nothing for a message with no thread to reply to', () => {
    expect(withMessage([], note({ conversationId: undefined }), 1)).toEqual([]);
  });
  it('stays quiet only when that very chat is open and focused', () => {
    expect(chatIsInView('r1', 'r1', true)).toBe(true);
    expect(chatIsInView('r1', 'r1', false)).toBe(false);
    expect(chatIsInView('r1', 'r2', true)).toBe(false);
    expect(chatIsInView(null, null, true)).toBe(false);
  });
  it('dismisses messages by itself unless hovered, and never dismisses a ringing phone', () => {
    const [msg] = withMessage([], note(), 1);
    expect(mayAutoDismiss(msg!, false)).toBe(true);
    expect(mayAutoDismiss(msg!, true)).toBe(false);
    const ring = nextCallCard(null, live({ state: 'ringing', direction: 'incoming', number: '98' }), 1).card!;
    expect(mayAutoDismiss(ring, false)).toBe(false);
  });
});

describe('call card', () => {
  const ringing = live({ state: 'ringing', direction: 'incoming', number: '9891222206', canEndCall: true });
  it('appears when an incoming call rings, and offers Decline only if the phone can end it', () => {
    const { card, changed } = nextCallCard(null, ringing, 1);
    expect(changed).toBe(true);
    expect(card).toMatchObject({ phase: 'ringing', number: '9891222206', canDecline: true });
  });
  it('ignores an outgoing call', () => {
    expect(nextCallCard(null, live({ state: 'ringing', direction: 'outgoing', number: '1' }), 1).card).toBeNull();
  });
  it('does not rebuild the card on a repeat report', () => {
    const first = nextCallCard(null, ringing, 1).card;
    expect(nextCallCard(first, ringing, 2).changed).toBe(false);
  });
  it('becomes Missed when it ends unanswered, and goes away when answered', () => {
    const first = nextCallCard(null, ringing, 1).card as CallCard;
    expect(nextCallCard(first, live({ state: 'ended', talkedSeconds: 0 }), 2).card?.phase).toBe('missed');
    expect(nextCallCard(first, live({ state: 'active' }), 2).card).toBeNull();
  });
});
