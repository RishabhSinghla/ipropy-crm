import { describe, expect, it } from 'vitest';
import { customerWords, dispositionFor, isDoNotDisturbFailure, readSarvamOutcome, ruleSummary } from '../src/integrations/voiceagent/outcome.js';
import { parseSarvamResult } from '../src/integrations/voiceagent/sarvam.js';
import { appsOf, resultFromAttempt, transcriptOf } from '../src/integrations/voiceagent/reconcile.js';

// The CRM's own call dispositions on production, 20 October 2026.
const OPTIONS = ['Busy/Ringing', 'Call Back Request', 'Call Connected', 'Invalid/Wrong Num', 'Not Interested', 'Not Reachable', 'Out Of Service', 'Switch Off'];
const read = (transcript: string | null, durationSeconds = 40) => readSarvamOutcome({ status: 'completed', transcript, durationSeconds });

describe('what an AI call was, from what the customer said', () => {
  it('a pick-up with silence is not a conversation', () => {
    expect(read('AI agent: Hello, I am Riya from iProperty, am I speaking with Mr. Lalit Maggo?', 5)).toMatchObject({ kind: 'silent', spoke: false });
    expect(read(null, 3)).toMatchObject({ kind: 'silent' });
  });

  it('voicemail is told apart from a person', () => {
    expect(read('AI agent: Hello, am I speaking with Mr. Hemant Khanna?\nCustomer: Please record your message.', 8)).toMatchObject({ kind: 'voicemail', spoke: false });
  });

  it('reads the real calls: a buyer who already bought, a wrong person, a refusal, a call back', () => {
    expect(read('AI agent: Hello?\nCustomer: Yes, please tell me.\nAI agent: Are you looking for a Three BHK?\nCustomer: I have already bought one.')).toMatchObject({ kind: 'already_bought' });
    expect(read('AI agent: Hello, Mr. Sharma?\nCustomer: Wrong number.')).toMatchObject({ kind: 'wrong_number' });
    expect(read('AI agent: Do you have a minute?\nCustomer: I am not interested.')).toMatchObject({ kind: 'not_interested' });
    expect(read('AI agent: Do you have a minute?\nCustomer: I am busy right now, call me tomorrow.')).toMatchObject({ kind: 'callback' });
  });

  it('a request to stop is honoured as one, and a plain refusal is not mistaken for it', () => {
    expect(read('AI agent: Hello?\nCustomer: Please do not call me again.')).toMatchObject({ kind: 'stop_calling', stopCalling: true });
    expect(read('AI agent: Hello?\nCustomer: Stop calling me, remove my number.')).toMatchObject({ stopCalling: true });
    expect(read('AI agent: Hello?\nCustomer: Not interested.').stopCalling).toBe(false);
  });

  it('a long exchange that mentions a callback word is still a conversation', () => {
    const talk = ['AI agent: Which BHK?', 'Customer: Three BHK.', 'AI agent: Budget?', 'Customer: Around two crore, call me tomorrow with the options.', 'AI agent: Area?', 'Customer: Greenfields.', 'AI agent: Sure.', 'Customer: Okay thanks.'].join('\n');
    expect(read(talk, 200)).toMatchObject({ kind: 'conversation', spoke: true });
  });

  it('only the customer decides: the agent saying "not interested" or "call back" changes nothing', () => {
    expect(customerWords('AI agent: Are you not interested?\nCustomer: Tell me more.')).toBe('Tell me more.');
    expect(read('AI agent: I will call you back tomorrow.\nCustomer: Okay, go ahead.\nCustomer: Yes.')).toMatchObject({ kind: 'conversation' });
  });

  it('answers nothing for a call nobody picked up', () => {
    expect(readSarvamOutcome({ status: 'busy', transcript: null, durationSeconds: 0 })).toBeNull();
    expect(readSarvamOutcome({ status: 'no_answer', transcript: null, durationSeconds: 0 })).toBeNull();
  });
});

