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

/*
  The accordion this file was written against is gone. Fourteen groups that
  each opened and shut became a vertical tab strip: you pick a category and
  only that category is drawn. The concern that produced the file is unchanged
  and so are these tests' names — the page must not land on you as a wall —
  but "shut it again" is not a gesture a tab strip has, so that one now checks
  that picking another category puts the first one away.
*/

const tab = (page: import('@playwright/test').Page, name: RegExp) =>
  page.getByRole('tab', { name });

// The heading of the category currently drawn. Exactly one exists at a time,
// which is the whole claim the first test makes.
const openCategories = (page: import('@playwright/test').Page) =>
  page.getByRole('tabpanel').getByRole('heading', { level: 3 });

// The `setup` project signs in once and every spec inherits that session, so
// calling login() here would land on the dashboard and detach the form mid-fill.
test.beforeEach(async ({ page }) => {
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  // The heading renders before the settings do. Typing into the search box
  // while the list is still empty filters nothing and the assertion that
  // follows fails against a page that was merely not ready — which is what
  // made the search spec flaky in a full run, where a hundred specs share one
  // account and occasionally meet the rate limit on the way in.
  await expect(tab(page, /Your business/)).toBeVisible();
});

test('opens as a short list rather than a wall of settings', async ({ page }) => {
  // Every category is offered at once...
  expect(await page.getByRole('tab').count()).toBeGreaterThan(5);
  // ...and exactly one of them is drawn. This is the assertion the file exists
  // for: fourteen open groups is the page that felt heavy.
  await expect(openCategories(page)).toHaveCount(1);
});

test('opens a group when you click it, and closes it again', async ({ page }) => {
  // "Your business" is first, so it is the one showing on arrival.
  await expect(tab(page, /Your business/)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Street')).toBeVisible();

  await tab(page, /WhatsApp/).click();
  await expect(tab(page, /WhatsApp/)).toHaveAttribute('aria-selected', 'true');
  // Picking another category is what puts this one away.
  await expect(page.getByLabel('Street')).toBeHidden();
  await expect(openCategories(page)).toHaveCount(1);
});

test('a search opens whatever it found', async ({ page }) => {
  // The reason one-at-a-time is safe: nobody has to guess which category a
  // setting lives in, they type what it is called.
  await page.getByPlaceholder('Search settings').fill('currency');

  await expect(page.getByText('Default Currency')).toBeVisible();
  // And the categories that do not match are gone rather than merely unpicked.
  await expect(tab(page, /WhatsApp/)).toBeHidden();
});

test('says which group holds an unsaved change, even while it is shut', async ({ page }) => {
  const currency = page.getByLabel('Default Currency');
  await currency.fill('USD');

  // The row says so itself, and the save bar counts it. The bar follows you
  // across categories, which is the stronger version of what this test used to
  // ask of a collapsed group header.
  await expect(page.getByText('1 unsaved change', { exact: true })).toBeVisible();

  await tab(page, /WhatsApp/).click();
  await expect(page.getByText('1 unsaved change', { exact: true })).toBeVisible();

  // And it is still there, still marked, when you come back to it.
  await tab(page, /Your business/).click();
  await expect(page.getByLabel('Default Currency')).toHaveValue('USD');
});
