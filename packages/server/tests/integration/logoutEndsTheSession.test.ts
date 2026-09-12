/**
 * Pressing Log out has to actually log you out.
 *
 * Refresh tokens rotate: every exchange writes a new session row and points the
 * old one at it through `replaced_by`. Logout revoked only the row whose hash
 * matched what was handed over — so a tab holding a token another tab had
 * already rotated revoked something superseded, answered `{ ok: true }`, and
 * left the session running.
 *
 * That is the normal case rather than an edge one. Two tabs hitting a 401
 * together is precisely what the rotation grace window exists for, so the token
 * in the tab somebody presses Log out in is routinely a link behind.
 *
 * The third test is the other half of the promise: ending one session must not
 * end the others. Revoking every row for the user would pass the first two and
 * sign somebody out of their phone because they logged out of a laptop.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

let app: ReturnType<typeof createApp>;

const signIn = async () => {
  const res = await request(app).post('/api/auth/login')
    .send({ identifier: 'admin@ipropy.com', password: 'Admin@123' });
  return { access: res.body.token as string, refresh: res.body.refreshToken as string };
};
const refresh = (token: string) =>
  request(app).post('/api/auth/refresh').send({ refreshToken: token });
const logout = (refreshToken: string, access: string) =>
  request(app).post('/api/auth/logout').set('Authorization', `Bearer ${access}`).send({ refreshToken });

beforeAll(() => { app = createApp(); });

describe('logging out', () => {
  it('ends the session even when the tab holds a token another tab has rotated', async () => {
    const { access, refresh: first } = await signIn();

    // Tab A refreshes. Tab B still holds `first`.
    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);
    const newer = rotated.body.refreshToken as string;
    expect(newer).not.toBe(first);

    // Tab B presses Log out with the token it has.
    expect((await logout(first, access)).status).toBe(200);

    // Tab A must now be signed out too.
    expect((await refresh(newer)).status,
      'the session was still alive after the user logged out').toBe(401);
  });

  it('ends it in the ordinary single-tab case too', async () => {
    const { access, refresh: token } = await signIn();
    expect((await logout(token, access)).status).toBe(200);
    expect((await refresh(token)).status).toBe(401);
  });

  it('does not sign you out everywhere when you log out twice', async () => {
    /*
      The revoke only touches live rows, so a second logout matched nothing —
      which read as "a token no session has ever had" and sent the fallback
      through to end every session this user had. Two clicks on a laptop, and
      the phone is signed out too.
    */
    const laptop = await signIn();
    const phone = await signIn();

    expect((await logout(laptop.refresh, laptop.access)).status).toBe(200);
    expect((await logout(laptop.refresh, laptop.access)).status).toBe(200);

    expect((await refresh(phone.refresh)).status,
      'logging out twice signed them out of their other device').toBe(200);
  });

  it('leaves the other device signed in', async () => {
    const laptop = await signIn();
    const phone = await signIn();

    await logout(laptop.refresh, laptop.access);

    expect((await refresh(phone.refresh)).status,
      'logging out of one device signed them out of the other').toBe(200);
  });
});
