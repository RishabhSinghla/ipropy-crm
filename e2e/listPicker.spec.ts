/**
 * Choosing what the list shows: a saved list, or a tag.
 *
 * Tags were reachable only through the filter dialog, which meant knowing the
 * filter grammar to answer "show me the ones I marked". They answer the same
 * question the saved lists do, so they live in the same picker now.
 *
 * The one thing only a browser proves: a tag is not a field on the module, so
 * it cannot be sent as one. It has to reach the server as `record_tags` with
 * `has_any` — send it as a field name and the request is refused, or worse,
 * silently matches nothing.
 */
import { test, expect, type Page, type Request } from '@playwright/test';

function isListSearch(r: Request): boolean {
  if (!r.url().includes('/api/records/leads/search') || r.method() !== 'POST') return false;
  return Array.isArray(r.postDataJSON()?.columns);
}

async function openPicker(page: Page) {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Choose or manage list views/ }).click();
  await expect(page.getByText('Select list or tag')).toBeVisible();
}

test('lists and tags are both in the one picker', async ({ page }) => {
  await openPicker(page);
  // One tag section, not two. The owner asked for the "shared tags" split
  // gone on 19 September — every tag is readable by everybody, so who typed
  // the name first was never a useful division. `exact` because the empty
  // state ("No tags found") would otherwise match the heading too.
  await expect(page.getByText('Tags', { exact: true })).toBeVisible();
  await expect(page.getByText('Shared tags', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^All Leads/ })).toBeVisible();
});

test('the search box narrows lists and tags together', async ({ page }) => {
  await openPicker(page);
  const box = page.getByPlaceholder('Search for lists and tags');

  await box.fill('zzz-nothing-matches-this');
  await expect(page.getByText(/Nothing matches/)).toBeVisible();

  await box.fill('');
  await expect(page.getByRole('button', { name: /^All Leads/ })).toBeVisible();
});

test('a tag filters the list as `record_tags`, not as a field', async ({ page }) => {
  await openPicker(page);

  const tag = page.locator('[aria-pressed="false"]').filter({ hasText: /^[a-z][a-z -]+\d*$/ }).last();
  if (!(await tag.count())) test.skip(true, 'no tags in this database');
  const name = (await tag.innerText()).split('\n')[0].trim();

  const search = page.waitForRequest(isListSearch);
  await tag.click();

  const conditions = (await search).postDataJSON().filter?.conditions ?? [];
  const tagCondition = conditions.find((c: { field?: string }) => c.field === 'record_tags');
  expect(tagCondition, JSON.stringify(conditions)).toBeTruthy();
  expect(tagCondition.operator).toBe('has_any');
  expect(tagCondition.value).toEqual([name]);

  // The button says what is being shown, so the filter is never invisible.
  await expect(page.getByRole('button', { name: /Choose or manage list views/ })).toContainText(name);
});

test('a list can be acted on from its own row', async ({ page }) => {
  await openPicker(page);

  await page.getByRole('button', { name: /^Actions for All Leads$/ }).click();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Duplicate' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Set as default/ })).toBeVisible();

  // A built-in list cannot be deleted or unshared — it is everybody's.
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

test('choosing a list clears a tag, and the two do not stack', async ({ page }) => {
  await openPicker(page);
  const full = await page.getByText(/^[\d,]+ of [\d,]+ records$/).innerText();

  const tag = page.locator('[aria-pressed="false"]').filter({ hasText: /^[a-z][a-z -]+\d*$/ }).last();
  if (!(await tag.count())) test.skip(true, 'no tags in this database');
  const name = (await tag.innerText()).split('\n')[0].trim();
  await tag.click();

  const trigger = page.getByRole('button', { name: /Choose or manage list views/ });
  await expect(trigger).toContainText(name);

  await trigger.click();
  await page.getByRole('button', { name: /^All Leads/ }).click();

  /*
    Asserted on what the screen says, not on a request. Going back to the list
    you were already on restores a query React Query still holds, so there is
    no network call to wait for — and the bug this guards against is the tag
    surviving underneath a list, which shows as the count staying narrowed.
  */
  await expect(trigger).not.toContainText(name);
  await expect(page.getByText(/^[\d,]+ of [\d,]+ records$/)).toHaveText(full);
});
