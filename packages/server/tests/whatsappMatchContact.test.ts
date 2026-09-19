/**
 * Turning what WhatsApp hands us into something the CRM can look up.
 *
 * Both halves have bitten this codebase before in other forms. A lead's phone is
 * a country code *and* national digits since migration 026, imported rows carry
 * every shape from `9876543210` to `+91 98765-43210`, and WhatsApp says
 * `919876543210@s.whatsapp.net`. If these two functions disagree by one
 * character, every incoming message lands as "unknown number" and the team
 * concludes the matching is broken.
 */
import { describe, expect, it } from 'vitest';
import { handleFromJid, matchKey } from '../src/integrations/whatsapp/matchContact.js';

describe('the number behind a WhatsApp id', () => {
  it('reads a plain contact', () => {
    expect(handleFromJid('919876543210@s.whatsapp.net')).toBe('+919876543210');
  });

  it('drops the device suffix a linked phone adds', () => {
    // A message from a linked device carries `:12` before the @, and leaving it
    // on makes the number twelve digits that match nobody.
    expect(handleFromJid('919876543210:12@s.whatsapp.net')).toBe('+919876543210');
  });

  it('has no answer for a group or a blank', () => {
    expect(handleFromJid(null)).toBeNull();
    expect(handleFromJid(undefined)).toBeNull();
    expect(handleFromJid('@s.whatsapp.net')).toBeNull();
  });
});

describe('the key two numbers are compared on', () => {
  it('is the last ten digits, whatever shape the number is stored in', () => {
    const expected = '9876543210';
    for (const stored of [
      '9876543210',
      '+919876543210',
      '+91 98765-43210',
      '91 9876543210',
      '0091-9876543210',
      '+919876543210@s.whatsapp.net'.split('@')[0]!,
    ]) {
      expect(matchKey(stored), stored).toBe(expected);
    }
  });

  it('refuses anything too short to identify somebody', () => {
    // A five-digit extension matching "the last five digits" of a mobile is how
    // a customer's messages end up on a stranger's record.
    expect(matchKey('12345')).toBeNull();
    expect(matchKey('')).toBeNull();
    expect(matchKey(null)).toBeNull();
    expect(matchKey('not a number')).toBeNull();
  });

  it('agrees with itself across the two directions', () => {
    const fromWhatsApp = handleFromJid('919876543210@s.whatsapp.net');
    expect(matchKey(fromWhatsApp)).toBe(matchKey('+91 98765 43210'));
  });
});