describe('naming it in the CRM\'s own dropdown', () => {
  it('finds the option the admin has, and never invents one', () => {
    expect(dispositionFor('callback', OPTIONS)).toBe('Call Back Request');
    expect(dispositionFor('wrong_number', OPTIONS)).toBe('Invalid/Wrong Num');
    expect(dispositionFor('not_interested', OPTIONS)).toBe('Not Interested');
    expect(dispositionFor('silent', OPTIONS)).toBe('Not Reachable');
    expect(dispositionFor('conversation', OPTIONS)).toBe('Call Connected');
    expect(dispositionFor('stop_calling', ['Call Connected'])).toBeNull();
    expect(dispositionFor('callback', [])).toBeNull();
  });

  it('writes a summary a rep can read at a glance without a model', () => {
    const outcome = read('AI agent: Hi\nCustomer: I am not interested.\nCustomer: Thanks.', 42)!;
    expect(ruleSummary(outcome, { transcript: 'AI agent: Hi\nCustomer: I am not interested.', durationSeconds: 42 })).toBe('AI call, 42s. Not interested. Customer: I am not interested.');
  });
});

describe('the network says so', () => {
  it('recognises a do-not-disturb refusal from the telephone provider', () => {
    expect(isDoNotDisturbFailure('exotel: Phone number is registered under TRAI NDNC')).toBe(true);
    expect(isDoNotDisturbFailure('exotel: invalid number')).toBe(false);
    expect(isDoNotDisturbFailure(null)).toBe(false);
  });
});

describe('reading what Sarvam sends and what its analytics return', () => {
  it('keeps the conversation id from the finished-call webhook', () => {
    const result = parseSarvamResult({ attempt_id: 'a1', status: 'connected', duration: 16.8, interaction_id: '20260920/abc', interaction_transcript: [{ role: 'agent', en_text: 'Hello' }, { role: 'user', en_text: 'Hi' }], final_agent_variables: { x: 1 } });
    expect(result).toMatchObject({ attemptId: 'a1', interactionId: '20260920/abc', durationSeconds: 17 });
    expect(parseSarvamResult({ attempt_id: 'a2', status: 'no_answer', interaction_id: null })?.interactionId).toBeNull();
  });

  it('turns an attempt and its conversation into the result a webhook would have delivered', () => {
    const interaction = { interaction_id: '20261020/z', translate_transcript: [{ role: 'agent', text: 'Hello' }, { role: 'user', text: 'Call me later' }], agent_variables: { budget: '2 cr' } };
    expect(transcriptOf(interaction)).toBe('AI agent: Hello\nCustomer: Call me later');
    const connected = resultFromAttempt({ attempt_id: 'a1', interaction_id: '20261020/z', connectivity_status: 'connected', duration_in_seconds: 95.4, failure_reason: 'NO_FAILURE_REASON' }, interaction)!;
    expect(connected).toMatchObject({ status: 'connected', durationSeconds: 95, failureReason: null, interactionId: '20261020/z', finalAgentVariables: { budget: '2 cr' } });
    const failed = resultFromAttempt({ attempt_id: 'a2', connectivity_status: 'failed', failure_reason: 'exotel: Phone number is registered under TRAI NDNC' }, undefined)!;
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'exotel: Phone number is registered under TRAI NDNC', transcript: null });
    expect(resultFromAttempt({ attempt_id: 'a3', connectivity_status: 'busy' }, undefined)?.status).toBe('busy');
    expect(resultFromAttempt({ connectivity_status: 'connected' }, undefined)).toBeNull();
    // Sarvam's placeholder for an attempt that never became a conversation is not an id.
    expect(resultFromAttempt({ attempt_id: 'a4', interaction_id: 'NO_INTERACTION_ID', connectivity_status: 'busy' }, undefined)).toMatchObject({ status: 'busy', interactionId: null });
    expect(parseSarvamResult({ attempt_id: 'a5', status: 'failed', interaction_id: 'NO_INTERACTION_ID' })?.interactionId).toBeNull();
  });

  it('finds the agents the CRM calls through, once each', () => {
    const settings = { appId: 'default-app', agentsByModule: { leads: { appId: 'buyer-app', appVersion: 13 }, properties: { appId: 'seller-app', appVersion: 6 } } } as never;
    expect(appsOf(settings)).toEqual([{ appId: 'buyer-app', module: 'leads' }, { appId: 'seller-app', module: 'properties' }, { appId: 'default-app', module: null }]);
  });
});
