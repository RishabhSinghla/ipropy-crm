import { describe, expect, it } from 'vitest';
import { fingerprintOf, localitiesOf, looksLikeADeal, parseWhatsAppExport, readPost } from '../src/core/market/readPost.js';

describe('reading a WhatsApp group export', () => {
  it('reads the Android shape, joining a long post that spans lines', () => {
    const text = [
      '12/10/2025, 10:15 am - Messages and calls are end-to-end encrypted.',
      '12/10/2025, 10:16 am - Ramesh Dealer: 3 BHK available in Greenfields',
      'Price 1.45 Cr, 2nd floor',
      '12/10/2025, 4:05 pm - Sita Realty: <Media omitted>',
    ].join('\n');
    const messages = parseWhatsAppExport(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender).toBe('Ramesh Dealer');
    expect(messages[0]!.body).toContain('Price 1.45 Cr');
    // 10:16 in India is 04:46 UTC.
    expect(messages[0]!.postedAt?.toISOString()).toBe('2025-10-12T04:46:00.000Z');
  });

  it('reads the iPhone shape', () => {
    const messages = parseWhatsAppExport('[12/10/25, 4:05:30 PM] Sita Realty: Need 2 BHK under 80 lac');
    expect(messages[0]!.sender).toBe('Sita Realty');
    expect(messages[0]!.postedAt?.toISOString()).toBe('2025-10-12T10:35:00.000Z');
  });
});

describe('naming a locality', () => {
  const known = ['NIT', 'Greenfields Colony', 'Sector 21'];

  it('finds NIT only as a word, never inside "unit", "Nitesh" or "community"', () => {
    expect(localitiesOf('3 BHK single unit, double unit, Nitesh 98100 12345, nice community', known)).toEqual([]);
    expect(localitiesOf('Plot in NIT 1 for sale', known)).toEqual(['NIT']);
    expect(localitiesOf('flat in nit.', known)).toEqual(['NIT']);
  });

  it('still reads greenfield, greenfields and the full name', () => {
    expect(localitiesOf('3 bhk greenfield', known)).toEqual(['Greenfields Colony']);
    expect(localitiesOf('Greenfields, B block', known)).toEqual(['Greenfields Colony']);
    expect(localitiesOf('Greenfields Colony', known)).toEqual(['Greenfields Colony']);
  });
});

describe('reading one post', () => {
  const known = ['Greenfields Colony', 'Sector 21'];

  it('a seller with a price in crore', () => {
    expect(readPost('3 BHK available in Greenfield, ₹1.45 Cr, call 98110 12345', known)).toEqual({
      kind: 'have', purpose: 'sale', bhk: 3, priceMinLakh: 145, priceMaxLakh: 145, localities: ['Greenfields Colony'], places: [], sizeSqYd: null, category: 'Apartment', project: null, phone: '9811012345', phones: ['9811012345'],
    });
  });

  it('a buyer with a range in lakh', () => {
    const reading = readPost('Required 2bhk in sector 21 budget 70-80 lac', known);
    expect(reading.kind).toBe('want');
    expect(reading.bhk).toBe(2);
    expect([reading.priceMinLakh, reading.priceMaxLakh]).toEqual([70, 80]);
    expect(reading.localities).toEqual(['Sector 21']);
  });

  it('the earlier word decides when a post carries both sides', () => {
    expect(readPost('Required 3 bhk, ready to move preferred').kind).toBe('want');
    expect(readPost('Available 4 bhk, need quick sale').kind).toBe('have');
  });

  it('"need buyer" is a seller, whatever the word need suggests', () => {
    expect(readPost('Need buyer for 4 bhk Greenfields').kind).toBe('have');
    expect(readPost('Buyer required, 3bhk 1.2 cr').kind).toBe('have');
  });

  it('chatter is not a deal', () => {
    expect(looksLikeADeal('ok sir', readPost('ok sir'))).toBe(false);
    expect(looksLikeADeal('3 BHK available Greenfields', readPost('3 BHK available Greenfields', known))).toBe(true);
  });

  it('the same forward is one fingerprint, whatever its spacing and case', () => {
    expect(fingerprintOf('3 BHK  available, Greenfields!')).toBe(fingerprintOf('3 bhk available greenfields'));
  });
});
