import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ viewport: { width: 1500, height: 900 } });

test('Tools opens from the bottom dock and calculates all loan types', async ({ page }) => {
  await page.goto('/dashboard');
  // The hover transition must not replace the link or swallow its click.
  await page.getByTestId('workspace-dock-folded').getByRole('link', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Business tools' })).toBeVisible();
  for (const name of ['EMI calculator', 'Car loan', 'Personal loan']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByLabel('Loan principal (₹)').fill('100');
    await page.getByLabel('Annual interest (%)').fill('0');
    await page.getByLabel('Duration (months)').fill('3');
    const report = page.locator('#calculator-report');
    await expect(report.locator('tbody tr')).toHaveCount(3);
    await expect(report.locator('tbody tr').last()).toContainText('33.34');
    await expect(report.locator('tbody tr').last().locator('td').last()).toHaveText('0.00');
  }
});

test('download PDF contains the entire monthly schedule', async ({ page }) => {
  await page.goto('/tools');
  await page.getByLabel('Annual interest (%)').fill('8.5');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const pdf = await readFile(path!, 'ascii');
  expect(pdf).toContain('%PDF-1.4');
  expect(pdf).toContain('240 months');
  expect(pdf).toContain('Total interest');
  expect(pdf).toContain('  240');
});

test('builder floor editable charges match the reference sheet', async ({ page }) => {
  await page.goto('/tools');
  await page.getByRole('button', { name: 'Builder floor & charges', exact: true }).click();
  await page.getByLabel('Calculation area (sq.ft)').fill('1612.5');
  await page.getByLabel('Registry value for stamp duty (₹)').fill('11500000');
  await page.getByLabel('Registration fee base (₹)').fill('10000000');
  await expect(page.locator('#calculator-report')).toContainText('9,49,284.00');
  await page.getByLabel('Flat cost / deal amount (₹)').fill('5000000');
  await expect(page.locator('#calculator-report')).toContainText('59,49,284.00');
  await page.getByRole('button', { name: 'Add charge', exact: true }).click();
  await page.getByLabel('Additional charge rate', { exact: true }).fill('1000');
  await expect(page.locator('#calculator-report')).toContainText('59,50,284.00');
});
