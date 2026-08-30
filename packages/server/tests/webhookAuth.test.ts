/**
 * A webhook with no lock on it is not a webhook, it is an API for strangers.
 *
 * Four routes in `webhooks.ts` authenticated nobody: three telephony callbacks
 * and the property-portal lead endpoint. A fifth, Google leads, checked its key
 * only `if (googleAdsWebhookKey && ...)` — so a blank key skipped the check
 * entirely. That last one is the pattern worth naming: a guard that arms itself
 * only once somebody remembers to configure it is a comment, not a guard.
 *
 * The costs were not theoretical. `/telephony/:provider/recording` takes a URL
 * from the request and hands it to `analyseCallRecording`, which downloads it
 * with no host, private-network or size check. `/telephony/:provider/incoming`
 * answered with the agent's own phone number. An invented lead assigns an owner,
 * scores, notifies, and can fire a WhatsApp greeting that costs money.
 *
 * The rule these pin: **unconfigured means refused.**
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

const AUTH_TOKEN = 'twilio-auth-token-fake';
const URL_SIGNED = 'https://ipropy-crm.onrender.com/api/webhooks/telephony/twilio/status';

function twilioSign(url: string, params: Record<string, string>, token: string): string {
  const payload = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'ipropy-crm.onrender.com' },
    originalUrl: '/api/webhooks/telephony/twilio/status',
    protocol: 'http',
    get: () => 'ipropy-crm.onrender.com',
    body: {},
    query: {},
    ...overrides,
  };
}

async function verifier(telephony: Record<string, unknown>) {
  vi.doMock('../src/core/settings/integrations.js', () => ({
    getSettings: () => ({ telephony }),
  }));
  return (await import('../src/integrations/telephony/verifyWebhook.js')).verifyTelephonyWebhook;
}

const NO_TELEPHONY = {
  provider: 'none',
  twilio: { accountSid: '', authToken: '', callerId: '', appSid: '' },
  exotel: { sid: '', apiKey: '', apiToken: '', subdomain: '', callerId: '', webhookSecret: '' },
};

const TWILIO = { ...NO_TELEPHONY, twilio: { ...NO_TELEPHONY.twilio, authToken: AUTH_TOKEN } };

describe('telephony callbacks', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('refuses everything when nothing is configured', async () => {
    // The state the CRM is in today. Failing closed costs nothing now and is
    // already correct the moment a provider gets switched on.
    const verify = await verifier(NO_TELEPHONY);
    const verdict = verify(request() as never, 'twilio');

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('auth token');
  });

  it('accepts a correctly signed Twilio request', async () => {
    const verify = await verifier(TWILIO);
    const body = { CallSid: 'CA123', CallStatus: 'completed', Duration: '42' };
    const req = request({
      body,
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'ipropy-crm.onrender.com',
        'x-twilio-signature': twilioSign(URL_SIGNED, body, AUTH_TOKEN),
      },
    });

    expect(verify(req as never, 'twilio').ok).toBe(true);
  });

  it('refuses a Twilio request whose body was altered after signing', async () => {
    // The attack this exists for: take a real callback and swap the recording
    // URL for one of your own.
    const verify = await verifier(TWILIO);
    const signature = twilioSign(URL_SIGNED, { CallSid: 'CA123', RecordingUrl: 'https://real' }, AUTH_TOKEN);
    const req = request({
      body: { CallSid: 'CA123', RecordingUrl: 'http://169.254.169.254/latest/meta-data/' },
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'ipropy-crm.onrender.com',
        'x-twilio-signature': signature,
      },
    });

    expect(verify(req as never, 'twilio').ok).toBe(false);
  });

  it('refuses a Twilio request with no signature at all', async () => {
    const verify = await verifier(TWILIO);
    expect(verify(request() as never, 'twilio').ok).toBe(false);
  });

  it('signs against the forwarded host, not the one behind the proxy', async () => {
    /*
      Render terminates TLS in front of the app, so `req.protocol` is `http` and
      the real host is in `x-forwarded-host`. Signing over the wrong URL refuses
      every genuine request, which looks exactly like a wrong auth token and
      would be debugged for hours.
    */
    const verify = await verifier(TWILIO);
    const body = { CallSid: 'CA1' };
    const req = request({
      body,
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'ipropy-crm.onrender.com',
        'x-twilio-signature': twilioSign(URL_SIGNED, body, AUTH_TOKEN),
      },
      get: () => 'internal-10-0-0-4:10000',
    });

    expect(verify(req as never, 'twilio').ok).toBe(true);
  });

  it('takes a shared secret for a provider that cannot sign', async () => {
    const withSecret = {
      ...NO_TELEPHONY,
      exotel: { ...NO_TELEPHONY.exotel, webhookSecret: 'exotel-shared-secret' },
    };
    const verify = await verifier(withSecret);

    expect(verify(request({ query: { secret: 'exotel-shared-secret' } }) as never, 'exotel').ok).toBe(true);
    expect(verify(request({ headers: { 'x-telephony-secret': 'exotel-shared-secret' } }) as never, 'exotel').ok).toBe(true);
    expect(verify(request({ query: { secret: 'wrong' } }) as never, 'exotel').ok).toBe(false);
    expect(verify(request() as never, 'exotel').ok).toBe(false);
  });

  it('does not let one provider authenticate as another', async () => {
    // A secret leaked by one telephony vendor must not open the others.
    const verify = await verifier({
      ...NO_TELEPHONY,
      exotel: { ...NO_TELEPHONY.exotel, webhookSecret: 'exotel-shared-secret' },
    });

    expect(verify(request({ query: { secret: 'exotel-shared-secret' } }) as never, 'knowlarity').ok).toBe(false);
  });
});

describe('the shape of the old bug', () => {
  it('an empty configured secret must never mean "allow"', async () => {
    /*
      Pinned as its own case because this is the bug, restated: the Google lead
      route read `if (key && provided !== key)`, so a blank key skipped the
      comparison and let everyone through. Every check here is written as
      "no secret configured, therefore no".
    */
    const verify = await verifier(NO_TELEPHONY);

    for (const provider of ['twilio', 'exotel', 'knowlarity']) {
      expect(verify(request({ query: { secret: '' } }) as never, provider).ok).toBe(false);
      expect(verify(request({ headers: { 'x-telephony-secret': '' } }) as never, provider).ok).toBe(false);
    }
  });
});
