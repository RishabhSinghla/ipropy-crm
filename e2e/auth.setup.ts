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
    The today-task buzzer pops up over whatever is on screen a minute after
    sign-in, which is the point for a rep and would land on top of every spec
    here. So the saved session starts with today's round already put off —
    the same note the buzzer itself writes, keyed by this browser's own day.
    `e2e/taskBuzzer.spec.ts` clears it to prove the popup.
  */
  await page.evaluate(() => {
    const userId = (JSON.parse(localStorage.getItem('ipropy.user') ?? 'null') as { id?: string } | null)?.id;
    if (!userId) return;
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    localStorage.setItem(`ipropy.taskBuzzer.${userId}.${day}`, JSON.stringify({ shown: [], nextAt: Date.now() + 24 * 60 * 60_000 }));
  });

  await page.context().storageState({ path: STORAGE_STATE });
});
