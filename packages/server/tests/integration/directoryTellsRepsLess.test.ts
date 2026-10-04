/**
 * A rep gets a staff directory. An admin gets the staff records.
 *
 * `/api/admin/users` is deliberately open to everyone signed in, because owner
 * pickers and @mention lists need to know who exists — that part is right, and
 * the route said so in a comment describing "a safe projection".
 *
 * It was not one. It returned every column to every caller, so a telecaller
 * opening any lead received each colleague's email, phone number, **when they
 * last signed in**, whether they are an admin, and their lead-routing caps.
 * Drawing a name in a dropdown needs none of that.
 *
 * Not a dramatic hole — these are colleagues, not customers — but it is the
 * same shape as the other faults found this week: a comment claiming a
 * protection the code did not implement, which is worse than no comment because
 * the next reader believes it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { adminContext, signIn } from './fixtures.js';
import { db } from '../../src/db/pool.js';
import { hashPassword } from '../../src/middleware/auth.js';

let app: Express;
let repToken = '';
let adminToken = '';

const REP_EMAIL = `directory.rep.${Date.now()}@example.com`;
const PASSWORD = 'Directory@123';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const admin = await adminContext();
  adminToken = await signIn(app, admin.user.email);

  // A plain rep: no admin flag, whatever profile the seed gives by default.
  await db.query(
    `INSERT INTO ipy_user (email, password_hash, first_name, last_name, is_admin, is_active)
     VALUES ($1,$2,'Directory','Rep',false,true)`,
    [REP_EMAIL, await hashPassword(PASSWORD)],
  );
  repToken = await signIn(app, REP_EMAIL, PASSWORD);
});

describe('the staff directory', () => {
  it('limits follow-up filter agents to self when a rep has no hierarchy role', async () => {
    const rep = await db.queryOne<{ id: string }>('SELECT id FROM ipy_user WHERE email = $1', [REP_EMAIL]);
    for (const module of ['leads', 'properties']) {
      const res = await request(app).get(`/api/admin/users?filterModule=${module}`)
        .set('Authorization', `Bearer ${repToken}`).expect(200);
      expect(res.body.map((user: { id: string }) => user.id)).toEqual([rep!.id]);
    }
    // This read-only filter scope must not narrow the assignment directory.
    const directory = await request(app).get('/api/admin/users?assignableOnly=true')
      .set('Authorization', `Bearer ${repToken}`).expect(200);
    expect(directory.body.length).toBeGreaterThan(1);
  });

  it('keeps all active agents available to the admin follow-up filter', async () => {
    const res = await request(app).get('/api/admin/users?filterModule=leads')
      .set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(res.body.length).toBeGreaterThan(1);
  });

  it('still gives a rep everything a picker needs', async () => {
    // The reason it is open at all. Take this away and owner dropdowns and
    // @mentions go blank for everyone who is not an admin.
    const res = await request(app).get('/api/admin/users')
      .set('Authorization', `Bearer ${repToken}`).expect(200);

    expect(res.body.length).toBeGreaterThan(0);
    for (const key of ['id', 'fullName', 'firstName', 'lastName', 'avatarUrl']) {
      expect(res.body[0], `a picker cannot draw a person without ${key}`).toHaveProperty(key);
    }
  });

  it('does not tell a rep when their colleagues last signed in', async () => {
    const res = await request(app).get('/api/admin/users')
      .set('Authorization', `Bearer ${repToken}`).expect(200);

    for (const key of ['lastLoginAt', 'email', 'phone', 'isAdmin', 'acceptsLeads', 'dailyLeadCap']) {
      expect(
        res.body[0],
        `${key} is not needed to draw a name, and a rep should not be handed it`,
      ).not.toHaveProperty(key);
    }
  });

  it('still gives an admin the whole record, because Admin → Users needs it', async () => {
    const res = await request(app).get('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`).expect(200);

    for (const key of ['email', 'lastLoginAt', 'isAdmin', 'roleName', 'profileName', 'dailyLeadCap']) {
      expect(res.body[0], `Admin → Users renders ${key}`).toHaveProperty(key);
    }
  });

  it('refuses an unauthenticated caller entirely', async () => {
    await request(app).get('/api/admin/users').expect(401);
  });
});
