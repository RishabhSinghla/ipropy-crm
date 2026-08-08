/**
 * Per-worker setup. Runs before the test files in each worker are imported,
 * which is the only safe moment to point the app's connection pool at the
 * scratch database: config.ts reads DATABASE_URL once, at module load.
 *
 * Kept free of application imports on purpose — importing anything from src/
 * here would bind the pool to the developer's real database before these
 * lines had a chance to run.
 */
import { afterAll } from 'vitest';
import { testDatabaseUrl } from './testDatabase.js';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-secret-long-enough-to-pass-the-startup-checks';
// The scheduler would otherwise start draining queues underneath the tests and
// mutate rows they are asserting on.
process.env.ENABLE_SCHEDULER = 'false';

afterAll(async () => {
  // Without this the pool's idle clients keep the worker alive and vitest hangs.
  const { closePool } = await import('../../src/db/pool.js');
  await closePool();
});
