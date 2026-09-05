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
  // The list no longer paints its own title — the toolbar starts at the left
  // edge and the module name lives in the sidebar (the h1 is still there, for
  // screen readers, but asserting on an sr-only node proves nothing about what
  // a user can see). The record count is the honest "the data arrived" signal.
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
});

test('clicking a value in the list does not turn it into an edit box', async ({ page }) => {
  const cell = page.getByRole('cell').filter({ hasText: /^\+91/ }).first();
  await expect(cell).toBeVisible();

  await cell.click();
  // The whole point: no input appears where the value was.
  await expect(cell.locator('input')).toHaveCount(0);
});

test('a record opens in a new tab, leaving the list where it was', async ({ page, context }) => {
  // The list mirrors its state into the URL once the active view resolves —
  // a beat after the heading appears (ListView's setSearchParams with
  // replace:true writes ?view=…&sort=… for the default view). Capturing
  // "where the list was" before that lands races the mirror: the click then
  // looks like it moved the list when the mirror merely caught up. Wait for
  // the URL to hold still first.
  const listUrl = await (async () => {
    let url = page.url();
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(250);
      const next = page.url();
      if (next === url) return url;
      url = next;
    }
    return url;
  })();

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
