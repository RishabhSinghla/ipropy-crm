import { describe, expect, it } from 'vitest';
import { noteFor, quadrantOf, tabLine } from '../src/core/market/dealerNotes.js';

describe('a dealer\'s message as a note', () => {
  it('says which tabs the message falls under, in the order the tabs are in', () => {
    expect(tabLine([
      { kind: 'have', purpose: 'rent' }, { kind: 'have', purpose: 'sale' }, { kind: 'have', purpose: 'sale' }, { kind: 'want', purpose: 'rent' },
    ])).toBe('For Sale ×2 · For Rent · Tenant Requirements');
    expect(tabLine([{ kind: 'want', purpose: 'sale' }])).toBe('Buyer Requirements');
  });

  it('puts every kind in its own tab', () => {
    expect(quadrantOf('have', 'sale')).toBe('forSale');
    expect(quadrantOf('want', 'sale')).toBe('buyerRequirements');
    expect(quadrantOf('have', 'rent')).toBe('forRent');
    expect(quadrantOf('want', 'rent')).toBe('tenantRequirements');
  });

  it('carries the group, the day in India, the tabs and the message as the dealer wrote it', () => {
    const note = noteFor({
      groups: ['FEAWA REGISTERED MEMBERS', 'Greenfields Dealers'],
      // 11 pm UTC on the 12th is already the 13th in India.
      at: new Date('2026-10-12T23:00:00Z'),
      body: '160 gaj plot Sector 15A 3.25 Cr <This message was edited>',
      listings: [{ kind: 'have', purpose: 'sale' }],
    });
    expect(note).toBe('💬 WhatsApp · FEAWA REGISTERED MEMBERS + Greenfields Dealers · 13 Oct 2026\nFor Sale\n\n160 gaj plot Sector 15A 3.25 Cr');
  });
});
