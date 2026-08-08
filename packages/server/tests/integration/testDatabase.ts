/**
 * Where the integration suite's scratch database lives.
 *
 * Derived rather than passed around: globalSetup (which provisions the
 * database) and setup.ts (which runs in each worker and must point the app's
 * pool at it) are different processes, so a shared pure function is more
 * reliable than trying to hand a value between them.
 *
 * Deliberately a *separate* database from the developer's `ipropy`: the suite
 * drops and recreates it on every run, and doing that to the database someone
 * has their dev server and demo records in would be an unpleasant surprise.
 */

const DEFAULT_ADMIN_URL = 'postgres://ipropy:ipropy@localhost:5432/postgres';

export const TEST_DATABASE_NAME = 'ipropy_itest';

/** Connection string for the scratch database itself. */
export function testDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const url = new URL(base);
  url.pathname = `/${TEST_DATABASE_NAME}`;
  return url.toString();
}

/**
 * Connection string for a database we can issue CREATE/DROP DATABASE from —
 * Postgres refuses to drop the database the current session is connected to,
 * so provisioning has to happen from a different one.
 */
export function maintenanceDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const url = new URL(base);
  url.pathname = '/postgres';
  return url.toString();
}
