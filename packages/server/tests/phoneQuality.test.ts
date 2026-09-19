/**
 * The phone audit is only worth reading if its classifier is right.
 *
 * It produces a count the owner will act on — "empty these" — so a rule that
 * is slightly wrong empties a real customer's number or leaves a junk one
 * behind, and a count nobody can check is worse than no count. Seeded demo
 * data is entirely clean mobiles, so running the script proves the plumbing
 * and nothing about the judgement. This is where the judgement is proved.
 *
 * Every example below is a real shape this CRM either holds or has held:
 * Vtiger imports that kept `+91`, lead-source rows that wrote full E.164,
 * Indian STD-coded landlines, and the several ways somebody gets past a
 * mandatory field.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs helper shared with scripts/, no types needed.
import { classify, mask, national } from '../../../scripts/lib/phoneQuality.mjs';

const bucket = (v: string): string => classify(v) as string;

describe('what counts as a proper Indian mobile', () => {
  it('accepts the four mobile series, ten digits each', () => {
    for (const n of ['9822013456', '8123456780', '7012345698', '6291234567']) {
      expect(bucket(n)).toBe('mobile');
    }
  });

  it('accepts a good number however it was typed or imported', () => {
    /*
      The trap this exists for: `country_code` is a separate field, so a
      number carrying +91 is untidy rather than unusable. Counting those as
      "too long" would have reported thousands of perfectly reachable people
      as junk, which is the wrong answer in the expensive direction.
    */
    for (const n of ['+91 98220 13456', '919822013456', '+91-98220-13456',
      '98220 13456', '(+91) 9822013456']) {
      expect(bucket(n), n).toBe('mobile');
    }
  });

  it('calls an STD-coded landline a landline, not junk', () => {
    // Pune, Delhi, Mumbai — the leading 0 makes them 11, and what follows
    // starts 1-5, which no mobile series does.
    for (const n of ['02026133444', '01123456789', '02223456789']) {
      expect(bucket(n), n).toBe('landline');
    }
  });

  it('calls a ten-digit number in no mobile series a landline', () => {
    for (const n of ['2026133444', '4412345678', '1123456789']) {
      expect(bucket(n), n).toBe('landline');
    }
  });

  /*
    The one place this refuses to answer, and it must stay refusing. Bangalore
    is 080 and Ahmedabad is 079; drop the trunk 0 and both read as a ten-digit
    number starting 8 or 7, which is exactly a mobile. Calling those mobiles
    would hide real landlines, and calling them landlines would empty real
    mobiles. Neither is worth guessing at, so they are counted on their own.
  */
  /*
    Found by reading production's own samples rather than by imagining a case:
    `98100321234` and `989931234` were both being reported as landlines. They
    are somebody's mobile with a digit added or dropped, and the answer to a
    typo is to correct it, not to empty it — so they are counted apart.
  */
  it('separates a mistyped mobile from a landline', () => {
    for (const n of ['98100321234', '989931234', '82201345']) {
      expect(bucket(n), n).toBe('wrong_length_mobile');
    }
    // Same wrong lengths, but in no mobile series: still a landline.
    for (const n of ['26861234', '112681234', '20267231234']) {
      expect(bucket(n), n).toBe('landline');
    }
  });

  it('refuses to guess on an 0 in front of a 6-9', () => {
    for (const n of ['08023456789', '07926543210', '09822013456']) {
      expect(bucket(n), n).toBe('leading_zero');
    }
  });

  it('catches the ways somebody gets past a mandatory field', () => {
    /*
      9999999999 passes the owner's rule exactly — ten digits, starts with 9 —
      and is plainly not a number. So `obvious_junk` is tested before `mobile`,
      and this is the case that pins that order.
    */
    for (const n of ['9999999999', '8888888888', '0000000000',
      '1234567890', '9876543210', '0123456789']) {
      expect(bucket(n), n).toBe('obvious_junk');
    }
  });

  it('separates too short from too long from not a number at all', () => {
    expect(bucket('12345')).toBe('too_short');
    expect(bucket('987654321098765')).toBe('too_long');
    expect(bucket('N/A')).toBe('no_digits');
    expect(bucket('not given')).toBe('no_digits');
    expect(bucket('   ')).toBe('blank');
    expect(bucket('')).toBe('blank');
  });

  it('strips exactly the prefixes it claims to and nothing else', () => {
    expect(national('+919822013456')).toBe('9822013456');
    // The trunk 0 stays on, so classify can see it is there at all.
    expect(national('09822013456')).toBe('09822013456');
    expect(national('9822013456')).toBe('9822013456');
    // 91 at the start of a ten-digit number is part of the number.
    expect(national('9123456789')).toBe('9123456789');
  });
});

describe('what the report prints', () => {
  it('covers the last four digits, so a log cannot be dialled from', () => {
    expect(mask('02026133444')).toBe('0202613xxxx');
    expect(mask('123')).toBe('xxx');
  });
});
