/**
 * Proves the harness itself works before any suite relies on it: the scratch
 * database exists, migrations ran, the seed produced metadata and users, and
 * we are definitely not pointed at the developer's real database.
 */
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { TEST_DATABASE_NAME } from './testDatabase.js';
import { adminContext, contextFor, SEEDED } from './fixtures.js';

describe('integration harness', () => {
  it('runs against the scratch database, not the dev one', async () => {
    const row = await db.queryOne<{ name: string }>('SELECT current_database() AS name');
    expect(row?.name).toBe(TEST_DATABASE_NAME);
  });

  it('applied every migration', async () => {
    const { rows } = await db.query<{ name: string }>('SELECT name FROM ipy_migration ORDER BY name');
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.at(-1)?.name).toMatch(/^0\d\d_.*\.sql$/);
  });

  it('seeded the metadata the engine needs', async () => {
    const leads = await registry.requireModule('leads');
    expect(leads.fields.length).toBeGreaterThan(10);
    expect(leads.fields.some((f) => f.storage === 'column')).toBe(true);
  });

  it('has both field storage kinds somewhere, so the query builder is exercised on both', async () => {
    // The column/JSON split is where most engine bugs live, so the suite needs
    // at least one of each to be meaningful. They are not on the same module:
    // seeded fields are all real columns, and the only JSON-storage fields are
    // the admin-style ones added later (publish_to_web on projects/properties).
    const projects = await registry.requireModule('projects');
    expect(projects.fields.some((f) => f.storage === 'column')).toBe(true);
    expect(projects.fields.some((f) => f.storage === 'json')).toBe(true);
  });

  it('builds a real scope context for a seeded user', async () => {
    const ctx = await contextFor(SEEDED.executiveA);
    expect(ctx.user.email).toBe(SEEDED.executiveA);
    expect(Array.isArray(ctx.subordinateIds)).toBe(true);
  });

  it('resolves an admin context', async () => {
    const ctx = await adminContext();
    expect(ctx.user.isAdmin).toBe(true);
  });
});
