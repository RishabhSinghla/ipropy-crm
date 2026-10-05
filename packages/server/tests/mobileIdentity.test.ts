import { describe, expect, it } from 'vitest';
import { mobileIdentity } from '../src/core/entity/mobileIdentity.js';

describe('mobile identity normalisation', () => {
  it('matches Indian presentation variants without editing stored values', () => {
    for (const number of ['9822013456', '+91 98220 13456', '919822013456',
      '09822013456', '00919822013456', '(+91)-98220-13456']) {
      expect(mobileIdentity(number)).toBe('9822013456');
    }
  });
  it('does not collapse foreign country codes or missing digits', () => {
    expect(mobileIdentity('+44 7700 900123')).toBe('447700900123');
    expect(mobileIdentity('982201345')).toBe('982201345');
    expect(mobileIdentity('9822013456')).not.toBe(mobileIdentity('+44 9822013456'));
  });
  it('ignores empty fields', () => {
    for (const value of [null, undefined, '', ' ', '—']) expect(mobileIdentity(value)).toBeNull();
  });
});
