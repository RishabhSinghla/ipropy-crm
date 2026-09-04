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
    /*
      A name is not machine-detectable and survives the scrubber. This test used
      to justify that by saying the request body is never attached — and that was
      false. `sendDefaultPii: false` does not gate body capture; the SDK gates it
      on `maxRequestBodySize !== 'none'`, which defaults to capturing 10 KB. So
      every 5xx was sending the body that caused it, names and all.

      The body is now refused at the source and deleted again in `beforeSend`,
      which is what makes it acceptable that a name gets through here.
    */
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

describe('the three that got through the first version', () => {
  /*
    Found by attacking my own filter rather than by reading it. All three were
    real, and the first was the one that mattered most — it was the likeliest
    path of all and it was completely open.
  */

  it('scrubs the text of a thrown Error, not just a captureMessage', () => {
    /*
      THE hole. `message` is only set when you call captureMessage. An ordinary
      `throw new Error(...)` — which is how this codebase raises nearly
      everything — puts its text in exception.values[].value, and nothing
      touched that. So the single most likely way a customer's number reached
      Sentry was the one path left open.
    */
    const event = beforeSend({
      exception: { values: [{ type: 'Error', value: 'No lead found for +91 98115 33633 (buyer@example.com)' }] },
    } as never, {} as never);

    const out = event?.exception?.values?.[0]?.value ?? '';
    expect(out).not.toContain('98115');
    expect(out).not.toContain('buyer@example.com');
    expect(out, 'the useful half must survive').toContain('No lead found');
  });

  it('scrubs local variables captured from a stack frame', () => {
    // Frame locals are function arguments, which here means record ids, phone
    // numbers and whatever was being searched for.
    const event = beforeSend({
      exception: {
        values: [{
          value: 'boom',
          stacktrace: { frames: [{ filename: 'x.ts', vars: { mobile: '9811533633', recordId: 'ok-to-keep' } }] },
        }],
      },
    } as never, {} as never);

    const vars = event?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars as Record<string, string>;
    expect(vars.mobile).toBe('[redacted]');
    expect(vars.recordId).toBe('ok-to-keep');
  });

  it('reaches data nested deeper than a request body actually nests', () => {
    /*
      The old limit was six levels. A CRM body passes that on its own — envelope,
      records array, record, values, address — and everything below came out
      untouched.
    */
    const deep = { a: { b: { c: { d: { e: { f: { g: { mobile: '+91 98115 33633' } } } } } } } };
    expect(JSON.stringify(scrub(deep))).not.toContain('98115');
  });

  it('strips the query string from the URL as well as from query_string', () => {
    // The same search terms appear twice in an event. The browser half stripped
    // the URL and the server half did not.
    const event = beforeSend({
      request: { url: 'https://crm.example.com/leads?q=buyer@example.com' },
    } as never, {} as never);

    expect(event?.request?.url).toBe('https://crm.example.com/leads');
  });

  it('does not hand back the contents of a Map or a class instance untouched', () => {
    // Object.entries finds nothing on these, so the old version returned the
    // original object and everything inside escaped.
    class Lead { constructor(public mobile = '+91 98115 33633') {} toString() { return `Lead ${this.mobile}`; } }
    expect(JSON.stringify(scrub(new Lead()))).not.toContain('98115');
    expect(JSON.stringify(scrub(new Map([['mobile', '9811533633']])))).not.toContain('9811533633');
  });

  it('drops a repeated object rather than returning it raw', () => {
    // A cycle used to be handled by the depth limit alone; now it is detected,
    // and the detected branch must not be a way back to unscrubbed data.
    const loop: Record<string, unknown> = { mobile: '9811533633' };
    loop.self = loop;
    const out = JSON.stringify(scrub(loop));
    expect(out).not.toContain('9811533633');
    expect(out).toContain('[circular]');
  });
});

describe('it cannot be used to freeze the server', () => {
  it('scans a huge string in constant time', () => {
    /*
      Found by attacking it: scanning cost was quadratic in length. 2,000
      characters took 3ms, 32,000 took 600ms and 64,000 took 2.1 seconds — and
      this runs inside the error handler, on the request path. One large error
      message, a base64 data URI in a failed upload, a long SQL string, and the
      event loop stops for seconds. An error reporter that can freeze the server
      is worse than no error reporter.

      Capped at Sentry's own maxValueLength, so nothing is lost that would have
      survived the far end anyway.
    */
    const huge = 'lead 9811533633 '.repeat(30_000); // ~480 KB

    const started = performance.now();
    const out = scrub(huge) as string;
    const took = performance.now() - started;

    expect(took, `took ${Math.round(took)}ms — this is on the request path`).toBeLessThan(50);
    expect(out.length).toBeLessThan(2_200);
    expect(out).toContain('more characters');
    // Still scrubbed, not merely shortened.
    expect(out).not.toContain('9811533633');
  });

  it('says how much it dropped rather than silently truncating', () => {
    const out = scrub('x'.repeat(5000)) as string;
    expect(out).toContain('3000 more characters');
  });
});

