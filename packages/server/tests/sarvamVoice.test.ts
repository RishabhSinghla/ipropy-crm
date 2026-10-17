/**
 * What Sarvam posts when an AI call ends, and the lock on the address it posts to.
 * Sarvam signs nothing, so the secret in the URL is the only thing keeping a
 * stranger from writing fake calls into the timeline.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseSarvamResult, sarvamDispositionValue, sarvamFirstName,
  sarvamVisitSlotValue, sarvamWebhookUrl, secretMatches,
} from '../src/integrations/voiceagent/sarvam.js';

describe('Sarvam call result', () => {
  it('reads a connected call with its transcript', () => {
    const result = parseSarvamResult({
      attempt_id: 'a1', status: 'connected', duration: 61.4,
      interaction_transcript: [
        { role: 'agent', en_text: 'Hello' },
        { role: 'user', en_text: 'Yes, tell me' },
      ],
    });
    expect(result).toMatchObject({ attemptId: 'a1', status: 'connected', durationSeconds: 61 });
    expect(result?.transcript).toBe('AI agent: Hello\nCustomer: Yes, tell me');
  });

  it('reads an unanswered call, where everything else is null', () => {
    const result = parseSarvamResult({
      attempt_id: 'a2', status: 'no_answer', duration: null, interaction_transcript: null,
    });
    expect(result).toMatchObject({ status: 'no_answer', durationSeconds: 0, transcript: null });
  });

  it('refuses a body it does not understand', () => {
    expect(parseSarvamResult({ attempt_id: 'a3', status: 'weird' })).toBeNull();
    expect(parseSarvamResult('nope')).toBeNull();
  });
});

describe('Sarvam webhook address', () => {
  it('puts the secret last and survives a trailing slash', () => {
    expect(sarvamWebhookUrl('https://crm.ipropy.com/', 's3cret'))
      .toBe('https://crm.ipropy.com/api/webhooks/sarvam/s3cret');
  });

  it('matches only the exact secret', () => {
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abd', 'abc')).toBe(false);
    expect(secretMatches('ab', 'abc')).toBe(false);
  });
});

describe('Sarvam visit slot mapping', () => {
  it('converts an explicit tomorrow time to an India CRM datetime', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00.000Z'));
    expect(sarvamVisitSlotValue('Tomorrow at 7 PM', 'datetime')).toBe('2026-10-18T19:00:00+05:30');
    expect(sarvamVisitSlotValue('Tomorrow at 7 PM', 'date')).toBe('2026-10-18');
    vi.useRealTimers();
  });

  it('converts a weekday visit slot to the next matching India date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00.000Z'));
    expect(sarvamVisitSlotValue('Sunday at 10:30 AM', 'datetime')).toBe('2026-10-18T10:30:00+05:30');
    expect(sarvamVisitSlotValue('Sunday at 10:30 AM', 'date')).toBe('2026-10-18');
    vi.useRealTimers();
  });

  it('accepts explicit ISO values and leaves ambiguous phrases unmapped', () => {
    expect(sarvamVisitSlotValue('2026-10-18T19:00:00+05:30', 'datetime')).toBe('2026-10-18T13:30:00.000Z');
    expect(sarvamVisitSlotValue('in the evening', 'datetime')).toBeNull();
  });
});

describe('Sarvam CRM identity and outcomes', () => {
  it('derives a first-name greeting without changing the full CRM name', () => {
    expect(sarvamFirstName('  Rishabh Singhla  ')).toBe('Rishabh');
    expect(sarvamFirstName('')).toBe('');
  });

  it('maps call wording only to an option the CRM currently offers', () => {
    const options = ['Interested', 'Not Interested', 'Call Back Later', 'Site Visit Scheduled', 'Already Purchased', 'Busy', 'Not Reachable'];
    expect(sarvamDispositionValue('not interested', options)).toBe('Not Interested');
    expect(sarvamDispositionValue('no answer', options)).toBe('Not Reachable');
    expect(sarvamDispositionValue('call me back', options)).toBe('Call Back Later');
    expect(sarvamDispositionValue('Already Purchased', options)).toBe('Already Purchased');
    expect(sarvamDispositionValue('made up outcome', options)).toBeNull();
  });
});
