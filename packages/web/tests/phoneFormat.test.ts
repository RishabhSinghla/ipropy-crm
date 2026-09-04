import { describe, expect, it } from 'vitest';
import { formatPhone, formatPhoneWithCode } from '@ipropy/shared';

// The national digits run together, whatever their length. They used to be
// grouped 5-5 like a printed card; the owner asked for the full ten digits
// unbroken. These pin the format so a well-meant "readability" tweak does not
// quietly bring the split back.
describe('formatPhone', () => {
  it('shows an Indian mobile as +91 and ten unbroken digits', () => {
    expect(formatPhone('9811533636')).toBe('+91 9811533636');
  });

  it('strips a stored 91 prefix rather than keeping it as eleven digits', () => {
    expect(formatPhone('919811533636')).toBe('+91 9811533636');
  });

  it('leaves anything it cannot parse as it found it', () => {
    // A UK landline is twelve digits that do not start with 91: not an Indian
    // mobile in either stored shape, so it passes through untouched.
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhone('12345')).toBe('12345');
  });

  it('answers the empty value with a dash, like every other formatter', () => {
    expect(formatPhone(null)).toBe('—');
    expect(formatPhone('')).toBe('—');
  });
});

describe('formatPhoneWithCode', () => {
  it('joins the stored country code onto unbroken national digits', () => {
    expect(formatPhoneWithCode('91', '9811533636')).toBe('+91 9811533636');
  });

  it('keeps a code the user chose, UAE included, without inventing a split', () => {
    expect(formatPhoneWithCode('+971', '501234567')).toBe('+971 501234567');
  });

  it('falls back to formatPhone when no code was stored', () => {
    expect(formatPhoneWithCode(null, '9811533636')).toBe('+91 9811533636');
  });
});