describe('the twelve phone formats that leaked', () => {
  /*
    The first version chased separator arrangements with a single pattern, and
    twelve formats walked straight through it. None of them is exotic — they are
    how numbers arrive from a portal import and from people typing:

      98115.33633    9811 533 633    981 153 3633    98115–33633
      98115/33633    98115_33633     98115,33633     98115  33633
      ०-९ digits     0129 2419711 (a Faridabad landline)

    Chasing punctuation was the wrong shape of solution. It finds any run of
    digits long enough to be a number now, strips the punctuation, and decides on
    the digits — which is a far smaller thing to get right.
  */
  it.each([
    ['a dot between halves', '98115.33633'],
    ['four-three-three spacing', '9811 533 633'],
    ['four-six spacing', '9811 533633'],
    ['three-three-four spacing', '981 153 3633'],
    ['Devanagari digits', '९८११५३३६३३'],
    ['a double space', '98115  33633'],
    ['an en dash', '98115–33633'],
    ['a slash', '98115/33633'],
    ['an underscore', '98115_33633'],
    ['a comma', '98115,33633'],
    ['a Faridabad landline', '0129 2419711'],
    ['a landline without its zero', '129 2419711'],
    ['brackets round the country code', '(+91) 9811533633'],
    ['a leading zero', '098115 33633'],
  ])('redacts a number written with %s', (_shape, number) => {
    const out = scrub(`Lead update failed for ${number} on save`) as string;
    expect(out).not.toContain(number);
    expect(out).toContain('[redacted]');
    expect(out, 'the useful half survives').toContain('Lead update failed');
  });

  it.each([
    ['a record id', '4e3cf93f-1b72-429c-949e-3e5e068df2b9'],
    ['a route', '/api/records/leads/search'],
    ['a status and a retry count', 'failed with status 500 after 3 retries'],
    ['a budget range', 'budget 12500000 to 18000000'],
  ])('leaves %s alone, because a bug report needs it', (_what, value) => {
    /*
      The other half of the trade. Over-redacting is cheap and under-redacting
      publishes a customer's number, so uncertain cases resolve towards
      redacting — but not so far that the report stops being useful.
    */
    expect(scrub(`context ${value} here`) as string).toContain(value);
  });

  it('catches an email with an apostrophe or a plus in it', () => {
    for (const address of ["o'brien@example.com", 'buyer+site@example.co.in', 'a.b@sub.domain.org']) {
      expect(scrub(`mail to ${address} bounced`) as string).not.toContain(address);
    }
  });
});

describe('where the filter deliberately stops', () => {
  it.each([
    ['a pipe', '98115|33633'],
    ['a zero-width space', '98115\u200B33633'],
    ['a star', '98115*33633'],
    ['a colon', '98115:33633'],
  ])('catches a number split by %s', (_sep, number) => {
    /*
      The zero-width one is the reason this class matters. It is invisible: it
      survives a copy and paste out of a browser or a PDF, nobody can see it in
      the note afterwards, and it defeated the whole filter. Characters with no
      width are stripped before anything is scanned now, because a character
      nobody can see should never change what a pattern matches.
    */
    expect(scrub(`note ${number} end`) as string).not.toContain(number);
  });

  it.each([
    ['an x between the halves', '98115x33633'],
    ['a word between the halves', '98115 se 33633'],
  ])('deliberately does not catch %s', (_shape, number) => {
    /*
      Left through on purpose, and worth stating so nobody "fixes" it. Treating
      a letter as a separator would redact `order 12345x67890 dimensions`, and
      treating a word as one would redact most sentences containing two numbers.
      The cost of that is a bug report with nothing useful left in it.

      This is a filter, not a proof. The guarantee that actually holds is
      further back: `sendDefaultPii: false`, no request body attached, and the
      query string dropped whole. This layer catches what still slips into a
      message, and it catches every form anybody writes on purpose.
    */
    expect(scrub(`note ${number} end`) as string).toContain(number);
  });
});

describe('the request body, which was going out whole', () => {
  it('is deleted, not scrubbed', () => {
    /*
      The most serious thing the adversarial pass found, and it invalidated a
      comment in the source: `sendDefaultPii: false` does NOT stop the request
      body being captured. The SDK gates that on `maxRequestBodySize !== 'none'`
      (@sentry/core/integrations/http/server-subscription.js:56), which defaults
      to 10 KB.

      In this application the body of a failing request is a lead — name, number,
      budget. The scrubber caught the number; the name went out whole.

      Deleted rather than filtered, because a filter can only catch what has a
      shape and a name has none.
    */
    const event = beforeSend({
      request: {
        url: 'https://crm.example.com/api/records/leads',
        data: { full_name: 'Aftab Siddiqui', mobile: '9811533633', budget: 18000000 },
      },
    } as never, {} as never);

    expect(event?.request?.data, 'the body must not be sent at all').toBeUndefined();
    // The half worth keeping survives.
    expect(event?.request?.url).toBe('https://crm.example.com/api/records/leads');
  });

  it('refuses the body at the SDK as well as on the way out', async () => {
    // Belt and braces on purpose: one of these is an SDK default that could
    // change under us, and the other cannot.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/core/observability/sentry.ts', import.meta.url), 'utf8');

    expect(source).toContain("maxIncomingRequestBodySize: 'none'");
    expect(source).toContain('delete event.request.data');
  });

  it('scrubs a URL path, not only a query string', () => {
    // The absolute-URL branch of safeUrl returned the path untouched while the
    // relative branch scrubbed it, so an address in a path survived by accident.
    const event = beforeSend({
      request: { url: 'https://crm.example.com/share/buyer@example.com/photos' },
    } as never, {} as never);

    expect(event?.request?.url).not.toContain('buyer@example.com');
  });

  it('catches an email that a browser percent-encoded', () => {
    // What encodeURIComponent produces, and therefore the normal form of an
    // address inside a logged URL or a fetch error.
    const out = scrub('GET /leads?q=buyer%40example.com failed') as string;
    expect(out).not.toContain('buyer%40example.com');
    expect(out).not.toContain('buyer@example.com');
  });
});
