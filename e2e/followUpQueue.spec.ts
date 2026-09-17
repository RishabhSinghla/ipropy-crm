/**
 * The three follow-up buttons above the list.
 *
 * Two things a unit test cannot see. They must say the same three words the
 * row chips say — "Overdue", "Today", "Tomorrow" — because a row that reads
 * Overdue in red under a button that reads "Pending" in red is one fact
 * spoken twice in two languages.
 *
 * And picking a queue has to order it. Filtering alone left page one of
 * Overdue in whatever order the list already had, which on a real database is
 * an arbitrary hundred rows rather than the hundred most overdue. The
 * assertion is on the request the list actually sends, since the sort is
 * decided in the client and applied by the server.
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
});

test('the queues are named the way the rows are', async ({ page }) => {
  const bar = page.getByLabel('Follow-up tasks');
  await expect(bar.getByRole('button', { name: /^Overdue/ })).toBeVisible();
  await expect(bar.getByRole('button', { name: /^Today/ })).toBeVisible();
  await expect(bar.getByRole('button', { name: /^Tomorrow/ })).toBeVisible();
  // The words they replaced must be gone, not merely joined.
  await expect(bar.getByText(/Pending follow-up/)).toHaveCount(0);
});

test('picking a queue puts the most overdue first', async ({ page }) => {
  const search = page.waitForRequest((r) =>
    r.url().includes('/api/records/leads/search') && r.method() === 'POST'
    && JSON.stringify(r.postDataJSON()?.filter ?? '').includes('less_than'));

  await page.getByLabel('Follow-up tasks').getByRole('button', { name: /^Overdue/ }).click();

  const body = (await search).postDataJSON();
  expect(body.sortBy).toBe('next_followup_at');
  expect(body.sortDir).toBe('asc');
  await expect(page.getByText(/^[\d,]+ records?$/)).toBeVisible();
});

test('a sort the person chose is not taken away by a queue', async ({ page }) => {
  const sorted = page.waitForRequest((r) =>
    r.url().includes('/api/records/leads/search') && r.method() === 'POST'
    && Boolean(r.postDataJSON()?.sortBy));

  // Any column header will do; what matters is that the choice survives.
  await page.locator('thead th').nth(1).getByRole('button').first().click();
  const chosen = (await sorted).postDataJSON().sortBy as string;

  const queued = page.waitForRequest((r) =>
    r.url().includes('/api/records/leads/search') && r.method() === 'POST'
    && JSON.stringify(r.postDataJSON()?.filter ?? '').includes('less_than'));

  await page.getByLabel('Follow-up tasks').getByRole('button', { name: /^Overdue/ }).click();

  expect((await queued).postDataJSON().sortBy).toBe(chosen);
});
