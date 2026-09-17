/**
 * The rule that decides whether a linked phone's traffic may enter the CRM.
 *
 * Two previous attempts at agent-linked WhatsApp were removed, both for the
 * same reason: pointed at a real handset they imported the rep's entire phone.
 * 821 chats the first time — somebody's mother, landlord and doctor, sitting in
 * a business database where their colleagues could read them.
 *
 * These cases are that failure written down so it cannot happen a third time.
 */
import { describe, expect, it } from 'vitest';
import { decide, mayImportConversation } from '../src/integrations/whatsapp/agent/historyPolicy.js';

const scope = 'known_contacts' as const;

describe('history from a linked phone', () => {
  it('never stores a past conversation with a number the CRM does not know', () => {
    const out = decide({ handle: '+919810000001', matchedRecordId: null, arrival: 'history', scope });
    expect(out.store).toBe(false);
    expect(out).toMatchObject({ reason: 'history_from_unknown_number' });
  });

  it('stores a past conversation with somebody already in the CRM', () => {
    const out = decide({ handle: '+919810000002', matchedRecordId: 'rec-1', arrival: 'history', scope });
    expect(out).toEqual({ store: true, attachTo: 'rec-1', reason: 'known_contact' });
  });

  it('refuses the whole conversation before any of its messages are read', () => {
    // Asked once per chat, so an unknown one is never in memory long enough to
    // be logged, summarised or indexed by accident.
    expect(mayImportConversation('+919810000003', null, scope)).toBe(false);
    expect(mayImportConversation('+919810000004', 'rec-2', scope)).toBe(true);
  });
});

describe('a message arriving now', () => {
  it('keeps an unknown number, unattached, for somebody to claim', () => {
    /*
      Different from history on purpose. Somebody messaging this number today is
      contacting the business through an account the rep linked deliberately —
      that is a lead. What it must not do is guess which contact it belongs to.
    */
    const out = decide({ handle: '+919810000005', matchedRecordId: null, arrival: 'live', scope });
    expect(out).toEqual({ store: true, attachTo: null, reason: 'live_unknown_number' });
  });

  it('attaches a known number to that contact and no other', () => {
    const out = decide({ handle: '+919810000006', matchedRecordId: 'rec-3', arrival: 'live', scope });
    expect(out).toMatchObject({ store: true, attachTo: 'rec-3' });
  });
});

describe('a message with nobody on the other end', () => {
  it('is refused either way, because it cannot be attributed', () => {
    for (const arrival of ['history', 'live'] as const) {
      for (const handle of [null, undefined, '', '   ']) {
        expect(decide({ handle, matchedRecordId: null, arrival, scope }).store).toBe(false);
      }
    }
  });

  it('is refused even when a record was somehow matched', () => {
    // A match with no handle means something upstream is confused; storing it
    // would put a message on a contact with no way to say who sent it.
    expect(decide({ handle: '', matchedRecordId: 'rec-4', arrival: 'live', scope }))
      .toMatchObject({ store: false, reason: 'no_handle' });
  });
});
