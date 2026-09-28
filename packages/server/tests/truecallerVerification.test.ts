/**
 * The two decisions that keep Truecaller verification honest.
 *
 * Truecaller's callback carries no signature, so the endpoint check is the one
 * line standing between this CRM and handing an access token to whoever asked.
 * It is pure and tested here rather than buried in the route, because a reader
 * has to be able to point at the line that keeps the CRM safe.
 */
import { describe, expect, it } from 'vitest';
import { isTruecallerEndpoint, nameAndPhoneFrom } from '../src/integrations/leadsources/truecaller.js';

describe('only Truecaller may be handed the access token', () => {
  it('accepts their own hosts', () => {
    expect(isTruecallerEndpoint('https://profile4-noneu.truecaller.com/v1/default')).toBe(true);
    expect(isTruecallerEndpoint('https://truecaller.com/v1/default')).toBe(true);
  });

  it('refuses anybody else', () => {
    expect(isTruecallerEndpoint('https://evil.example.com/v1/default')).toBe(false);
    expect(isTruecallerEndpoint('https://api.example.com/truecaller.com/v1')).toBe(false);
  });

  it('refuses a host that merely ends in the same letters', () => {
    // `nottruecaller.com` ends with "truecaller.com" as a string but is a
    // different company. The check is on the dot, not on the substring.
    expect(isTruecallerEndpoint('https://nottruecaller.com/v1/default')).toBe(false);
  });

  it('refuses plain http, which would put the token on the wire', () => {
    expect(isTruecallerEndpoint('http://profile4-noneu.truecaller.com/v1/default')).toBe(false);
  });

  it('refuses something that is not a URL at all', () => {
    expect(isTruecallerEndpoint('not a url')).toBe(false);
    expect(isTruecallerEndpoint('')).toBe(false);
  });
});

describe('reading a profile whose field names we could not look up', () => {
  it('reads the shape their own samples show', () => {
    expect(nameAndPhoneFrom({
      name: { first: 'Riya', last: 'Sharma' },
      phoneNumbers: [919812345678],
    })).toEqual({ name: 'Riya Sharma', phone: '919812345678' });
  });

  it('takes a plain name string too', () => {
    expect(nameAndPhoneFrom({ name: 'Riya Sharma', phoneNumbers: ['+91 98123 45678'] }))
      .toEqual({ name: 'Riya Sharma', phone: '919812345678' });
  });

  it('answers null rather than inventing anything', () => {
    expect(nameAndPhoneFrom({})).toEqual({ name: null, phone: null });
    expect(nameAndPhoneFrom(null)).toEqual({ name: null, phone: null });
    expect(nameAndPhoneFrom({ name: { first: '  ' }, phoneNumbers: [] }))
      .toEqual({ name: null, phone: null });
  });

  it('keeps a first name when there is no last one', () => {
    expect(nameAndPhoneFrom({ name: { first: 'Riya' }, phoneNumbers: [919812345678] }).name)
      .toBe('Riya');
  });
});
