/**
 * Which messages a customer sends count as "stop messaging me".
 *
 * Only the whole message: "please don't stop calling about the 3 BHK" must
 * never unsubscribe anybody, and a customer who writes STOP must always be.
 */
import { describe, expect, it } from 'vitest';
import { consentKeyword } from '../src/core/consent/index.js';

describe('reading STOP and START', () => {
  it('reads the words WhatsApp vendors honour, in any case', () => {
    expect(consentKeyword('STOP')).toBe('opt_out');
    expect(consentKeyword(' stop ')).toBe('opt_out');
    expect(consentKeyword('Stop.')).toBe('opt_out');
    expect(consentKeyword('Unsubscribe')).toBe('opt_out');
    expect(consentKeyword('START')).toBe('opt_in');
    expect(consentKeyword('subscribe')).toBe('opt_in');
  });

  it('never reads a sentence that merely contains the word', () => {
    expect(consentKeyword("please don't stop calling about the 3 BHK")).toBeNull();
    expect(consentKeyword('stop by the site tomorrow?')).toBeNull();
    expect(consentKeyword('Interested')).toBeNull();
    expect(consentKeyword('')).toBeNull();
    expect(consentKeyword(null)).toBeNull();
  });
});
