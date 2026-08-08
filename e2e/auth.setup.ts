import { test as setup } from '@playwright/test';
import { login, STORAGE_STATE } from './helpers';

/**
 * Signs in once per run and saves the session for every other spec.
 *
 * Logging in inside each test hammers POST /api/auth/login, and the server
 * rate-limits it — correctly, since that endpoint is the front door for
 * credential stuffing. A suite that logs in a dozen times trips its own
 * defence and then reports the resulting failures as if the app were broken.
 *
 * This is also just faster: the login round-trip happens once instead of once
 * per test.
 */
setup('authenticate', async ({ page }) => {
  await login(page);
  await page.context().storageState({ path: STORAGE_STATE });
});
