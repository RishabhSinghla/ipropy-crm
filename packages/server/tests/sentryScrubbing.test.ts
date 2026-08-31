/**
 * What an error report is allowed to carry out of the building.
 *
 * Error reporting sends a copy of a failure to a company in another country.
 * In a CRM, a failure is usually *about* a person: their name is in the request
 * body, their number is in the message, their email is in the query string. Sent
 * unfiltered, a debugging tool becomes an export of customer data that nobody
 * decided to make.
 *
 * So the rule is that Sentry may know **what** broke and **where**, and never
 * **who for**. These tests are the enforcement of that rule, and they matter
 * more than the reporting itself: reporting that leaks is worse than no
 * reporting, because it looks responsible.
 */
import { describe, expect, it } from 'vitest';
import { __testing } from '../src/core/observability/sentry.js';

const { scrub, beforeSend } = __testing;

describe('what gets stripped before an error is sent', () => {
  it.each([
    ['a mobile with a country code', '+91 98115 33633'],
    ['a mobile without one', '9811533633'],
    ['a mobile with hyphens', '98115-33633'],
    ['an email', 'buyer@example.com'],
  ])('removes %s', (_what, value) => {
    const out = scrub(`Failed to update lead ${value} on save`) as string;
    expect(out).not.toContain(value.replace(/\s/g, ''));
    expect(out).toContain('[redacted]');
    // The useful half survives — this is a filter, not a delete.
    expect(out).toContain('Failed to update lead');
  });

  it.each([
    'password', 'apiKey', 'accessToken', 'authorization',
    'sessionId', 'refreshToken', 'aadhaar_number', 'pan', 'cvv', 'otp',
  ])('redacts anything under a key called %s', (key) => {
    const out = scrub({ [key]: 'the actual value' }) as Record<string, unknown>;
    expect(out[key]).toBe('[redacted]');
  });

  it('reaches into nested objects and arrays', () => {
    // A request body is not flat. A lead arrives wrapped in a values object,
    // inside a list, inside an envelope.
    const out = scrub({
      records: [{ values: { full_name: 'Aftab Siddiqui', mobile: '+91 97177 94439' } }],
    }) as { records: { values: { full_name: string; mobile: string } }[] };

    expect(out.records[0]!.values.mobile).toBe('[redacted]');
    // A name is not machine-detectable and survives, which is exactly why the
    // request body is never attached in the first place — see sendDefaultPii.
    expect(out.records[0]!.values.full_name).toBe('Aftab Siddiqui');
  });

  it('does not recurse forever on a self-referencing object', () => {
    // An Express request has circular references all through it. A scrubber
    // that hangs on one takes the error handler down with it.
    const loop: Record<string, unknown> = { name: 'x' };
    loop.self = loop;
    expect(() => scrub(loop)).not.toThrow();
  });

  it('leaves alone what is actually useful', () => {
    const out = scrub({ path: '/api/records/leads/search', status: 500, requestId: 'a1b2c3d4' }) as Record<string, unknown>;
    expect(out.path).toBe('/api/records/leads/search');
    expect(out.status).toBe(500);
    expect(out.requestId).toBe('a1b2c3d4');
  });
});

describe('the event on its way out', () => {
  it('drops cookies and the query string entirely', () => {
    /*
      A CRM query string is a search box, and a search box is full of the names
      of people somebody was looking for. There is no version of it worth
      keeping, so it is removed rather than filtered.
    */
    const event = beforeSend({
      request: {
        url: 'https://crm.example.com/leads',
        query_string: 'q=Aftab+Siddiqui&mobile=9811533633',
        cookies: { 'ipropy.token': 'a-real-session' },
        headers: { authorization: 'Bearer real-token', 'user-agent': 'Chrome' },
      },
    } as never, {} as never);

    expect(event?.request?.query_string).toBe('[redacted]');
    expect(event?.request?.cookies).toBeUndefined();
    expect((event?.request?.headers as Record<string, string>).authorization).toBe('[redacted]');
    // The user agent is genuinely useful for reproducing a bug.
    expect((event?.request?.headers as Record<string, string>)['user-agent']).toBe('Chrome');
  });

  it('keeps who it happened to, and no way to contact them', () => {
    // Knowing two crashes hit the same person is how you spot a pattern.
    // Knowing their email is how you accidentally export a customer list.
    const event = beforeSend({
      user: { id: 'user-123', email: 'priya@ipropy.com', ip_address: '49.36.1.1', username: 'priya' },
    } as never, {} as never);

    expect(event?.user).toEqual({ id: 'user-123' });
  });

  it('redacts a number that ended up in the error message itself', () => {
    const event = beforeSend({
      message: 'Duplicate lead for +91 98115 33633',
    } as never, {} as never);

    expect(event?.message).toContain('[redacted]');
    expect(event?.message).not.toContain('98115');
  });

  it('sends nothing at all rather than something unfiltered', () => {
    /*
      The failure mode that matters. If the filter itself breaks, the safe
      answer is to lose the error report — never to let an unscrubbed event
      through because the scrubber threw.
    */
    const hostile = { get request() { throw new Error('boom'); } };
    expect(beforeSend(hostile as never, {} as never)).toBeNull();
  });
});
