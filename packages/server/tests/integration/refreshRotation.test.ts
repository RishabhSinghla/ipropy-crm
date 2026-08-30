/**
 * Refresh tokens, against a real database.
 *
 * Two things were wrong. They were stored exactly as issued, so anyone who read
 * `ipy_session` held a working thirty-day login for every member of staff. And
 * refreshing never replaced one, so a token that leaked stayed good for a month
 * with nothing to notice.
 *
 * This runs through the real Express app and the real Postgres because the
 * failure mode of getting it wrong is being locked out of your own CRM, and a
 * mocked session table would prove nothing about that. The concurrent-tabs case
 * matters most: rotation done naively signs people out at random, which is worse
 * than the problem it fixes and much harder to diagnose.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { SEEDED } from './fixtures.js';

let app: Express;

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

async function signIn(): Promise<{ token: string; refreshToken: string }> {
  const res = await request(app).post('/api/auth/login')
    .send({ email: SEEDED.executiveA, password: 'Admin@123' });
  expect(res.status).toBe(200);
  return { token: res.body.token as string, refreshToken: res.body.refreshToken as string };
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
});

describe('how a refresh token is stored', () => {
  it('never keeps the token itself', async () => {
    const { refreshToken } = await signIn();

    const stored = await db.queryOne<{ token_hash: string }>(
      `SELECT token_hash FROM ipy_session WHERE token_hash = $1`,
      [sha256(refreshToken)],
    );

    expect(stored, 'the session must be findable by hash').toBeTruthy();
    expect(stored!.token_hash).not.toBe(refreshToken);

    // And the plaintext column is gone entirely, not merely unused — an unused
    // column gets written to again by the next person who finds it.
    const column = await db.queryOne(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ipy_session' AND column_name = 'refresh_token'`,
    );
    expect(column, 'the plaintext column must not exist').toBeNull();
  });
});

describe('refreshing', () => {
  it('returns a working access token and a new refresh token', async () => {
    const { refreshToken } = await signIn();

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken, 'the caller must be given its replacement').toBeTruthy();
    expect(res.body.refreshToken).not.toBe(refreshToken);

    // The new access token is real.
    const me = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  it('lets the replacement refresh again, and the one after that', async () => {
    // A chain, because rotation that works once and breaks on the second hop
    // looks fine in a quick test and logs everybody out an hour later.
    const { refreshToken } = await signIn();

    const first = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/auth/refresh')
      .send({ refreshToken: first.body.refreshToken });
    expect(second.status).toBe(200);

    const third = await request(app).post('/api/auth/refresh')
      .send({ refreshToken: second.body.refreshToken });
    expect(third.status).toBe(200);
    expect(third.body.refreshToken).toBeTruthy();
  });

  it('answers a second tab that refreshed a moment too late', async () => {
    /*
      Both tabs hit a 401 at the same moment and both present the same token.
      The second is not an attack and must be answered, or rotation becomes a
      random logout generator. It gets a fresh access token and keeps the
      refresh token it already has.
    */
    const { refreshToken } = await signIn();

    const tabA = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(tabA.status).toBe(200);

    const tabB = await request(app).post('/api/auth/refresh').send({ refreshToken });

    expect(tabB.status, 'a concurrent refresh must not fail').toBe(200);
    expect(tabB.body.token, 'it still needs a usable access token').toBeTruthy();
    expect(tabB.body.refreshToken, 'but no second replacement').toBeUndefined();
  });

  it('treats a long-retired token as theft and revokes everything', async () => {
    /*
      The point of rotation. A token presented well after it was exchanged means
      two parties hold it, and there is no way to tell which is the owner. So
      every session that user has goes, and both are made to sign in again.
    */
    const { refreshToken } = await signIn();

    const rotated = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(rotated.status).toBe(200);

    // Age the rotation past the grace window rather than waiting a minute.
    await db.query(
      `UPDATE ipy_session SET rotated_at = now() - interval '10 minutes' WHERE token_hash = $1`,
      [sha256(refreshToken)],
    );

    const replayed = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(replayed.status).toBe(401);

    // And the successor is dead too, which is the part that makes it a defence
    // rather than a log line.
    const successor = await request(app).post('/api/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken });
    expect(successor.status, 'the whole family must be revoked').toBe(401);
  });

  it('refuses a token that was never issued', async () => {
    const res = await request(app).post('/api/auth/refresh')
      .send({ refreshToken: crypto.randomBytes(48).toString('base64url') });
    expect(res.status).toBe(401);
  });

  it('refuses one that has been signed out', async () => {
    const { token, refreshToken } = await signIn();

    const out = await request(app).post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({ refreshToken });
    expect(out.status).toBe(200);

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status, 'logout must still work now it matches on the hash').toBe(401);
  });

  it('refuses one that has expired', async () => {
    const { refreshToken } = await signIn();
    await db.query(
      `UPDATE ipy_session SET expires_at = now() - interval '1 day' WHERE token_hash = $1`,
      [sha256(refreshToken)],
    );

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });
});
