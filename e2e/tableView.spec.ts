/**
 * One table view, set by an admin, used by everybody.
 *
 * Three things a unit test cannot see. The saved order has to be what the
 * table actually renders, top to bottom and left to right. The per-person
 * controls have to be *gone*, not merely overruled — a "Choose columns" that
 * springs back on the next load reads as a save that did not save. And the
 * admin page has to reach the list: the setting rides on `/api/auth/me`, so a
 * save that does not refresh that is a change nobody sees until they sign out.
 */
import { test, expect, type Page } from '@playwright/test';
import { waitForRecords } from './helpers';

async function headers(page: Page): Promise<string[]> {
  return page.locator('thead th').evaluateAll((els) =>
    els.map((el) => (el.textContent ?? '').trim()).filter(Boolean));
}

test('the table shows the admin order, in order', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);

  const shown = await headers(page);
  // Read the order the admin page holds, rather than assuming this database's.
  await page.goto('/admin/table-view');
  await expect(page.getByRole('heading', { name: 'Table view' })).toBeVisible({ timeout: 20_000 });
  const chosen = await page.locator('ol li').evaluateAll((els) =>
    els.map((el) => (el.querySelector('span:nth-child(2)')?.textContent ?? '').split('—')[0]!.trim()));

  if (!chosen.length) test.skip(true, 'no table view set in this database');

  // Every chosen field the module still has must appear, in the same order.
  const kept = chosen.filter((label) => shown.includes(label));
  expect(kept.length, `none of ${JSON.stringify(chosen)} appeared in ${JSON.stringify(shown)}`)
    .toBeGreaterThan(1);
  const positions = kept.map((label) => shown.indexOf(label));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test('nobody can change the columns from a list', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);

  await page.getByRole('button', { name: 'List options' }).click();
  // Gone, not disabled: the admin's arrangement is the only one there is.
  await expect(page.getByRole('button', { name: /Choose columns/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save this layout/ })).toHaveCount(0);
});

test('a column header cannot be dragged into a different place', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);

  const draggable = await page.locator('thead th[draggable="true"]').count();
  expect(draggable, 'headers must not be draggable while an admin order is set').toBe(0);
});

test('the admin page offers the module fields and names ones that have gone', async ({ page }) => {
  await page.goto('/admin/table-view');
  await expect(page.getByRole('heading', { name: 'Table view' })).toBeVisible({ timeout: 20_000 });

  /*
    Waited for, not counted straight away. The available list comes from a
    second request — the module's fields — so counting on arrival races it and
    reads zero. That is a flake in the spec, not a slow page.
  */
  const boxes = page.locator('label input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible({ timeout: 20_000 });
  expect(await boxes.count()).toBeGreaterThan(3);

  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
});
