/**
 * How full a record is, shown on the row and on the record.
 *
 * The one thing only a browser can answer: the list and the record page must
 * agree. The list draws its ring from the values the *list* endpoint returned,
 * the record page from the values the *record* endpoint returned. If the list
 * were sending back only the visible columns, every row would read far emptier
 * than the record it opens, and the number would quietly be a lie.
 */
import { test, expect } from '@playwright/test';

test('the row and the record report the same strength', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

  const firstRow = page.locator('tbody tr').first();
  const ring = firstRow.getByRole('img', { name: /^Form strength/ });
  await expect(ring).toBeVisible();

  const rowLabel = await ring.getAttribute('aria-label');
  const rowPercent = Number(/(\d+)%/.exec(rowLabel ?? '')?.[1]);
  expect(Number.isFinite(rowPercent)).toBe(true);

  // Open the record the same row points at. Rows open in a new tab by design.
  const opened = page.context().waitForEvent('page').catch(() => null);
  await firstRow.locator('td').nth(1).click();
  const detail = (await opened) ?? page;
  await detail.waitForLoadState('domcontentloaded');

  const detailRing = detail.getByRole('img', { name: /^Form strength/ }).first();
  await expect(detailRing).toBeVisible({ timeout: 30_000 });
  const detailPercent = Number(/(\d+)%/.exec((await detailRing.getAttribute('aria-label')) ?? '')?.[1]);

  expect(detailPercent).toBe(rowPercent);
});

test('the number is spoken, not only drawn', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

  const label = await page.locator('tbody tr').first()
    .getByRole('img', { name: /^Form strength/ }).getAttribute('aria-label');

  // Either it is complete, or it names what would raise it — never a bare number.
  expect(label).toMatch(/Form strength \d+% — (nothing left to fill in|still missing .+)/);
});
