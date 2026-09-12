/**
 * Creating a user, which was broken and nothing noticed.
 *
 * The INSERT named fourteen columns and supplied thirteen values: `channel_partner_id`
 * had been taken out of the request schema and left in the column list. Every
 * attempt died on "bind message supplies 13 parameters, but prepared statement
 * requires 14" — a 500 with no clue in it, on the one screen an owner uses to
 * give their team logins.
 *
 * No test covered creating a user at all, which is how a mismatch that
 * TypeScript cannot see survived. This is that test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

let app: Express;
let token: string;
const made: string[] = [];

const unique = (): string => `e2e-user-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await signIn(app, admin!.email);
});

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_user WHERE id = ANY($1::uuid[])`, [made]);
});

describe('creating a user', () => {
  it('creates one from the fields the admin screen actually sends', async () => {
    const email = `${unique()}@itest.ipropy`;
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email,
        password: 'Str0ngEnough!',
        firstName: 'Test',
        lastName: 'Person',
        acceptsLeads: true,
        isAdmin: false,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.id).toBeTruthy();
    made.push(res.body.id as string);

    const row = await db.queryOne<{ email: string; accepts_leads: boolean }>(
      `SELECT email, accepts_leads FROM ipy_user WHERE id = $1`, [res.body.id],
    );
    expect(row!.email).toBe(email);
    expect(row!.accepts_leads).toBe(true);
  });

  it('creates one with every optional field filled in', async () => {
    // The failing bind was on the long form, so the long form is what to assert.
    const email = `${unique()}@itest.ipropy`;
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email,
        password: 'Str0ngEnough!',
        firstName: 'Full',
        lastName: 'House',
        phone: '9811111111',
        acceptsLeads: true,
        dailyLeadCap: 5,
        isAdmin: false,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.id as string);

    const row = await db.queryOne<{ daily_lead_cap: number }>(
      `SELECT daily_lead_cap FROM ipy_user WHERE id = $1`, [res.body.id],
    );
    expect(row!.daily_lead_cap).toBe(5);
  });

  it('refuses a duplicate email rather than creating a second account', async () => {
    // A real address: `system@ipropy` has no TLD and is refused by validation
    // before the duplicate check is ever reached.
    const taken = await db.queryOne<{ email: string }>(
      `SELECT email FROM ipy_user
        WHERE is_admin = true AND deleted_at IS NULL AND email LIKE '%@%.%'
        ORDER BY created_at LIMIT 1`,
    );
    expect(taken, 'needs an existing account to clash with').toBeTruthy();

    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: taken!.email, password: 'Str0ngEnough!', firstName: 'Clash', lastName: 'Test' });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });
});
