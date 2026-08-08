import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Integration suite — deliberately a separate project from vitest.config.ts.
 *
 * The unit suite must stay DB-free so `npm test` is fast and runnable anywhere
 * (it is the pre-commit/CI gate). These tests need a real Postgres, run
 * migrations against it and exercise the actual service layer, so they get
 * their own command (`npm run test:integration`) and their own include glob.
 *
 * Single-threaded on purpose: every test shares one scratch database, and the
 * suites assert on row counts and audit history. Parallel files would race
 * each other through the same tables and produce failures that depend on
 * scheduling rather than on the code.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@ipropy/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['./tests/integration/globalSetup.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    fileParallelism: false,
    // Migrating and seeding a fresh database on first run is slower than the
    // 5s default allows on a cold machine.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
