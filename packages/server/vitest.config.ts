import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against shared source, not its dist build, so they can never
      // silently exercise stale types.
      '@ipropy/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // tests/integration needs a real Postgres and is run by
    // vitest.integration.config.ts. Without this exclusion the glob above
    // matches it, and `npm test` would run those suites against whatever
    // DATABASE_URL happens to be set — i.e. the developer's own database,
    // creating and deleting records in it.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/integration/**'],
  },
});
