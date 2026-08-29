/**
 * The settings screen, from the seat of the person who has to use it.
 *
 * The feedback that produced this file was not about a bug: "visiting this page
 * feels like a pressure that something heavy is there". Fourteen groups drawn
 * open at once is a page you land on and immediately have to scroll, and no
 * assertion about correctness would ever have caught that.
 *
 * So these check the shape of the page rather than its values: it opens short,
 * it opens what you search for, and a group you have opened stays open while you
 * work in it.
 */
import { test, expect } from '@playwright/test';

// The `setup` project signs in once and every spec inherits that session, so
// calling login() here would land on the dashboard and detach the form mid-fill.
test.beforeEach(async ({ page }) => {
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});

test('opens as a short list rather than a wall of settings', async ({ page }) => {
  // Every group is a button you can see; none of their contents are.
  const groups = page.getByRole('button', { expanded: false });
  expect(await groups.count()).toBeGreaterThan(5);

  // "Your business" is the first group and holds the address. Shut, so the page
  // is a list of headings.
  await expect(page.getByRole('button', { name: /Your business/ })).toBeVisible();
  await expect(page.getByLabel('Street')).toBeHidden();
});

test('opens a group when you click it, and closes it again', async ({ page }) => {
  const business = page.getByRole('button', { name: /Your business/ });

  await business.click();
  await expect(page.getByLabel('Street')).toBeVisible();
  await expect(business).toHaveAttribute('aria-expanded', 'true');

  await business.click();
  await expect(page.getByLabel('Street')).toBeHidden();
});

test('a search opens whatever it found', async ({ page }) => {
  // The reason closed-by-default is safe: nobody has to guess which group a
  // setting lives in, they type what it is called.
  await page.getByPlaceholder('Search settings').fill('currency');

  await expect(page.getByText('Default Currency')).toBeVisible();
  // And the groups that do not match are gone rather than merely shut.
  await expect(page.getByRole('button', { name: /WhatsApp/ })).toBeHidden();
});

test('says which group holds an unsaved change, even while it is shut', async ({ page }) => {
  const business = page.getByRole('button', { name: /Your business/ });
  await business.click();

  const currency = page.getByLabel('Default Currency');
  await currency.fill('USD');
  await expect(business).toContainText('changed');

  // Shutting the group must not hide the fact that something is unsaved in it.
  await business.click();
  await expect(business).toContainText('changed');
});
