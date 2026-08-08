import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure logic only — the colour maths, formatters and other helpers under
    // src/lib. Component rendering is covered by the Playwright e2e suite
    // against a real browser rather than a simulated DOM.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
