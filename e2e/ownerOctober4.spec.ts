import { expect, test } from '@playwright/test';

for (const module of ['leads', 'properties', 'associates']) {
  test(`${module}: created-today and favourites filters are available`, async ({ page }) => {
    await page.goto(`/${module}`);
    const chip = page.getByRole('button', { name: /^New \d/ });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/created_at/);
    const count = Number((await chip.innerText()).replace(/\D/g, ''));
    if (count === 0) {
      await expect(page.getByTestId('empty-workspace')).toBeVisible();
      await expect(page.getByTestId('ipropy-workspace')).toBeVisible();
    }
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('workspace-dock-folded').getByRole('link', { name: 'Favourites', exact: true }).click();
    await expect(page).toHaveURL(/favourite/);
    await expect(page.getByTestId('workspace-dock-folded').getByRole('link', { name: 'Favourites', exact: true })).toHaveClass(/bg-brand-100/);
  });
}

test('profile strength master offers field weights', async ({ page }) => {
  await page.goto('/admin/profile-strength');
  await expect(page.getByRole('heading', { name: 'Profile strength master' })).toBeVisible();
  await expect(page.getByLabel('Profile strength module')).toBeVisible();
  await expect(page.getByRole('spinbutton').first()).toBeVisible();
});

test('search options offers compact two-column defaults', async ({ page }) => {
  await page.goto('/leads');
  await page.getByRole('button', { name: 'Search options', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'CRM search options' });
  await expect(panel.getByTestId('default-search-fields')).toBeVisible();
  await expect(panel.getByText('Agent', { exact: true })).toBeVisible();
  await expect(panel.getByText('Location', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('Created date', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('Budget or demand maximum slider')).toBeVisible();
  await expect(panel.getByText(/No filters —/)).toHaveCount(0);
});

test('zero records keep the workspace and reset controls', async ({ page }) => {
  const filter = { logic: 'AND', conditions: [{ field: 'created_at', operator: 'less_than', value: '1900-01-01' }] };
  await page.goto(`/properties?filter=${encodeURIComponent(JSON.stringify(filter))}`);
  await expect(page.getByTestId('empty-workspace')).toBeVisible();
  await expect(page.getByTestId('queue-tools')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filters', exact: true }).click();
  await expect(page.getByTestId('queue-card').first()).toBeVisible();
});
