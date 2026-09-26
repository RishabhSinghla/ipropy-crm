/**
 * The Calls page: what the team did, rather than what one customer did.
 *
 * Only a browser proves the two things that make it useful — that a filter
 * actually narrows the list (rather than the screen filtering nothing while
 * looking like it did), and that a call with a record behind it links to that
 * record, which is the whole point of a call log inside a CRM.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 950 } });

test('it lists calls and says how many match', async ({ page }) => {
  await page.goto('/calls');
  await expect(page.getByRole('heading', { name: 'Calls' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^[\d,]+ calls ·/)).toBeVisible({ timeout: 20_000 });
});

test('a filter narrows it, and the count follows', async ({ page }) => {
  await page.goto('/calls');
  await expect(page.getByText(/^[\d,]+ calls ·/)).toBeVisible({ timeout: 30_000 });
  const before = Number((await page.getByText(/^[\d,]+ calls ·/).innerText()).replace(/[^\d].*$/, '').replace(/,/g, ''));

  // Incoming only. This database is mostly outgoing, so the count has to fall
  // — a screen that filters nothing would leave it exactly where it was.
  //
  // `exact` because the breakdown donut beside the filters is labelled
  // "Direction: Outgoing 21, Incoming 5…" for screen readers, so a loose match
  // finds two elements and Playwright refuses the whole call. The chart being
  // described properly is the point of that label; the spec has to say which
  // control it means.
  await page.getByLabel('Direction', { exact: true }).selectOption('inbound');
  await expect(async () => {
    const after = Number((await page.getByText(/^[\d,]+ calls ·/).innerText()).replace(/[^\d].*$/, '').replace(/,/g, ''));
    expect(after).toBeLessThan(before);
  }).toPass({ timeout: 15_000 });
});

test('a call with a lead behind it opens that lead', async ({ page }) => {
  await page.goto('/calls');
  await expect(page.getByText(/^[\d,]+ calls ·/)).toBeVisible({ timeout: 30_000 });
  const link = page.locator('article a[href^="/leads/"]').first();
  if (!(await link.count())) test.skip(true, 'no call in this database is attached to a lead');
  await link.click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}/);
});
