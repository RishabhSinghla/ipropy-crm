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

  /*
    Lists open on the iPROPY desk now, for everybody. Most specs here were
    written against the table and are about the table — so the saved session
    carries the same choice a rep makes by clicking Table once, and the specs
    go on testing what they say they test.

    The default itself is not left untested by that: `listDefaultView.spec.ts`
    clears this key and asserts a fresh person lands on the desk.
  */
  await page.evaluate(() => {
    for (const module of ['leads', 'properties']) {
      localStorage.setItem(`ipropy.listmode.${module}`, 'table');
    }
  });

  await page.context().storageState({ path: STORAGE_STATE });
});
