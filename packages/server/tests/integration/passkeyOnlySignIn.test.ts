/**
 * "Sign in with a passkey only" — a stolen password must open nothing.
 *
 * Uses one demo account of its own (the divya.patel marketing user) so no other
 * suite's sign-in is disturbed, and puts it back in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { SEEDED, signIn } from './fixtures.js';

const EMAIL = SEEDED.marketing;
let app: ReturnType<typeof createApp>;
let userId = '';
let credentialId = '';

beforeAll(async () => {
  app = createApp();
  const row = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_user WHERE lower(email) = lower($1)`, [EMAIL]);
  userId = row!.id;
});

afterAll(async () => {
  await db.query(`UPDATE ipy_user SET password_login_disabled = false WHERE id = $1`, [userId]);
  if (credentialId) await db.query(`DELETE FROM ipy_webauthn_credential WHERE id = $1`, [credentialId]);
});

async function addPasskey(used: boolean): Promise<void> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_webauthn_credential (user_id, credential_id, public_key, counter, device_label, last_used_at)
     VALUES ($1, $2, $3, 0, 'test phone', ${used ? 'now()' : 'NULL'}) RETURNING id`,
    [userId, `test-cred-${Date.now()}`, Buffer.from('not-a-real-key')],
  );
  credentialId = row!.id;
}

describe('passkey-only sign-in', () => {
  it('cannot be turned on before a passkey has been used', async () => {
    const token = await signIn(app, EMAIL);
    const res = await request(app).post('/api/auth/passkeys/lock').set('Authorization', `Bearer ${token}`).send({ enabled: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/passkey first/i);
    const state = await request(app).get('/api/auth/passkeys/lock').set('Authorization', `Bearer ${token}`);
    expect(state.body).toEqual({ enabled: false, canEnable: false });
  });

  it('refuses a correct password once it is on, and says what to do', async () => {
    await addPasskey(true);
    const token = await signIn(app, EMAIL);
    const on = await request(app).post('/api/auth/passkeys/lock').set('Authorization', `Bearer ${token}`).send({ enabled: true });
    expect(on.status).toBe(200);

    const attempt = await request(app).post('/api/auth/login').send({ identifier: EMAIL, password: 'Admin@123' });
    expect(attempt.status).toBe(401);
    expect(attempt.body.token).toBeUndefined();
    expect(JSON.stringify(attempt.body)).toMatch(/passkey only/i);
  });

  it('does not reveal the lock to someone with the wrong password', async () => {
    const attempt = await request(app).post('/api/auth/login').send({ identifier: EMAIL, password: 'definitely-wrong-1' });
    expect(attempt.status).toBe(401);
    expect(JSON.stringify(attempt.body)).not.toMatch(/passkey/i);
  });

  it('will not let the last passkey be removed while the password is off', async () => {
    // Sign in directly: the password no longer works, so mint a session the way a passkey would.
    const { issueSession } = await import('../../src/core/auth/session.js');
    const session = await issueSession(userId, { headers: {}, ip: '127.0.0.1' } as never);
    const res = await request(app).delete(`/api/auth/passkeys/${credentialId}`).set('Authorization', `Bearer ${session.token}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/last passkey/i);
    const stillThere = await db.queryOne(`SELECT 1 FROM ipy_webauthn_credential WHERE id = $1`, [credentialId]);
    expect(stillThere).toBeTruthy();
  });

  it('is undone by an admin resetting the password — the way back after a lost phone', async () => {
    const adminToken = await signIn(app, 'admin@ipropy.com');
    const reset = await request(app).post(`/api/admin/users/${userId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`).send({ password: 'Fresh-Start-Door-77' });
    expect(reset.status).toBe(200);

    const back = await request(app).post('/api/auth/login').send({ identifier: EMAIL, password: 'Fresh-Start-Door-77' });
    expect(back.status).toBe(200);

    // And the demo password goes back, so later suites still find this account as they expect.
    const { hashPassword } = await import('../../src/middleware/auth.js');
    await db.query(`UPDATE ipy_user SET password_hash = $2 WHERE id = $1`, [userId, await hashPassword('Admin@123')]);
  });
});
