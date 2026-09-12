import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

/**
 * A webhook with no secret configured must refuse everybody.
 *
 * This file used to test the telephony callbacks — Twilio's HMAC, Exotel's
 * shared secret. Both providers are gone (migration 141) and so are their
 * endpoints, but the property those tests existed to pin is still live on three
 * routes here, and it is the one that has actually been wrong in production:
 *
 *     if (key && provided !== key) reject
 *
 * A blank `key` skipped the comparison entirely, so an unconfigured webhook
 * accepted anything anyone sent it. Every surviving check is written the other
 * way round — `if (!key || !safeEqual(...)) reject` — and that is what these
 * assert, against the real Express app rather than a helper in isolation.
 *
 * Deliberately no database: an unauthenticated request must be turned away
 * before anything reads or writes, so these never get far enough to need one.
 */
const app = createApp();

describe('a webhook with nothing configured', () => {
  it('refuses a Google lead, with or without a key in the body', async () => {
    // Nothing is configured on a test environment, which is exactly the state
    // the old bug turned into "allow".
    await request(app).post('/api/webhooks/leads/google').send({}).expect(401);
    await request(app).post('/api/webhooks/leads/google').send({ google_key: '' }).expect(401);
    await request(app).post('/api/webhooks/leads/google').send({ google_key: 'guessed' }).expect(401);
  });

  it('refuses a portal lead however the secret is presented', async () => {
    // Header and query string are two doors to the same check; a fix applied to
    // one and not the other is how this class of bug comes back.
    await request(app).post('/api/webhooks/leads/portal/99acres').send({}).expect(401);
    await request(app)
      .post('/api/webhooks/leads/portal/99acres')
      .set('x-portal-secret', '')
      .send({})
      .expect(401);
    await request(app)
      .post('/api/webhooks/leads/portal/99acres?secret=')
      .send({})
      .expect(401);
    await request(app)
      .post('/api/webhooks/leads/portal/99acres?secret=guessed')
      .send({})
      .expect(401);
  });

  it('no longer does anything on the telephony callbacks', async () => {
    /*
      Exotel and Twilio are removed, and so is the surface they needed: signed
      status callbacks, recording callbacks, inbound routing and a softphone
      lookup — all public by necessity, all kept alive for a feature nobody had
      switched on.

      401 rather than 404, and that is the app's own behaviour rather than
      anything left behind: an unmatched `/api/...` path falls past the webhook
      router into the catch-all that requires a session. What matters here is
      that it is **refused** — these used to answer 200 unconditionally, before
      they were authenticated at all, and `/recording` would then fetch a URL
      from the request body.
    */
    for (const call of [
      request(app).post('/api/webhooks/telephony/twilio/status').send({}),
      request(app).post('/api/webhooks/telephony/exotel/incoming').send({}),
      request(app).get('/api/webhooks/telephony/lookup?number=9999999999'),
    ]) {
      const res = await call;
      expect(res.status, 'a removed telephony endpoint must never answer 200').not.toBe(200);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
