import { describe, expect, it } from 'vitest';
import { blockedReason, callablePhoneOf, istInstant, istParts, judgeHistory, type Schedule } from '../src/integrations/voiceagent/autoCalls.js';
import { sarvamPolicySchema } from '../src/integrations/voiceagent/policy.js';

const rule = { restDays: 30, maxAttempts: 3, retryHours: 18 };
const asOf = istInstant('2026-11-14', '10:30');
const hoursAgo = (h: number): Date => new Date(asOf.getTime() - h * 3_600_000);
const daysAgo = (d: number): Date => hoursAgo(d * 24);

describe('who the AI may call again (judgeHistory)', () => {
  it('lets a never-called record through', () => expect(judgeHistory([], rule, asOf)).toBeNull());

  it('rests a person after a real conversation, then lets them back in', () => {
    expect(judgeHistory([{ at: daysAgo(5), status: 'answered' }], rule, asOf)).toBe('resting');
    expect(judgeHistory([{ at: daysAgo(31), status: 'answered' }], rule, asOf)).toBeNull();
    expect(judgeHistory([{ at: daysAgo(5), status: 'not_interested' }], rule, asOf)).toBe('resting');
  });

  it('a callback request is not a conversation to rest after; its follow-up date decides', () => {
    expect(judgeHistory([{ at: daysAgo(1), status: 'callback' }], rule, asOf)).toBeNull();
  });

  it('retries a no-answer only after the gap, and never twice in one day', () => {
    expect(judgeHistory([{ at: hoursAgo(5), status: 'no_answer' }], rule, asOf)).toBe('called_today');
    expect(judgeHistory([{ at: hoursAgo(20), status: 'no_answer' }], rule, asOf)).toBeNull();
    expect(judgeHistory([{ at: hoursAgo(30), status: 'busy' }], { ...rule, retryHours: 48 }, asOf)).toBe('retry_not_due');
  });

  it('stops after the maximum number of tries, for the rest period', () => {
    const tries = [daysAgo(1), daysAgo(2), daysAgo(3)].map((at) => ({ at, status: 'no_answer' }));
    expect(judgeHistory(tries, rule, asOf)).toBe('max_attempts');
    expect(judgeHistory(tries, { ...rule, maxAttempts: 4 }, asOf)).toBeNull();
  });

  it('tries before a real conversation do not count against the new cycle', () => {
    const calls = [{ at: daysAgo(40), status: 'answered' }, { at: daysAgo(41), status: 'no_answer' }, { at: daysAgo(42), status: 'no_answer' }, { at: daysAgo(43), status: 'no_answer' }];
    expect(judgeHistory(calls, rule, asOf)).toBeNull();
  });

  it('never calls a wrong number or a do-not-call again', () => {
    expect(judgeHistory([{ at: daysAgo(200), status: 'wrong_number' }], rule, asOf)).toBe('wrong_number');
    expect(judgeHistory([{ at: daysAgo(200), status: 'do_not_call' }], rule, asOf)).toBe('do_not_call');
  });
});

describe('India time', () => {
  it('reads the India date, time and weekday whatever the server timezone is', () => {
    expect(istParts(new Date('2026-11-13T19:00:00Z'))).toEqual({ date: '2026-11-14', time: '00:30', weekday: 6 });
    expect(istInstant('2026-11-14', '10:30').toISOString()).toBe('2026-11-14T05:00:00.000Z');
  });
});

describe('phone choice', () => {
  const fields = [
    { name: 'alternate_phone', uitype: 'phone', isActive: true },
    { name: 'mobile', uitype: 'phone', isActive: true },
    { name: 'old_phone', uitype: 'phone', isActive: false },
  ];
  it('prefers the main mobile and normalises it', () => {
    expect(callablePhoneOf(fields, { mobile: '98912 22206', alternate_phone: '9000000001' })).toBe('+919891222206');
  });
  it('falls back, and returns null when nothing usable', () => {
    expect(callablePhoneOf(fields, { mobile: '', alternate_phone: '9000000001' })).toBe('+919000000001');
    expect(callablePhoneOf(fields, { old_phone: '9000000001' })).toBeNull();
  });
});

describe('why it is not running', () => {
  const policy = sarvamPolicySchema.parse({ callStart: '10:00', callEnd: '19:00' });
  const base: Schedule = { module: 'leads', enabled: true, startTime: '10:30', days: [1, 2, 3, 4, 5, 6], dailyCap: 50, viewId: 'v', restDays: 30, maxAttempts: 3, retryHours: 18, ownerUserId: 'u' };
  const on = { ...base, module: '_master' };
  const saturday11 = new Date('2026-11-14T05:40:00Z'); // 11:10 Saturday, India
  it('is OFF by default: the master switch off blocks everything', () => {
    expect(blockedReason(base, { ...on, enabled: false }, saturday11, policy)).toMatch(/master switch/);
    expect(blockedReason(base, undefined, saturday11, policy)).toMatch(/master switch/);
  });
  it('says each reason in words', () => {
    expect(blockedReason({ ...base, enabled: false }, on, saturday11, policy)).toMatch(/module/);
    expect(blockedReason({ ...base, viewId: null }, on, saturday11, policy)).toMatch(/saved view/);
    expect(blockedReason({ ...base, days: [1] }, on, saturday11, policy)).toMatch(/chosen days/);
    expect(blockedReason(base, on, new Date('2026-11-14T04:00:00Z'), policy)).toMatch(/start time/);
    expect(blockedReason({ ...base, startTime: '08:00' }, on, new Date('2026-11-14T04:00:00Z'), policy)).toMatch(/calling hours/);
    expect(blockedReason(base, on, saturday11, policy)).toBeNull();
  });
});
