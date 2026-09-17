/**
 * The pipeline breakdown, and the filter built from it.
 *
 * The thing worth a browser: picking stages has to reach the list as one
 * `in` condition. An AND of equals reads perfectly well in code and matches
 * nothing at all, and the screen shows that as an empty table rather than as
 * an error — which is the shape of bug that survives a green test suite.
 */
import { test, expect, type Page, type Request } from '@playwright/test';

function isListSearch(r: Request): boolean {
  if (!r.url().includes('/api/records/leads/search') || r.method() !== 'POST') return false;
  return Array.isArray(r.postDataJSON()?.columns);
}

async function openPanel(page: Page) {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  const trigger = page.getByRole('button', { name: /stages\)|picked\)/ }).first();
  await trigger.click();
  await expect(page.getByRole('heading', { name: /^Filter by / })).toBeVisible();
  return trigger;
}

test('the stages add up to the whole view', async ({ page }) => {
  await openPanel(page);

  const shares = await page.locator('[aria-pressed]').filter({ hasText: /%\s*·/ })
    .evaluateAll((els) => els.map((el) => Number(/([\d.]+)%/.exec(el.textContent ?? '')?.[1] ?? 0)));

  expect(shares.length).toBeGreaterThan(0);
  const sum = shares.reduce((a, b) => a + b, 0);
  // Rounded to one decimal per row, so the total lands near 100 rather than on it.
  expect(sum).toBeGreaterThan(99);
  expect(sum).toBeLessThan(101);
});

test('picking stages filters the list with one `in`, not an AND of equals', async ({ page }) => {
  await openPanel(page);

  const stages = page.locator('[aria-pressed]').filter({ hasText: /%\s*·/ });
  await stages.nth(0).click();
  await stages.nth(1).click();

  const search = page.waitForRequest(isListSearch);
  await page.getByRole('button', { name: 'Apply' }).click();

  const conditions = (await search).postDataJSON().filter?.conditions ?? [];
  const stageCondition = conditions.find((c: { operator?: string }) => c.operator === 'in');
  expect(stageCondition, JSON.stringify(conditions)).toBeTruthy();
  expect(stageCondition.value).toHaveLength(2);

  await expect(page.getByRole('button', { name: /2 picked\)/ })).toBeVisible();
});

test('reset puts every record back', async ({ page }) => {
  await openPanel(page);
  const stages = page.locator('[aria-pressed]').filter({ hasText: /%\s*·/ });
  await stages.nth(0).click();
  await page.getByRole('button', { name: 'Apply' }).click();

  const trigger = page.getByRole('button', { name: /1 picked\)/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole('button', { name: 'Reset' }).click();

  await expect(page.getByRole('button', { name: /stages\)/ })).toBeVisible();
});
