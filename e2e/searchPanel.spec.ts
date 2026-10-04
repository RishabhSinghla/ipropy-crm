/**
 * The search panel in a real browser.
 *
 * **4 October 2026, the owner, with a design of it:** *"We need search as a
 * more/much dynamic in the Main/top toolbar, we can search everything, the result
 * shown in list. by source of result and last search also shown in below … we
 * want word's all dynamic features in this search, means most advance label
 * search engine of our crm."*
 *
 * Four promises, each of which is only visible in a browser: the answers are
 * grouped by the module they came from with a count, **↑ ↓** walk them and **↵**
 * opens the one that is highlighted, the last searches sit under an empty box,
 * and the × forgets one.
 *
 * The highlight is asserted through `aria-selected`, which is also what a screen
 * reader announces — a highlight drawn only with a background colour is one a
 * keyboard user cannot follow.
 */
import { expect, test } from '@playwright/test';

/** Two characters is the floor, below which the panel deliberately asks nothing. */
const TERM = 'ar';

test('groups the answers by module, with a count and a way to the full list', async ({ page }) => {
  await page.goto('/dashboard');
  const box = page.getByPlaceholder('Search everything…');
  await box.click();
  await box.fill(TERM);

  const panel = page.locator('#global-search-results');
  await expect(panel).toBeVisible();
  const heading = panel.locator('.sticky').first();
  await expect(heading).toBeVisible();

  // The count is a number, and "See all" is the way to that module's own list
  // with the same words in its box — not a new screen nobody maintains.
  await expect(heading).toHaveText(/\d+/);
  await expect(heading.getByRole('button', { name: 'See all' })).toBeVisible();
});

test('↑↓ walk the answers and ↵ opens the highlighted one', async ({ page }) => {
  await page.goto('/dashboard');
  const box = page.getByPlaceholder('Search everything…');
  await box.click();
  await box.fill(TERM);
  // Wait for a row, not only for the panel: the panel opens with a spinner in
  // it, and pressing ↓ at a spinner proves nothing about walking a list.
  await expect(page.locator('#global-search-results .sticky').first()).toBeVisible();

  await box.press('ArrowDown');
  const selected = page.locator('#global-search-results [aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const name = await selected.first().locator('span').first().textContent();

  await box.press('Enter');
  await page.waitForURL(/\/(leads|properties)\/[0-9a-f-]{36}/);
  // The record that opened is the one that was highlighted, not whichever
  // happened to be first — ↵ opening a different row from the one on screen is
  // the whole reason the flat order is derived from the groups.
  if (name) await expect(page.locator('main')).toContainText(name.trim().slice(0, 12));
});

test('remembers the last search under an empty box, and the × forgets it', async ({ page }) => {
  await page.goto('/dashboard');
  const box = page.getByPlaceholder('Search everything…');
  await box.click();
  await box.fill(TERM);
  await expect(page.locator('#global-search-results .sticky').first()).toBeVisible();
  // Remembered when it is acted on, never per keystroke.
  await box.press('ArrowDown');
  await box.press('Enter');
  await page.waitForURL(/\/(leads|properties)\/[0-9a-f-]{36}/);

  await page.goto('/dashboard');
  await page.getByPlaceholder('Search everything…').click();
  const recent = page.getByTestId('search-recent');
  await expect(recent).toContainText(TERM);

  await recent.getByRole('button', { name: /^Forget/ }).first().click();
  // Gone, and with nothing left to show the panel goes with it rather than
  // standing there empty.
  await expect(page.getByTestId('search-recent')).toHaveCount(0);
});

test('the brand mark sits inside the header with room above and below', async ({ page }) => {
  /*
    *"Company Profile Logo, Poor Alignment & Size adjustment."* A ring is drawn
    outside the box, so the old circle plus its ring was taller than the row's own
    padding allowed and pressed against both edges. Measured rather than read off
    a class name: a class that is present while the mark still overflows is
    exactly the bug.
  */
  await page.goto('/dashboard');
  const mark = page.getByTestId('brand-mark');
  await expect(mark).toBeVisible();
  const box = (await mark.boundingBox())!;
  const header = (await page.locator('header').first().boundingBox())!;
  expect(box.y).toBeGreaterThan(header.y);
  expect(box.y + box.height).toBeLessThan(header.y + header.height);
});
