import { describe, expect, it } from 'vitest';
import { normaliseLookupNumber } from '../src/integrations/whatsapp/business/lookup.js';

describe('the number somebody pastes', () => {
  it('turns every usual spelling into one set of digits with the country code first', () => {
    for (const typed of ['9891222206', '+91 98912 22206', '+91-98912-22206', '098912 22206', '00919891222206', '(+91) 9891222206', '919891222206']) {
      expect(normaliseLookupNumber(typed, '91'), typed).toBe('919891222206');
    }
  });
  it('keeps another country\'s number as typed', () => {
    expect(normaliseLookupNumber('+971 50 123 4567', '91')).toBe('971501234567');
    expect(normaliseLookupNumber('+44 7700 900123', '91')).toBe('447700900123');
  });
  it('refuses what cannot be a phone number', () => {
    for (const typed of ['', 'abc', '12345', '1'.repeat(20)]) expect(normaliseLookupNumber(typed, '91'), typed).toBeNull();
  });
});
