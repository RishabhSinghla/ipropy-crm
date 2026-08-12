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
import { testControlDatabaseUrl, testDatabaseUrl } from './testDatabase.js';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.CONTROL_DATABASE_URL = testControlDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-secret-long-enough-to-pass-the-startup-checks';
// The scheduler would otherwise start draining queues underneath the tests and
// mutate rows they are asserting on.
process.env.ENABLE_SCHEDULER = 'false';

// Several suites assert on how AI features behave with **no** provider — the
// state this install is actually in, and the one with the traps in it (spending
// retry attempts on a missing key, marking work permanently failed).
//
// Claude Code's own shell exports ANTHROPIC_API_KEY, so a suite run from an
// agent session sees a configured provider while the same command in a normal
// terminal does not: the degradation tests then fail, or worse, quietly start
// making real API calls. Cleared here rather than in each test because config.ts
// reads it once at module load, and this file runs before src/ is imported.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_PROVIDER;

// The sign-in brute-force guard is 20 attempts per 15 minutes per IP, and its
// limiter is built once at module scope in api/routes/auth.ts — so every
// `createApp()` in this process shares one budget, and the whole suite signs in
// from one address. It sat at roughly seventeen of twenty; the next file to add
// a login would have failed the run with a 401 that looks nothing like a rate
// limit, and only sometimes. Raised here rather than weakened in the product.
process.env.LOGIN_RATE_LIMIT = '10000';

afterAll(async () => {
  // Without this the pool's idle clients keep the worker alive and vitest hangs.
  const { closePool } = await import('../../src/db/pool.js');
  await closePool();
});
