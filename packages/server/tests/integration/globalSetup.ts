/**
 * Provisions the integration suite's database once, before any test file runs.
 *
 * Drops and recreates the scratch database, then applies migrations and the
 * seed through the application's own code paths — not a hand-written fixture
 * SQL file. That is the point: if a migration is broken, or the seed stops
 * producing the metadata the engine needs, the whole suite fails here rather
 * than every test failing mysteriously later. It is the same
 * migrate-then-seed sequence the production container runs on boot
 * (scripts/docker-entrypoint.sh), so this also keeps that path exercised.
 */
import { Client } from 'pg';
import {
  maintenanceDatabaseUrl, TEST_CONTROL_DATABASE_NAME, TEST_DATABASE_NAME,
  TEST_TENANT_DATABASE_NAME, testControlDatabaseUrl, testDatabaseUrl,
} from './testDatabase.js';

export default async function setup(): Promise<void> {
  const admin = new Client({ connectionString: maintenanceDatabaseUrl() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Integration tests need a running Postgres at ${maintenanceDatabaseUrl().replace(/:[^:@]*@/, ':***@')}.\n`
      + 'Start one with `docker compose up -d db`, or set TEST_DATABASE_URL.\n'
      + `Original error: ${(err as Error).message}`,
    );
  }

  try {
    // FORCE terminates any leftover connections from an interrupted run;
    // without it a stale session makes DROP DATABASE hang.
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE_NAME}`);

    // The control-plane suite gets two more: one for the customer list, one to
    // provision a customer into. Dropped here rather than after the run so a
    // failed run leaves them behind to inspect.
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_CONTROL_DATABASE_NAME} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_TENANT_DATABASE_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_TENANT_DATABASE_NAME}`);
  } finally {
    await admin.end();
  }

  // Must be set before anything imports config.ts/pool.ts, since the pool binds
  // its connection string at module load. dotenv does not override values that
  // are already present in process.env, so this wins over any .env file.
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.NODE_ENV = 'test';
  // Demo data gives the suite a realistic cast of users with different roles
  // and profiles, which is what the permission tests actually need. The
  // production guard that forbids this only applies when NODE_ENV=production.
  process.env.SEED_DEMO_DATA = 'true';
  // The control plane creates this itself on first connect, which is one of the
  // things the suite checks.
  process.env.CONTROL_DATABASE_URL = testControlDatabaseUrl();
  process.env.JWT_SECRET = 'integration-test-secret-long-enough-to-pass-the-startup-checks';

  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations();

  const { seed } = await import('../../src/db/seed/index.js');
  await seed();

  // Release the provisioning process's own pool; each worker opens its own.
  const { closePool } = await import('../../src/db/pool.js');
  await closePool();
}
