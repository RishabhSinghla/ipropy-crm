/**
 * Shared helpers for the integration suite.
 *
 * The users here are the ones `db/seed/rbac.ts` creates, looked up by email
 * rather than hardcoded by id — the seed generates fresh UUIDs each run. Using
 * the seeded cast (rather than inventing users) means the tests exercise the
 * real role hierarchy and profile permissions that ship with the product,
 * so a change to either shows up as a test failure instead of a surprise in
 * production.
 */
import request from 'supertest';
import type { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { buildScopeContext } from '../../src/core/permissions/index.js';
import type { ServiceContext } from '../../src/core/entity/recordService.js';
import type { AuthUser } from '@ipropy/shared';

/** Emails of the seeded cast, by the role each one is useful for testing. */
export const SEEDED = {
  salesHead: 'priya.sharma@ipropy.com',
  salesManager: 'rahul.mehta@ipropy.com',
  executiveA: 'aisha.khan@ipropy.com',
  executiveB: 'vikram.rao@ipropy.com',
  telecaller: 'neha.gupta@ipropy.com',
  marketing: 'divya.patel@ipropy.com',
} as const;

interface UserRow {
  id: string; email: string; first_name: string; last_name: string;
  is_admin: boolean; is_active: boolean; role_id: string | null; profile_id: string | null;
}

/** Load a seeded user and wrap it in the same AuthUser the auth middleware builds. */
export async function authUser(email: string): Promise<AuthUser> {
  const row = await db.queryOne<UserRow>(
    `SELECT id, email, first_name, last_name, is_admin, is_active, role_id, profile_id
       FROM ipy_user WHERE email = $1`,
    [email],
  );
  if (!row) throw new Error(`Seeded user ${email} not found — did the seed change?`);

  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: `${row.first_name} ${row.last_name}`.trim(),
    avatarUrl: null,
    phone: null,
    isAdmin: row.is_admin,
    isActive: row.is_active,
    roleId: row.role_id,
    roleName: null,
    profileId: row.profile_id,
    profileName: null,
    groupIds: [],
  };
}

/**
 * A ServiceContext exactly as a real HTTP request would produce one —
 * including the role-hierarchy subordinate expansion, which is what the
 * record-scoping rules key off. Tests that skip this and hand-build a context
 * would silently bypass the sharing model they are meant to be checking.
 */
export async function contextFor(email: string): Promise<ServiceContext> {
  const user = await authUser(email);
  return buildScopeContext(user);
}

/** Admin context — the seed admin's email is configurable, so find it by flag. */
export async function adminContext(): Promise<ServiceContext> {
  const row = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  if (!row) throw new Error('No admin user in the seeded database');
  return contextFor(row.email);
}

/** Minimum viable Lead payload for the current one-name, split-country-code form. */
let leadSeq = 0;

export function leadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const unique = Math.random().toString(36).slice(2, 10);
  // Strictly unique per call: the leads-module duplicate check matches on the
  // 10-digit mobile, and a random 8-digit tail eventually collides across the
  // many suites sharing one throwaway database (seen once in CI).
  const mobile = `9${String(Date.now()).slice(-8)}${leadSeq++ % 10}`;
  return {
    full_name: `Integration Test-${unique}`,
    mobile,
    ...overrides,
  };
}

/** Minimum Property payload under the real Mobile-only duplicate rule. */
let propertySeq = 0;
export function propertyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const legacyName = typeof overrides.name === 'string' ? overrides.name : undefined;
  const { name: _legacyName, ...rest } = overrides;
  const mobile = `8${String(Date.now()).slice(-8)}${propertySeq++ % 10}`;
  return { full_name: legacyName ?? `Integration Property ${propertySeq}`, mobile, ...rest };
}

/**
 * Sign in over HTTP and hand back the token — or fail here, saying why.
 *
 * Thirty-eight files used to do this by hand as
 * `token = (await request(app).post('/api/auth/login').send(…)).body.token`,
 * and the missing half of that line is what made this suite hard to trust. A
 * login that does not return 200 yields `undefined`, every later request sends
 * `Bearer undefined`, and the run fails several assertions later with
 * "expected 200, got 401" — which reads as a permissions bug in whatever
 * happened to be asserted next.
 *
 * It has already cost this project once: the brute-force guard is built once
 * at module scope in `api/routes/auth.ts`, so every `createApp()` in the
 * process shares one budget and the whole suite signs in from one address. It
 * reached seventeen of twenty, and the next file to add a login would have
 * turned the run red somewhere else entirely. `setup.ts` raises the limit, but
 * a raised limit only moves the cliff — this makes falling off it legible.
 *
 * So: assert here, with the status and the body, where the cause is still in
 * front of you.
 */
export async function signIn(
  app: ReturnType<typeof createApp>,
  identifier: string,
  password = 'Admin@123',
): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ identifier, password });
  if (res.status !== 200 || !res.body?.token) {
    throw new Error(
      `Could not sign in as ${identifier}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body.token as string;
}

/**
 * The seeded administrator's email.
 *
 * Ordered by id as well as the timestamp, because the seed writes every user
 * in one transaction and they therefore share one `created_at` — ordering by
 * that alone is a coin flip that Postgres is free to decide differently once
 * any row has been updated.
 */
export async function adminEmail(): Promise<string> {
  const row = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user
      WHERE is_admin = true AND password_hash IS NOT NULL
      ORDER BY created_at, id LIMIT 1`,
  );
  if (!row) throw new Error('No seeded administrator with a password — did the seed change?');
  return row.email;
}

/** Sign in as the seeded administrator. The commonest two lines in this suite. */
export async function adminToken(app: ReturnType<typeof createApp>): Promise<string> {
  return signIn(app, await adminEmail());
}

/**
 * Read a binary response as bytes, deterministically.
 *
 * supertest picks a body parser from the content type, and it has none for
 * `audio/mp4` or `application/zip` — so the body is whatever the default left
 * behind, a Buffer most of the time and a plain object often enough to matter.
 * That produced a test failing once in nineteen full runs on a byte comparison
 * that said nothing, and then failed immediately in a second suite written the
 * same way.
 *
 * Collecting the chunks removes the guess. Wrap any request whose body is not
 * text or JSON.
 */
export function asBytes<T extends { buffer(v: boolean): T; parse(fn: (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => void): T }>(req: T): T {
  return req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}
