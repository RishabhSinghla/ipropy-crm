import { test, expect } from '@playwright/test';

// The results panel opens from the dark toolbar and used to inherit its white
// text, so every name printed white on white (11 October 2026). A class being
// present proves nothing here; the computed colour is the promise.
test('names in the search results are not white', async ({ page }) => {
  await page.goto('/leads');
  const box = page.getByPlaceholder('Search everything…');
  await box.fill('sh');
  const name = page.locator('#global-search-results a span.truncate').first();
  await expect(name).toBeVisible();
  const colour = await name.evaluate((el) => getComputedStyle(el).color);
  expect(colour).not.toBe('rgb(255, 255, 255)');
});
