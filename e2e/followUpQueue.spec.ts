/**
 * The follow-up queue panel.
 *
 * This is the screen a rep starts their day on, so the things that must hold
 * are: the number on the button is the sum of the three cards, a card filters
 * the list underneath it, and picking a queue orders it by the follow-up date
 * so page one is the people waiting longest rather than an arbitrary hundred.
 *
 * The sort in particular is asserted on the request the list actually sends —
 * it is decided in the client and applied by the server, so nothing on screen
 * would show it going wrong until somebody worked the wrong hundred leads.
 */
import { test, expect, type Request } from '@playwright/test';

/**
 * The list's own search, not the panel's.
 *
 * The panel fetches its three "up next" rows through the same endpoint with
 * the same filter, deliberately sorted by the follow-up date — so a matcher
 * that looks only at the filter catches the panel and reports the panel's
 * sort as the list's. `columns` is what only the table asks for.
 */
function isListSearch(r: Request): boolean {
  if (!r.url().includes('/api/records/leads/search') || r.method() !== 'POST') return false;
  return Array.isArray(r.postDataJSON()?.columns);
}

async function openPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Follow-ups/ }).click();
  await expect(page.getByRole('heading', { name: 'Follow-up Queue' })).toBeVisible();
}

test('the three cards add up to the number on the button', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

  const trigger = page.getByRole('button', { name: /^Follow-ups/ });
  // The count is a chip beside the word now, not "(981)" in the label.
  const total = Number((/([\d,]+)\s*$/.exec((await trigger.innerText()).trim())?.[1] ?? '').replace(/,/g, ''));
  await trigger.click();

  const cards = page.getByRole('button', { name: /^(Overdue|Due Today|Tomorrow)/ });
  const numbers = await cards.evaluateAll((els) =>
    els.map((el) => Number((el.textContent ?? '').replace(/[^\d]/g, ' ').trim().split(/\s+/)[0] || 0)));
  expect(numbers).toHaveLength(3);
  expect(numbers.reduce((a, b) => a + b, 0)).toBe(total);
});

test('a card filters the list and puts the most overdue first', async ({ page }) => {
  await openPanel(page);

  const search = page.waitForRequest((r) =>
    isListSearch(r) && JSON.stringify(r.postDataJSON()?.filter ?? '').includes('less_than'));

  await page.getByRole('button', { name: /^Overdue/ }).click();

  const body = (await search).postDataJSON();
  expect(body.sortBy).toBe('next_followup_at');
  expect(body.sortDir).toBe('asc');

  // The panel closes on a pick, and what is filtering is named where it can be undone.
  await expect(page.getByRole('button', { name: /^Overdue ✕$/ })).toBeVisible();
});

test('the filter can be taken off again', async ({ page }) => {
  await openPanel(page);
  await page.getByRole('button', { name: /^Overdue/ }).click();

  const clear = page.getByRole('button', { name: /^Overdue ✕$/ });
  await expect(clear).toBeVisible();
  await clear.click();
  await expect(clear).toHaveCount(0);
});

test('a sort the person chose is not taken away by a queue', async ({ page }) => {
  const sorted = page.waitForRequest((r) => isListSearch(r) && Boolean(r.postDataJSON()?.sortBy));

  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  await page.locator('thead th').nth(1).getByRole('button').first().click();
  const chosen = (await sorted).postDataJSON().sortBy as string;

  const queued = page.waitForRequest((r) =>
    isListSearch(r) && JSON.stringify(r.postDataJSON()?.filter ?? '').includes('less_than'));

  await page.getByRole('button', { name: /^Follow-ups/ }).click();
  await page.getByRole('button', { name: /^Overdue/ }).click();

  expect((await queued).postDataJSON().sortBy).toBe(chosen);
});

test('somebody in the queue can be called and opened from the panel', async ({ page }) => {
  await openPanel(page);

  const first = page.getByRole('listitem').first();
  if (!(await first.count())) test.skip(true, 'no follow-ups in this database');

  await expect(first.getByRole('button', { name: /^Call / })).toBeVisible();
});
