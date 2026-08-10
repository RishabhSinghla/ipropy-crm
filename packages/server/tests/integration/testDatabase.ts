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

/**
 * The control plane's own scratch database.
 *
 * Separate from the one above for the same reason it is separate in production:
 * `openControlPool` refuses to run when the customer list and a customer share
 * a database, so a suite that pointed both at one would only ever test the
 * refusal.
 */
export const TEST_CONTROL_DATABASE_NAME = 'ipropy_itest_control';

export function testControlDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const url = new URL(base);
  url.pathname = `/${TEST_CONTROL_DATABASE_NAME}`;
  return url.toString();
}

/** A third database, for provisioning a customer *into* during the control tests. */
export const TEST_TENANT_DATABASE_NAME = 'ipropy_itest_tenant';

export function testTenantDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL;
  const url = new URL(base);
  url.pathname = `/${TEST_TENANT_DATABASE_NAME}`;
  return url.toString();
}

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
