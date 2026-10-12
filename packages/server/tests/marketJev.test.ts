import { describe, expect, it } from 'vitest';
import { mergeReadings, readJevAnswers, withoutPhoneNumbers } from '../src/core/market/jev.js';
import { readPost } from '../src/core/market/readPost.js';

// The shape Jev really answered with on 12 October 2026 for a plot for sale.
const REAL_ANSWER = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    kind: { type: 'choice', choice: 'inventory', probabilities: { inventory: 1, lead: 0, noise: 0 }, confidence: 1 },
    is_property_post: { type: 'noul', noul: 0.98 },
    urgency: { type: 'score', score: 1.18 },
    category: { type: 'choice', choice: 'Residential Plot', confidence: 0.9 },
    author_role: { type: 'choice', choice: 'Seller', confidence: 0.8 },
  },
};

describe('reading what Jev answers', () => {
  it('reads the live shape', () => {
    expect(readJevAnswers(REAL_ANSWER)).toEqual({
      kind: 'inventory', kindConfidence: 1, isPropertyPost: 0.98, urgency: 1.18,
      category: 'Residential Plot', role: 'Seller', purpose: null, purposeConfidence: null,
    });
  });

  it('also reads the older shape, with "selected" and "probability"', () => {
    const older = { answers: { kind: { selected: 'lead', confidence: 0.9 }, is_property_post: { probability: 0.7 } } };
    expect(readJevAnswers(older)).toMatchObject({ kind: 'lead', kindConfidence: 0.9, isPropertyPost: 0.7 });
  });

  it('answers null for anything it cannot read, so the word lists stand', () => {
    expect(readJevAnswers(null)).toBeNull();
    expect(readJevAnswers({ answers: {} })).toBeNull();
    expect(readJevAnswers('rate limited')).toBeNull();
  });

  it('ignores a category or role that is not one of ours', () => {
    const odd = { answers: { kind: { choice: 'lead', confidence: 1 }, category: { choice: 'Spaceship' }, author_role: { choice: 'Wizard' } } };
    expect(readJevAnswers(odd)).toMatchObject({ category: null, role: null });
  });
});

describe('Jev overriding the word lists', () => {
  const words = readPost('Need 3 BHK in Greenfields');
  const jev = (kind: 'inventory' | 'lead' | 'noise', kindConfidence: number) =>
    ({ kind, kindConfidence, isPropertyPost: 1, urgency: 2, category: 'Apartment', role: 'Dealer', purpose: null, purposeConfidence: null }) as const;

  it('corrects a post the word lists read the wrong way round', () => {
    const merged = mergeReadings({ ...words, kind: 'want' }, jev('inventory', 0.95));
    expect(merged.kind).toBe('have');
  });

  it('keeps the word lists when Jev is not sure', () => {
    expect(mergeReadings({ ...words, kind: 'want' }, jev('inventory', 0.5)).kind).toBe('want');
  });

  it('hides noise only when Jev is very sure', () => {
    expect(mergeReadings(words, jev('noise', 0.95)).isNoise).toBe(true);
    expect(mergeReadings(words, jev('noise', 0.75)).isNoise).toBe(false);
  });
});

describe('what leaves for a third party', () => {
  it('has the phone numbers taken out', () => {
    expect(withoutPhoneNumbers('Call 98911 22206 or +91 9891222206 or 9891222206 now')).toBe('Call <phone> or <phone> or <phone> now');
  });

  it('leaves prices and sizes alone', () => {
    expect(withoutPhoneNumbers('250 gaj plot 3.5 cr sector 85')).toBe('250 gaj plot 3.5 cr sector 85');
  });
});

describe('reading a plot post', () => {
  it('finds sector, block and size in square yards', () => {
    const reading = readPost('Req 250 sq yd plot in Sector 85 Block D demand 3.5cr');
    expect(reading.places).toEqual(['sector 85', 'block D']);
    expect(reading.sizeSqYd).toBe(250);
  });

  it('takes the middle of a size range but never reads a price range as a size', () => {
    expect(readPost('200-300 gaj plot sec 21').sizeSqYd).toBe(250);
    expect(readPost('flat 80-90 lac available').sizeSqYd).toBeNull();
  });
});

describe('sale or rent', () => {
  it('reads a rental, and a sale ad that quotes a tenant\'s rent as a sale', () => {
    expect(readPost('2 BHK available on rent sector 21 25000 per month').purpose).toBe('rent');
    expect(readPost('Tenant required for 3 BHK builder floor').purpose).toBe('rent');
    expect(readPost('Shop to let in sector 15').purpose).toBe('rent');
    expect(readPost('3 BHK for sale sector 21, tenant paying 30000 rent').purpose).toBe('sale');
    expect(readPost('250 gaj plot sector 85').purpose).toBe('sale');
  });

  it('takes Jev\'s word on rent only when it is sure', () => {
    const base = { kind: 'inventory', kindConfidence: 0.9, isPropertyPost: 1, urgency: 1, category: null, role: null } as const;
    const words = readPost('3 BHK available sector 21');
    expect(mergeReadings(words, { ...base, purpose: 'rent', purposeConfidence: 0.95 }).purpose).toBe('rent');
    expect(mergeReadings(words, { ...base, purpose: 'rent', purposeConfidence: 0.5 }).purpose).toBe('sale');
  });
});

describe('reading a phone number', () => {
  it('never builds one out of the end of a longer number and the digits after it', () => {
    expect(readPost('plot ref 1791809876543 25000 per month call 9703330888').phone).toBe('9703330888');
    expect(readPost('call 97033 30888 or +91 97033-30888').phone).toBe('9703330888');
  });
});
