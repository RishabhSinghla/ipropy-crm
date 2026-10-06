import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Logic runs in node; isolated component regressions opt into jsdom.
    // Browser verification still checks the real screen before a release.
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
