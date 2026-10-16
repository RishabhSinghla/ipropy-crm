/**
 * What Sarvam posts when an AI call ends, and the lock on the address it posts to.
 * Sarvam signs nothing, so the secret in the URL is the only thing keeping a
 * stranger from writing fake calls into the timeline.
 */
import { describe, expect, it } from 'vitest';
import { parseSarvamResult, sarvamWebhookUrl, secretMatches } from '../src/integrations/voiceagent/sarvam.js';

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
