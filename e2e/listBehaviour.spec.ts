/**
 * Two switches that decide how safe a list is to work through.
 *
 * Both exist because of one screenshot: a phone number on the leads list, turned
 * into an edit box by a click that was only meant to read the row. "Chances of
 * accidentally updating something is very much" — and the risk is asymmetric. A
 * mistyped mobile on a live lead costs a customer; the saving was one click.
 *
 * So inline editing ships off, opening in a new tab ships on, and both are
 * settings rather than opinions baked into React.
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: /Leads/ })).toBeVisible();
});

test('clicking a value in the list does not turn it into an edit box', async ({ page }) => {
  const cell = page.getByRole('cell').filter({ hasText: /^\+91/ }).first();
  await expect(cell).toBeVisible();

  await cell.click();
  // The whole point: no input appears where the value was.
  await expect(cell.locator('input')).toHaveCount(0);
});

test('a record opens in a new tab, leaving the list where it was', async ({ page, context }) => {
  const listUrl = page.url();

  const opened = context.waitForEvent('page');
  // The whole <tr> carries the click, so target the record-number cell: it holds
  // no link, no checkbox and nothing else that would swallow the event.
  await page.getByRole('row').nth(1).getByRole('cell').nth(1).click();

  const tab = await opened;
  await tab.waitForLoadState('domcontentloaded');
  expect(tab.url()).toMatch(/\/leads\/[0-9a-f-]{36}/);

  // And the list is untouched: same URL, same filters, same place.
  expect(page.url()).toBe(listUrl);
  await tab.close();
});
