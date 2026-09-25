/**
 * One control in the header instead of a row of tabs.
 *
 * Two things must survive the change, and neither is visible from the code:
 * the switcher has to name where you actually are — a header that says
 * "Dashboard" while you are reading Leads is worse than no header at all —
 * and it has to still reach every destination the tabs did, since those came
 * from the admin's own arrangement rather than a list in the app.
 */
import { test, expect, type Page } from '@playwright/test';

function trigger(page: Page) {
  return page.getByRole('button', { name: 'Switch module' });
}

test('it names the screen you are on', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  await expect(trigger(page)).toContainText('Leads');

  await page.goto('/dashboard');
  await expect(trigger(page)).toContainText('Dashboard', { timeout: 15_000 });
});

test('it opens every destination the tabs used to', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(trigger(page)).toBeVisible({ timeout: 30_000 });
  await trigger(page).click();

  // Dashboard plus at least one module — a switcher offering one place is a
  // switcher that has lost the modules.
  const links = page.getByRole('link').filter({ hasText: /\S/ });
  await expect(page.getByRole('link', { name: /Dashboard/ })).toBeVisible();
  expect(await links.count()).toBeGreaterThan(1);
});

test('choosing one goes there and the control follows', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(trigger(page)).toBeVisible({ timeout: 30_000 });
  await trigger(page).click();

  const leads = page.getByRole('link', { name: /Leads/ }).first();
  const label = (await leads.innerText()).split('\n')[0].trim();
  await leads.click();

  await expect(page).toHaveURL(/\/leads/);
  await expect(trigger(page)).toContainText(label);
  // And the menu closed behind it, rather than sitting over the list.
  await expect(page.getByRole('link', { name: /Dashboard/ })).toHaveCount(0);
});

test('it can be worked without a mouse', async ({ page }) => {
  await page.goto('/leads');
  await expect(trigger(page)).toBeVisible({ timeout: 30_000 });
  await trigger(page).focus();
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: /Dashboard/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: /Dashboard/ })).toHaveCount(0);
});
