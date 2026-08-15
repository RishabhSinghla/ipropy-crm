import { describe, expect, it } from 'vitest';
import { evaluateFilter } from '@ipropy/shared';

/**
 * The two filter engines have to agree about what day it is.
 *
 * `core/query/builder.ts` turns a filter into SQL and has always used
 * `AT TIME ZONE <organisation zone>`. `@ipropy/shared`'s evaluator ran the same
 * grammar in memory using the *process* timezone — Asia/Kolkata on a
 * developer's Mac, UTC in any container that does not set TZ, which is every
 * container here. So the same condition on the same record answered differently
 * depending on where it ran, for the five and a half hours a day the two dates
 * differ.
 *
 * The window is 00:00–05:30 in Mumbai, which is exactly when overnight
 * enquiries arrive.
 */
const IST = 'Asia/Kolkata';

/** 02:00 on 16 August in Mumbai — still the 15th in UTC. */
const EARLY_MORNING_IST = '2026-08-16T20:30:00+05:30';

function matches(operator: string, value: string, timezone?: string, now?: Date): boolean {
  // The evaluator reads "now" from the clock, so these assertions are written
  // against a value whose *relative* position to today is what is being tested.
  return evaluateFilter(
    { logic: 'AND', conditions: [{ field: 'when', operator: operator as never }] },
    { when: value },
    timezone ? { timezone } : {},
  );
}

describe('the in-memory filter engine uses the organisation day', () => {
  it('agrees with itself whatever timezone the server happens to run in', () => {
    // A moment fixed to a wall clock in Mumbai must be classified the same way
    // regardless of the process zone — that is the whole invariant.
    const instant = new Date('2026-08-15T20:30:00Z'); // 02:00 on the 16th, IST
    const asDay = instant.toLocaleDateString('en-CA', { timeZone: IST });
    expect(asDay).toBe('2026-08-16');

    // The same instant read in UTC is the previous day. Before the fix, that
    // difference leaked into every `today` / `this_month` condition.
    expect(instant.toLocaleDateString('en-CA', { timeZone: 'UTC' })).toBe('2026-08-15');
  });

  it('treats a record created just after midnight in Mumbai as today', () => {
    const nowIst = new Date().toLocaleDateString('en-CA', { timeZone: IST });
    // 00:30 today, in Mumbai — 19:00 yesterday in UTC.
    const justAfterMidnight = new Date(`${nowIst}T00:30:00+05:30`).toISOString();

    expect(matches('today', justAfterMidnight, IST)).toBe(true);
  });

  it('does not count late last night in Mumbai as today', () => {
    const nowIst = new Date().toLocaleDateString('en-CA', { timeZone: IST });
    const yesterday = new Date(`${nowIst}T00:00:00+05:30`);
    yesterday.setUTCHours(yesterday.getUTCHours() - 2); // 22:00 the previous IST day

    expect(matches('today', yesterday.toISOString(), IST)).toBe(false);
    expect(matches('yesterday', yesterday.toISOString(), IST)).toBe(true);
  });

  it('still works with no timezone given, for the browser', () => {
    // In a browser the process zone *is* the user's zone, so the old behaviour
    // is correct there and must not regress.
    const now = new Date().toISOString();
    expect(matches('today', now)).toBe(true);
  });

  it('survives a timezone it does not recognise rather than throwing', () => {
    // A bad org setting must not take every workflow condition down with it.
    expect(() => matches('today', new Date().toISOString(), 'Not/AZone')).not.toThrow();
  });
});
