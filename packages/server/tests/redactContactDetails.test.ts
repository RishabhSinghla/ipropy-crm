/**
 * One redaction, used by both halves of the CRM.
 *
 * This was written twice — once for the server's error reports, once for the
 * browser's — and the two drifted immediately. Twelve phone formats were fixed
 * on the server and stayed broken in the browser, which is the worse half: a
 * crash in the browser carries whatever was on the screen, and what is on the
 * screen in a CRM is a person.
 *
 * It lives in `@ipropy/shared` now so there is one implementation to get right.
 * This suite aliases that to source, so these tests cover what both halves
 * actually run.
 */
import { describe, expect, it } from 'vitest';
import { redactContactDetails } from '@ipropy/shared';

describe('every way a phone number gets written', () => {
  it.each([
    ['plain', '9811533633'],
    ['country code, spaced', '+91 98115 33633'],
    ['country code, joined', '+919811533633'],
    ['country code, hyphens', '+91-98115-33633'],
    ['leading zero', '098115 33633'],
    ['91 without a plus', '91 9811533633'],
    ['brackets round the code', '(+91) 9811533633'],
    ['a dot', '98115.33633'],
    ['four-three-three', '9811 533 633'],
    ['four-six', '9811 533633'],
    ['three-three-four', '981 153 3633'],
    ['a double space', '98115  33633'],
    ['an en dash', '98115–33633'],
    ['a slash', '98115/33633'],
    ['an underscore', '98115_33633'],
    ['a comma', '98115,33633'],
    ['a pipe', '98115|33633'],
    ['a star', '98115*33633'],
    ['a colon', '98115:33633'],
    ['Devanagari digits', '९८११५३३६३३'],
    ['a Faridabad landline', '0129 2419711'],
    ['a landline without its zero', '129 2419711'],
  ])('redacts one written with %s', (_shape, number) => {
    const out = redactContactDetails(`Lead update failed for ${number} on save`);
    expect(out).not.toContain(number);
    expect(out, 'the useful half survives').toContain('Lead update failed');
  });

  it('redacts one split by a character nobody can see', () => {
    /*
      A zero-width space survives a copy and paste out of a browser or a PDF,
      nobody can see it in the note afterwards, and it defeated the entire
      filter. Invisible characters are stripped before anything is scanned now,
      because a character with no width should never change what a pattern
      matches.
    */
    const hidden = '98115​33633';
    expect(redactContactDetails(`note ${hidden} end`)).not.toContain(hidden);
  });
});

describe('what it leaves alone, because a bug report needs it', () => {
  it.each([
    ['a record id', '4e3cf93f-1b72-429c-949e-3e5e068df2b9'],
    ['a route', '/api/records/leads/search'],
    ['a status and retry count', 'failed with status 500 after 3 retries'],
    ['a budget range', 'budget 12500000 to 18000000'],
    ['product dimensions', 'order 12345x67890 dimensions'],
  ])('keeps %s', (_what, value) => {
    // Over-redacting is cheap and under-redacting publishes a customer's number,
    // so uncertain cases lean towards redacting — but not so far that the report
    // stops being worth reading.
    expect(redactContactDetails(`context ${value} here`)).toContain(value);
  });
});

describe('emails', () => {
  it.each([
    'buyer@example.com',
    "o'brien@example.com",
    'buyer+site@example.co.in',
    'a.b@sub.domain.org',
  ])('redacts %s', (address) => {
    expect(redactContactDetails(`mail to ${address} bounced`)).not.toContain(address);
  });
});
