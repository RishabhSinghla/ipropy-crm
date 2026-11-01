import { describe, expect, it } from 'vitest';
import { senderLine } from '../src/lib/whatsapp';

describe('senderLine', () => {
  it('sent: from our number, by the agent', () => {
    expect(senderLine({ direction: 'outbound', numberName: 'yogesh-phone', numberPhone: '+91 98xxx', sentByName: 'Yogesh' }))
      .toBe('from yogesh-phone · +91 98xxx · by Yogesh');
  });
  it('received: to our number', () => {
    expect(senderLine({ direction: 'inbound', numberName: 'iPropy Floors', numberPhone: '+91 98217 72933', sentByName: 'Ignored' }))
      .toBe('to iPropy Floors · +91 98217 72933');
  });
  it('says nothing when nothing is known', () => {
    expect(senderLine({ direction: 'inbound' })).toBeNull();
  });
});
