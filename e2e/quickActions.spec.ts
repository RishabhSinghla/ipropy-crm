/**
 * Calling somebody from the list without opening them first.
 *
 * Ringing a row you already recognise used to cost an open, a read and a back.
 * The button sits in a column pinned to the right of every row.
 *
 * Two failures worth a browser, neither of which a unit test or typecheck can
 * see. The row itself opens the record, so an action button that does not stop
 * the click rings the number *and* navigates away. And this screen returns
 * early while its module loads — anything added below those guards as a hook
 * changes the hook count between renders and takes the whole list to an error
 * boundary the moment the data arrives. That one shipped once; this spec is
 * what caught it.
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
});

test('the quick actions reach a row without opening it', async ({ page }) => {
  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toBeVisible();

  const call = firstRow.getByRole('button', { name: /^Call / });

  // A module whose records carry no phone shows no action, and that is
  // correct rather than a failure — skip instead of asserting a wrong thing.
  if (!(await call.count())) test.skip(true, 'no phone on these records');

  await firstRow.hover();
  await expect(call).toBeVisible();

  // `tel:` leaves the page to the OS, so the assertion is that the CRM stays
  // put: the list URL is unchanged and no record detail opened underneath.
  const before = page.url();
  await call.click();
  await expect(page).toHaveURL(before);
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible();
});

test('they are reachable by keyboard, not only by hover', async ({ page }) => {
  const firstRow = page.locator('tbody tr').first();
  const call = firstRow.getByRole('button', { name: /^Call / });
  if (!(await call.count())) test.skip(true, 'no phone on these records');

  // Faded, not removed: `display:none` would take these out of the tab order
  // and somebody working a queue by keyboard needs them as much as a mouse user.
  await call.focus();
  await expect(call).toBeFocused();
});

test('the row still opens when the row itself is clicked', async ({ page, context }) => {
  const firstRow = page.locator('tbody tr').first();

  /*
    Opening in a new tab is this CRM's default and deliberately so — a rep
    working a queue keeps the list. So the record may arrive as a popup rather
    than as navigation, and asserting only on this page's URL would fail on
    correct behaviour. Either outcome proves the row still opens, which is all
    this needs to say: the actions column must not have swallowed the click.
  */
  const opened = Promise.race([
    context.waitForEvent('page').then((p) => p.url()),
    page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 15_000 }).then(() => page.url()),
  ]);
  await firstRow.locator('td').nth(1).click();
  expect(await opened).toMatch(/\/leads\/[0-9a-f-]{36}/);
});
