/**
 * The refresh token is out of reach of any script on the page.
 *
 * Both tokens lived in `localStorage`. The access token being there is a small
 * problem: it expires in minutes. The refresh token being there is a large one —
 * thirty days, and its entire purpose is minting logins, so a copy of it is a
 * month of somebody else's access available to any injected script.
 *
 * `httpOnly` is the only real fix. Nothing else stops a script reading a value
 * the browser will hand it on request.
 *
 * The other half of this test matters as much: the server still accepts a token
 * in the request body. Every browser already signed in is holding one in
 * localStorage, and refusing it would have signed out the whole team on deploy.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { REFRESH_COOKIE } from '../../src/core/auth/refreshCookie.js';

let app: Express;
const LOGIN = { identifier: 'admin@ipropy.com', password: 'Admin@123' };

/** The Set-Cookie line for our cookie, if there is one. */
function refreshCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return all.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
}

function valueOf(setCookie: string): string {
  return setCookie.split(';')[0].split('=').slice(1).join('=');
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
});

describe('signing in', () => {
  it('puts the refresh token in a cookie a script cannot read', async () => {
    const res = await request(app).post('/api/auth/login').send(LOGIN).expect(200);
    const cookie = refreshCookie(res);

    expect(cookie, 'no refresh cookie was set').toBeTruthy();
    expect(cookie!, 'without HttpOnly any script on the page can read it').toContain('HttpOnly');
  });

  it('scopes the cookie to the two routes that need it', async () => {
    // A cookie sent on every request is a cookie with far more chances to end
    // up somewhere it should not.
    const res = await request(app).post('/api/auth/login').send(LOGIN).expect(200);
    expect(refreshCookie(res)!).toContain('Path=/api/auth');
  });

  it('refuses to travel to another site', async () => {
    const res = await request(app).post('/api/auth/login').send(LOGIN).expect(200);
    expect(refreshCookie(res)!).toMatch(/SameSite=Strict/i);
  });

  it('still returns the token in the body, so older tabs keep working', async () => {
    /*
      This is what makes the change deployable. A browser running the previous
      bundle reads the body and carries on exactly as before; a browser running
      the new one ignores it and uses the cookie.
    */
    const res = await request(app).post('/api/auth/login').send(LOGIN).expect(200);
    expect(res.body.refreshToken, 'removing this signs out everyone mid-session').toBeTruthy();
  });
});

describe('refreshing', () => {
  it('works from the cookie alone, with nothing in the body', async () => {
    const login = await request(app).post('/api/auth/login').send(LOGIN).expect(200);
    const cookie = refreshCookie(login)!;

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    expect(res.body.token, 'the cookie alone should be enough').toBeTruthy();
  });

  it('still works from the body alone, for a browser that has not caught up', async () => {
    const login = await request(app).post('/api/auth/login').send(LOGIN).expect(200);

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);

    expect(res.body.token).toBeTruthy();
  });

  it('hands back a fresh cookie when the token rotates', async () => {
    /*
      Rotation retires the token that was used. If the cookie kept the old one
      the next refresh would present a retired token, which the server correctly
      reads as theft and answers by revoking the entire session family — every
      device that person is signed in on.
    */
    const login = await request(app).post('/api/auth/login').send(LOGIN).expect(200);
    const first = refreshCookie(login)!;

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', first)
      .send({})
      .expect(200);

    const second = refreshCookie(res);
    expect(second, 'rotation must move the cookie too').toBeTruthy();
    expect(valueOf(second!)).not.toBe(valueOf(first));
  });

  it('refuses when there is neither a cookie nor a body token', async () => {
    await request(app).post('/api/auth/refresh').send({}).expect(401);
  });
});

describe('signing out', () => {
  it('clears the cookie', async () => {
    const login = await request(app).post('/api/auth/login').send(LOGIN).expect(200);
    const cookie = refreshCookie(login)!;

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.body.token}`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    const cleared = refreshCookie(res);
    expect(cleared, 'logout must expire the cookie, not just the session row').toBeTruthy();
    expect(valueOf(cleared!)).toBe('');
  });

  it('revokes the session the cookie names, with nothing in the body', async () => {
    const login = await request(app).post('/api/auth/login').send(LOGIN).expect(200);
    const cookie = refreshCookie(login)!;

    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.body.token}`)
      .set('Cookie', cookie)
      .send({})
      .expect(200);

    // The revoked token must no longer buy an access token.
    await request(app).post('/api/auth/refresh').set('Cookie', cookie).send({}).expect(401);
  });
});
