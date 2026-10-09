import { test, expect } from '@playwright/test';

test('Facebook assignment master saves one agent and round robin without changing existing contacts', async ({ page }) => {
  await page.goto('/admin/integrations');
  await page.getByRole('button', { name: 'All settings', exact: true }).click();
  const master = page.getByTestId('facebook-lead-master');
  await expect(master).toBeVisible();
  await expect(master.getByText('Existing contacts keep their current owner.', { exact: false })).toBeVisible();
  const mode = master.getByLabel('Assignment method');
  await mode.selectOption('specific_user');
  const agents = master.locator('input[name="facebook-agent"]:not(:disabled)');
  await expect(agents.first()).toBeVisible();
  await agents.first().check();
  await master.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await expect(page.getByText('Facebook assignment saved — applies to new contacts only')).toBeVisible();
  await mode.selectOption('round_robin');
  await agents.first().check();
  await agents.nth(1).check();
  await master.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await expect(master.getByText('2 selected.', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'All settings', exact: true }).click();
  await expect(page.getByTestId('facebook-lead-master').getByLabel('Assignment method')).toHaveValue('round_robin');
  await expect(page.getByTestId('facebook-lead-master').getByText('2 selected.', { exact: false })).toBeVisible();
});
