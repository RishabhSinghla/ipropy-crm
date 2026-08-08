import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/helpers';

/**
 * End-to-end tests: a real browser against a real stack.
 *
 * These exist to cover the one thing neither the unit nor the integration
 * suite can see — whether the app a person actually touches works. The
 * integration tests prove the API returns the right JSON; only this proves
 * that clicking a picklist in a table cell sends that JSON, and that the
 * value the user sees afterwards is the value that got saved.
 *
 * `webServer` starts the API and the Vite dev server and waits for them, so
 * `npm run test:e2e` works from a cold checkout with nothing running. It
 * reuses an already-running dev server locally so the usual edit/run loop
 * doesn't pay the startup cost twice.
 *
 * DATABASE_URL is NOT overridden here: e2e runs against the developer's normal
 * database on purpose, because it is meant to exercise the real thing. Tests
 * therefore create their own records with unique markers and never assert on
 * global counts.
 */
const WEB_PORT = 5173;
const API_PORT = 4000;

export default defineConfig({
  testDir: './e2e',
  // A failing e2e test is far more often a timing assumption than a real bug,
  // so retry once locally and twice in CI before believing it.
  retries: process.env.CI ? 2 : 1,
  workers: 1, // shared database — parallel specs would fight over records
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    // Only kept for failures — traces are large and uninteresting when green.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // Signs in once and saves the session; everything else reuses it rather
    // than logging in per test and tripping the login rate limiter.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup'],
      // mobile.spec.ts asserts phone-only layout (card list instead of table,
      // off-canvas drawer), so running it at desktop width would assert the
      // opposite of what is correct there.
      testIgnore: [/auth\.setup\.ts/, /mobile\.spec\.ts/],
    },
    // The team will use this on phones, so the critical path is checked at
    // phone size too — that is where the list becomes cards and the sidebar
    // becomes a drawer, i.e. genuinely different code.
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], storageState: STORAGE_STATE },
      dependencies: ['setup'],
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'npm run dev:server',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      command: 'npm run dev:web',
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
