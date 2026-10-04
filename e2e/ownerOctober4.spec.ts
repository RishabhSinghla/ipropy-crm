import { expect, test } from '@playwright/test';

for (const module of ['leads', 'properties', 'associates']) {
  test(`${module}: created-today and favourites filters are available`, async ({ page }) => {
    await page.goto(`/${module}`);
    const chip = page.getByRole('button', { name: /New today/ });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/created_at/);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('link', { name: 'Favourites', exact: true }).filter({ visible: true }).click();
    await expect(page).toHaveURL(/favourite/);
  });
}

test('profile strength master offers field weights', async ({ page }) => {
  await page.goto('/admin/profile-strength');
  await expect(page.getByRole('heading', { name: 'Profile strength master' })).toBeVisible();
  await expect(page.getByLabel('Profile strength module')).toBeVisible();
  await expect(page.getByRole('spinbutton').first()).toBeVisible();
});
