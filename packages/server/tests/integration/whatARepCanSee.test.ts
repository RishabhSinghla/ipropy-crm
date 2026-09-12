/**
 * What a sales executive sees, across the surface they can reach.
 *
 * Six named reps started on this CRM in September 2026 and the browser suite
 * signs in as an administrator for every one of its specs, so nothing was
 * checking the view from an ordinary seat. Scoping is the kind of thing that
 * regresses silently: nobody reports seeing *too much*.
 *
 * Three of these pass today and are pinned so they keep passing. The fourth —
 * masking a secret setting — has never run at all, because no setting in any
 * database is marked secret, so the branch that hides one has been carried
 * untested since it was written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';

let app: ReturnType<typeof createApp>;
let adminToken = '';
let repToken = '';
const SECRET_KEY = 'qa.pretend_secret';

async function signIn(identifier: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ identifier, password: 'Admin@123' });
  return res.body.token ?? '';
}

beforeAll(async () => {
  app = createApp();
  adminToken = await signIn('admin@ipropy.com');
  // The demo team share a password; this only ever runs against a throwaway
  // database, and production has no demo accounts (checked 2026-09-11).
  repToken = await signIn('aisha.khan@ipropy.com');
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_setting WHERE key = $1`, [SECRET_KEY]).catch(() => undefined);
});

describe('a sales executive', () => {
  it('signs in at all', () => {
    expect(repToken, 'the rep could not sign in, so nothing below means anything').toBeTruthy();
  });

  it('sees fewer contacts than an administrator, and cannot open one that is not theirs', async () => {
    const all = await request(app).get('/api/records/leads?pageSize=100').set('Authorization', `Bearer ${adminToken}`);
    const mine = await request(app).get('/api/records/leads?pageSize=100').set('Authorization', `Bearer ${repToken}`);
    expect(mine.body.total).toBeLessThan(all.body.total);

    const ids = new Set((mine.body.rows ?? []).map((r: { id: string }) => r.id));
    const other = (all.body.rows ?? []).find((r: { id: string }) => !ids.has(r.id));
    if (!other) return; // every record is theirs; nothing to prove here

    const peek = await request(app).get(`/api/records/leads/${other.id}`).set('Authorization', `Bearer ${repToken}`);
    expect([403, 404], `a rep opened a contact they do not own (${peek.status})`).toContain(peek.status);
  });

  it('gets a directory without the colleagues’ contact details', async () => {
    // `/api/admin/users` is open on purpose — owner pickers and @mentions need
    // it — so what matters is what comes back, not that it answers.
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${repToken}`);
    expect(res.status).toBe(200);

    const first = (Array.isArray(res.body) ? res.body : res.body.rows ?? [])[0] ?? {};
    for (const field of ['email', 'phone', 'isAdmin', 'roleName', 'lastLoginAt']) {
      expect(Object.keys(first), `a rep can read colleagues' ${field}`).not.toContain(field);
    }
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/password|key_hash|token/);
  });

  it('reads a secret setting as dots, where an administrator reads the value', async () => {
    await db.query(
      `INSERT INTO ipy_setting (key, value, category, label, is_secret)
       VALUES ($1, to_jsonb('super-secret-value'::text), 'qa', 'QA pretend secret', true)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_secret = true`,
      [SECRET_KEY],
    );

    const asRep = await request(app).get('/api/admin/settings').set('Authorization', `Bearer ${repToken}`);
    const asAdmin = await request(app).get('/api/admin/settings').set('Authorization', `Bearer ${adminToken}`);

    const pick = (body: unknown): unknown =>
      (body as { key: string; value: unknown }[]).find((s) => s.key === SECRET_KEY)?.value;

    expect(pick(asRep.body), 'a rep read a secret setting in the clear').toBe('••••••••');
    expect(pick(asAdmin.body)).toBe('super-secret-value');
    expect(JSON.stringify(asRep.body)).not.toContain('super-secret-value');
  });
});
