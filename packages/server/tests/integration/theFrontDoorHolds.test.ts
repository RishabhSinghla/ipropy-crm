/**
 * The ways in, checked from outside.
 *
 * Two real defects turned up here in one evening — the sign-in limiter locking
 * out a whole office, and Log out not ending a session whose token another tab
 * had rotated — so the rest of the front door is walked rather than assumed.
 * Every one of these passes today; they are here so they keep passing.
 *
 * Deliberately not covered here: the sign-in rate limiter itself, which is
 * stateful and shared, so exercising it would spend the budget of every spec
 * that runs afterwards. Its keying is pinned in `loginLimiterBuckets.test.ts`
 * without touching the limiter at all.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

let app: ReturnType<typeof createApp>;
let token = '';
const PASSWORD = 'Admin@123';

beforeAll(async () => {
  app = createApp();
  const res = await request(app).post('/api/auth/login').send({ identifier: 'admin@ipropy.com', password: PASSWORD });
  token = res.body.token;
});

describe('the front door', () => {
  it('will not say whether an address has an account', async () => {
    // Otherwise the reset form becomes a way to enumerate the team.
    const known = await request(app).post('/api/auth/forgot-password').send({ email: 'admin@ipropy.com' });
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: `nobody-${Date.now()}@example.com` });

    expect(known.status).toBe(unknown.status);
    expect(JSON.stringify(known.body)).toBe(JSON.stringify(unknown.body));
  });

  it('will not change a password without the current one', async () => {
    // A stolen session must not become a stolen account.
    const missing = await request(app).post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`).send({ newPassword: 'BrandNewPassw0rd!' });
    expect(missing.status).toBeGreaterThanOrEqual(400);

    const wrong = await request(app).post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`).send({ currentPassword: 'not-it', newPassword: 'BrandNewPassw0rd!' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
  });

  it('will not accept a trivial new password', async () => {
    const res = await request(app).post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`).send({ currentPassword: PASSWORD, newPassword: '123' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a made-up reset token', async () => {
    const res = await request(app).post('/api/auth/reset-password')
      .send({ token: `not-a-real-token-${Date.now()}`, password: 'BrandNewPassw0rd!' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a tampered access token, and no token at all', async () => {
    const tampered = `${token.slice(0, -6)}AAAAAA`;
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tampered}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('will not mint an API key for somebody who is not signed in', async () => {
    // A key carries its owner's access, so this is the front door twice over.
    const res = await request(app).post('/api/auth/api-keys').send({ name: 'qa' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a guessable device PIN', async () => {
    const res = await request(app).post('/api/auth/pin/enrol')
      .set('Authorization', `Bearer ${token}`).send({ pin: '1234', deviceName: 'QA' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
