import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

test('archive navigation, retained record links, and compact queue controls', async ({ page }) => {
  await page.goto('/leads');
  const card = page.getByTestId('queue-card').first();
  await expect(card).toBeVisible();
  await expect(card.getByRole('checkbox')).toBeVisible();
  const toolbar = page.locator('[data-main-toolbar]');
  await expect(toolbar).toHaveClass(/bg-brand-800/);
  await expect(page.getByRole('button', { name: 'Next record in list', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next record in list', exact: true }).click();
  await expect(page).toHaveURL(/open=/);
  await page.screenshot({ path: '/private/tmp/ipropy-archive-queue.png', fullPage: false });
  await page.goto('/archive');
  await expect(page.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible();
  await expect(page.getByLabel('Archived module')).toBeVisible();
  await expect(page.getByLabel('Search archived records')).toBeVisible();
  await expect(page.getByText(/retained without automatic deletion/)).toBeVisible();
  await page.screenshot({ path: '/private/tmp/ipropy-archive-page.png', fullPage: false });
});
