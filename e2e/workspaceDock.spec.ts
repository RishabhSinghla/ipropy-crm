/**
 * The toolbar down the left, on every page — 1 October 2026, the owner: *"it
 * needs to be fixed throughout the CRM all time … when I opened say call
 * module that left tool tab vanished"*. It replaced the header's module
 * switcher and WhatsApp button, so it has to reach everything they did.
 */
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

for (const path of ['/dashboard', '/leads', '/calls', '/settings']) {
  test(`it is there on ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByTestId('workspace-dock')).toBeVisible({ timeout: 30_000 });
  });
}

test('the header no longer carries the switcher or the WhatsApp button', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByTestId('workspace-dock')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Switch module' })).toHaveCount(0);
  await expect(page.locator('header a[href="/whatsapp"]')).toBeHidden();
});

test('choosing a module goes there, and its icon says so', async ({ page }) => {
  await page.goto('/calls');
  const dock = page.getByTestId('workspace-dock');
  const firstModule = dock.locator('a[href^="/"]').nth(2);
  const href = await firstModule.getAttribute('href');
  await firstModule.click();
  await expect(page).toHaveURL(new RegExp(`${href}`));
  await expect(firstModule).toHaveClass(/bg-white/);
});

test('no Tasks or Campaigns icon — Campaigns lives in WhatsApp (3 October 2026)', async ({ page }) => {
  await page.goto('/leads');
  const dock = page.getByTestId('workspace-dock');
  await expect(dock).toBeVisible({ timeout: 30_000 });
  await expect(dock.getByRole('link', { name: "Today's tasks" })).toHaveCount(0);
  await expect(dock.getByRole('link', { name: 'Campaigns' })).toHaveCount(0);
});

test('Ask AI is a circle that can be dragged, and a tap opens it', async ({ page }) => {
  await page.goto('/dashboard');
  const bubble = page.getByTestId('ai-bubble');
  await expect(bubble).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('header').getByRole('button', { name: /Ask AI/ })).toHaveCount(0);

  const from = (await bubble.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 8 });
  await page.mouse.up();
  const to = (await bubble.boundingBox())!;
  expect(Math.abs(to.x - from.x) + Math.abs(to.y - from.y), 'the circle did not move').toBeGreaterThan(100);
  // A drag is not a tap: nothing opened.
  await expect(page.getByPlaceholder(/Ask or tell iPropy/)).toHaveCount(0);

  await bubble.click();
  await expect(page.getByPlaceholder(/Ask or tell iPropy/)).toBeVisible();
});
