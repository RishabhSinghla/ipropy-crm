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
