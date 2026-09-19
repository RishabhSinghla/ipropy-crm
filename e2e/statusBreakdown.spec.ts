/**
 * The pipeline breakdown, and the filter built from it.
 *
 * Three things only a browser answers. Picking stages has to reach the list as
 * one `in` condition — an AND of equals reads perfectly well in code and
 * matches nothing, and the screen shows that as an empty table rather than as
 * an error. One stage is one click, because that is the nine-times-in-ten
 * case and making it cost an Apply is the difference between a filter people
 * use and one they do not. And the agent chips have to reshape the counts,
 * not merely filter the rows underneath.
 */
import { test, expect, type Page, type Request } from '@playwright/test';

function isListSearch(r: Request): boolean {
  if (!r.url().includes('/api/records/leads/search') || r.method() !== 'POST') return false;
  return Array.isArray(r.postDataJSON()?.columns);
}

/** The stage rows, which are the pressable rows carrying a percentage. */
function stages(page: Page) {
  return page.locator('[aria-pressed]').filter({ hasText: /\d+\.\d%/ });
}

async function openPanel(page: Page) {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  const trigger = page.getByRole('button', { name: /\d+ stages|\d+ picked/ }).first();
  await trigger.click();
  await expect(page.getByRole('heading', { name: /breakdown$/i })).toBeVisible();
  return trigger;
}

test('the stages add up to the whole view', async ({ page }) => {
  await openPanel(page);

  const shares = await stages(page)
    .evaluateAll((els) => els.map((el) => Number(/([\d.]+)%/.exec(el.textContent ?? '')?.[1] ?? 0)));

  expect(shares.length).toBeGreaterThan(0);
  const sum = shares.reduce((a, b) => a + b, 0);
  // Rounded to one decimal per row, so the total lands near 100 rather than on it.
  expect(sum).toBeGreaterThan(99);
  expect(sum).toBeLessThan(101);
});

test('one stage is one click, and it reaches the list as an `in`', async ({ page }) => {
  await openPanel(page);

  const search = page.waitForRequest(isListSearch);
  await stages(page).first().click();

  const conditions = (await search).postDataJSON().filter?.conditions ?? [];
  const stage = conditions.find((c: { operator?: string }) => c.operator === 'in');
  expect(stage, JSON.stringify(conditions)).toBeTruthy();
  expect(stage.value).toHaveLength(1);

  await expect(page.getByRole('button', { name: /1 picked/ })).toBeVisible();
});

test('several stages need the checkbox, then Apply', async ({ page }) => {
  await openPanel(page);

  // Apply is refused until multi-select is on, so one stray click cannot
  // silently replace the single-click behaviour above.
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Select multiple stages/ }).check();

  await stages(page).nth(0).click();
  await stages(page).nth(1).click();

  const search = page.waitForRequest(isListSearch);
  await page.getByRole('button', { name: 'Apply' }).click();

  const stage = ((await search).postDataJSON().filter?.conditions ?? [])
    .find((c: { operator?: string }) => c.operator === 'in');
  expect(stage.value).toHaveLength(2);
  await expect(page.getByRole('button', { name: /2 picked/ })).toBeVisible();
});

test('picking an agent filters the list and reshapes the counts', async ({ page }) => {
  await openPanel(page);

  const agents = page.locator('[aria-pressed]').filter({ hasText: /^[A-Za-z]+$/ });
  if ((await agents.count()) === 0) test.skip(true, 'only one assignable user here');

  const before = await stages(page)
    .evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, '')));

  const search = page.waitForRequest(isListSearch);
  await agents.first().click();

  const owner = ((await search).postDataJSON().filter?.conditions ?? [])
    .find((c: { operator?: string; field?: string }) => c.operator === 'equals');
  expect(owner, 'the agent must reach the list as its own condition').toBeTruthy();

  // The panel stays open on an agent pick — the point is to read their shape.
  await expect(page.getByRole('heading', { name: /breakdown$/i })).toBeVisible();
  await expect
    .poll(async () => (await stages(page).evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, '')))).join('|'))
    .not.toBe(before.join('|'));
});

test('all stages puts every record back', async ({ page }) => {
  await openPanel(page);
  await stages(page).first().click();
  await expect(page.getByRole('button', { name: /1 picked/ })).toBeVisible();

  await page.getByRole('button', { name: /1 picked/ }).click();
  await page.getByRole('button', { name: /^All stages/ }).click();
  await expect(page.getByRole('button', { name: /\d+ stages/ })).toBeVisible();
});
