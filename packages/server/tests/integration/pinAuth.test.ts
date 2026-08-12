import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type SuperAgentTest } from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';

let app: Express;
let browser: SuperAgentTest;
let cleanBrowser: SuperAgentTest;
let token: string;
let otherToken: string;
let userId: string;
let email: string;

async function passwordLogin(agent: SuperAgentTest, identifier: string): Promise<{ token: string }> {
  const response = await agent.post('/api/auth/login').send({ identifier, password: 'Admin@123' });
  if (response.status !== 200) throw new Error(`login failed: ${response.status} ${response.text}`);
  return response.body as { token: string };
}

beforeAll(async () => {
  app = createApp();
  browser = request.agent(app);
  cleanBrowser = request.agent(app);

  const admin = await db.queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM ipy_user
      WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  if (!admin) throw new Error('Seed admin missing');

  email = `device-pin-${randomUUID()}@itest.ipropy`;
  const user = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_user (email, password_hash, first_name, last_name, is_admin)
     VALUES ($1,$2,'Device PIN','Integration',true) RETURNING id`,
    [email, admin.password_hash],
  );
  if (!user) throw new Error('Could not create isolated PIN user');
  userId = user.id;
  token = (await passwordLogin(browser, email)).token;

  const otherEmail = `device-pin-other-${randomUUID()}@itest.ipropy`;
  await db.query(
    `INSERT INTO ipy_user (email, password_hash, first_name, last_name, is_admin)
     VALUES ($1,$2,'Other PIN','Integration',true)`,
    [otherEmail, admin.password_hash],
  );
  otherToken = (await passwordLogin(request.agent(app), otherEmail)).token;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_user WHERE email LIKE 'device-pin-%@itest.ipropy'`);
});

describe('trusted-device PIN authentication', () => {
  it('requires the account password and refuses a commonly guessed PIN', async () => {
    await browser.post('/api/auth/pin/enrol')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '1234', currentPassword: 'Admin@123', label: 'Test browser' })
      .expect(422);

    await browser.post('/api/auth/pin/enrol')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '4827', currentPassword: 'wrong-password', label: 'Test browser' })
      .expect(401);
  });

  it('binds quick unlock to one browser without storing its raw secret', async () => {
    const enrolled = await browser.post('/api/auth/pin/enrol')
      .set('Authorization', `Bearer ${token}`)
      .send({ pin: '4827', currentPassword: 'Admin@123', label: 'Integration browser' })
      .expect(201);

    const setCookie = enrolled.headers['set-cookie']?.[0] as string | undefined;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const rawToken = decodeURIComponent(setCookie!.split(';')[0].split('=').slice(1).join('='));

    const stored = await db.queryOne<{ id: string; token_hash: string; pin_hash: string }>(
      `SELECT id, token_hash, pin_hash FROM ipy_pin_device WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    expect(stored).not.toBeNull();
    expect(stored!.token_hash).not.toBe(rawToken);
    expect(stored!.token_hash).not.toContain(rawToken);
    expect(stored!.pin_hash).not.toContain('4827');

    const status = await browser.get('/api/auth/pin/status').expect(200);
    expect(status.body).toMatchObject({ available: true, userHint: 'Device PIN' });

    const login = await browser.post('/api/auth/pin/login').send({ pin: '4827' }).expect(200);
    expect(login.body.user).toMatchObject({ id: userId, email });
    expect(login.body.user.subordinateIds).toEqual(expect.any(Array));
    expect(login.body.token).toBeTruthy();
    expect(login.body.refreshToken).toBeTruthy();

    // Knowing the four digits is useless without this browser's hidden token.
    await cleanBrowser.post('/api/auth/pin/login').send({ pin: '4827' }).expect(401);

    const list = await browser.get('/api/auth/pin')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ id: stored!.id, label: 'Integration browser', is_current: true }),
    ]);

    // Another authenticated account cannot revoke this user's trusted browser.
    await request(app).delete(`/api/auth/pin/${stored!.id}`)
      .set('Authorization', `Bearer ${otherToken}`).expect(404);
  });

  it('locks the device after five wrong attempts and still allows password fallback', async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await browser.post('/api/auth/pin/login').send({ pin: '7391' }).expect(401);
    }
    await browser.post('/api/auth/pin/login').send({ pin: '7391' }).expect(429);
    await browser.post('/api/auth/pin/login').send({ pin: '4827' }).expect(429);

    // Lockout is scoped to this convenience credential, not the account.
    const password = await request(app).post('/api/auth/login')
      .send({ identifier: email, password: 'Admin@123' }).expect(200);
    expect(password.body.user.id).toBe(userId);
  });

  it('lets the owner revoke the device and removes quick unlock from that browser', async () => {
    const device = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_pin_device WHERE user_id = $1 AND revoked_at IS NULL`, [userId],
    );
    await browser.delete(`/api/auth/pin/${device!.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);

    const status = await browser.get('/api/auth/pin/status').expect(200);
    expect(status.body).toEqual({ available: false });
    await browser.post('/api/auth/pin/login').send({ pin: '4827' }).expect(401);
  });
});
