/**
 * The rules that keep an SMS/RCS campaign from surprising anybody — all of them pure,
 * so each is walked here without a database or a network.
 */
import { describe, expect, it } from 'vitest';
import {
  audienceProblem, audienceVerdict, fillTokens, firstMobile, insidePromotionalHours,
  MOST_WE_WILL_SEND, NEEDS_CONFIRMING, wordingFor,
} from '../src/integrations/msg91/bulk.js';
import { refusal, toMsg91Number, whyItFailed } from '../src/integrations/msg91/client.js';

describe('who a campaign may be sent to', () => {
  it('lets an ordinary one through', () => {
    expect(audienceVerdict({ count: 40, expected: 40 })).toBeNull();
  });
  it('refuses when the audience moved since it was shown', () => {
    expect(audienceVerdict({ count: 341, expected: 340 })).toMatch(/341 people now, not the 340/);
  });
  it('says so when nobody would get it', () => {
    expect(audienceVerdict({ count: 0, expected: 0 })).toMatch(/Nobody/);
  });
  it('asks twice above the confirming line, refuses above the ceiling', () => {
    expect(audienceVerdict({ count: NEEDS_CONFIRMING, expected: NEEDS_CONFIRMING })).toBeNull();
    expect(audienceVerdict({ count: NEEDS_CONFIRMING + 1, expected: NEEDS_CONFIRMING + 1 })).toMatch(/large campaign/);
    expect(audienceVerdict({ count: NEEDS_CONFIRMING + 1, expected: NEEDS_CONFIRMING + 1, confirmLarge: true })).toBeNull();
    expect(audienceVerdict({ count: MOST_WE_WILL_SEND + 1, expected: MOST_WE_WILL_SEND + 1, confirmLarge: true }))
      .toMatch(/more than this CRM will send/);
  });
});

describe('"everyone" has to be said out loud', () => {
  it('refuses an empty audience instead of reading it as everybody', () => {
    expect(audienceProblem({})).toMatch(/not read as everybody/);
    expect(audienceProblem({ filter: undefined })).not.toBeNull();
  });
  it('accepts a saved list or an explicit everyone', () => {
    expect(audienceProblem({ view: 'abc' })).toBeNull();
    expect(audienceProblem({ everyone: true })).toBeNull();
  });
});

describe('promotional hours (9 am – 9 pm India)', () => {
  it('waits at night and sends by day', () => {
    // 03:30 UTC = 09:00 IST, 15:29 UTC = 20:59 IST, 15:30 UTC = 21:00 IST
    expect(insidePromotionalHours(new Date('2026-11-07T03:29:00Z'))).toBe(false);
    expect(insidePromotionalHours(new Date('2026-11-07T03:30:00Z'))).toBe(true);
    expect(insidePromotionalHours(new Date('2026-11-07T15:29:00Z'))).toBe(true);
    expect(insidePromotionalHours(new Date('2026-11-07T15:30:00Z'))).toBe(false);
    expect(insidePromotionalHours(new Date('2026-11-07T21:00:00Z'))).toBe(false);
  });
});

describe('numbers', () => {
  it('turns every Indian mobile shape into 91XXXXXXXXXX', () => {
    expect(toMsg91Number('9876543210')).toBe('919876543210');
    expect(toMsg91Number('+91 98765-43210')).toBe('919876543210');
    expect(toMsg91Number('09876543210')).toBe('919876543210');
    expect(toMsg91Number('+919876543210')).toBe('919876543210');
  });
  it('refuses landlines, short numbers and other countries rather than guessing', () => {
    expect(toMsg91Number('0120 4567890')).toBeNull();
    expect(toMsg91Number('12345')).toBeNull();
    expect(toMsg91Number('+971501234567')).toBeNull();
    expect(toMsg91Number('')).toBeNull();
    expect(toMsg91Number(null)).toBeNull();
  });
  it('takes the first phone field that is a real Indian mobile', () => {
    expect(firstMobile({ mobile: '98765 43210' }, ['mobile'])).toEqual({ handle: '+919876543210' });
    expect(firstMobile({ mobile: '', alt: '9123456789' }, ['mobile', 'alt'])).toEqual({ handle: '+919123456789' });
  });
  it('says why somebody is left out', () => {
    expect(firstMobile({}, ['mobile'])).toEqual({ reason: 'no mobile number on the record' });
    expect(firstMobile({ mobile: '12345' }, ['mobile'])).toEqual({ reason: 'not an Indian mobile number' });
    expect(firstMobile({ mobile: '501234567', country_code: '+971' }, ['mobile'])).toEqual({ reason: 'not an Indian mobile number' });
  });
});

describe('filling in the wording', () => {
  it('fills tokens from the record and from the label', () => {
    expect(fillTokens('Hi {{first_name}}, {{ label }}!', { first_name: 'Anita' }, 'Anita S'))
      .toEqual({ text: 'Hi Anita, Anita S!', missing: [] });
  });
  it('names an empty field rather than sending a hole', () => {
    expect(fillTokens('Hi {{first_name}}', { first_name: '  ' }, 'x')).toEqual({ text: 'Hi ', missing: ['first_name'] });
    expect(fillTokens('Hi {{nope}}', {}, 'x').missing).toEqual(['nope']);
  });
  it('builds the SMS blanks for one person', () => {
    const content = { channel: 'sms' as const, variables: { name: '{{first_name}}', city: 'Noida' } };
    expect(wordingFor(content, { first_name: 'Anita' }, 'A')).toEqual({ payload: { name: 'Anita', city: 'Noida' }, missing: [] });
    expect(wordingFor(content, {}, 'A').missing).toEqual(['first_name']);
  });
  it('builds the RCS text for one person', () => {
    expect(wordingFor({ channel: 'rcs', body: 'Hi {{label}}' }, {}, 'Anita'))
      .toEqual({ payload: { text: 'Hi Anita' }, missing: [] });
  });
});

describe('reading MSG91\'s answers', () => {
  it('treats an HTTP 200 that says error as a refusal', () => {
    expect(refusal({ type: 'error', message: 'Template ID missing' })).toMatch(/Template ID missing/);
    expect(refusal({ status: 'fail', errors: 'IP not whitelisted' })).toMatch(/IP not whitelisted/);
    expect(refusal({ hasError: true, errors: 'bad project' })).toMatch(/bad project/);
  });
  it('does not call a success a refusal', () => {
    expect(refusal({ type: 'success', message: 'abc123' })).toBeNull();
    expect(refusal({ status: 'success', hasError: false })).toBeNull();
    expect(refusal('OK')).toBeNull();
  });
  it('always says something', () => {
    expect(whyItFailed(null, 502)).toBe('MSG91 returned HTTP 502.');
    expect(whyItFailed('Invalid authkey', 401)).toMatch(/Invalid authkey/);
  });
});

describe('the one-number test send', () => {
  it('is refused with a plain reason before anything is called', async () => {
    const { sendTestMessage } = await import('../src/integrations/msg91/bulk.js');
    // No MSG91 card is loaded in a unit test, so the first refusal is the setup one.
    await expect(sendTestMessage({ to: '98765 43210', content: { channel: 'rcs', body: '' } }))
      .rejects.toThrow(/Write the RCS message first/);
    await expect(sendTestMessage({ to: '98765 43210', content: { channel: 'sms' } }))
      .rejects.toThrow(/No SMS template/);
  });
});
