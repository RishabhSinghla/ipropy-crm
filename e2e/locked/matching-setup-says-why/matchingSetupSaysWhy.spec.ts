/**
 * Admin → Matching Setup must say so when it cannot load, not spin for ever.
 *
 * The page guarded with `isLoading || !data`. On a failed request `isLoading`
 * is false and `data` stays undefined, so it held its loading skeleton for
 * ever — the same fault that hid a broken WhatsApp Health page on 20 September
 * 2026 behind an empty grey box. CLAUDE.md names this page as the next one to
 * meet it.
 *
 * Reached by clicking from Admin rather than by URL, so a page that loads but
 * is no longer linked would fail too.
 */
import { test, expect } from '@playwright/test';

async function openMatchingSetup(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin');
  await page.getByRole('link', { name: 'Matching Setup' }).first().click();
}

test('a failed load says the page could not load, and why', async ({ page }) => {
  await page.route('**/api/admin/matching-config', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'probe: matching config unreadable' }) }),
  );
  await openMatchingSetup(page);

  await expect(page.getByText('This page could not load')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('probe: matching config unreadable')).toBeVisible();
});

test('a normal load still shows the settings', async ({ page }) => {
  await openMatchingSetup(page);

  await expect(page.getByLabel('Price / currency grace')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('This page could not load')).toHaveCount(0);
});
