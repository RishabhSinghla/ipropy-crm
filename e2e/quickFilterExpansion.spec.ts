import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

for (const module of ['leads', 'properties', 'associates']) {
  test(`${module}: long filter choices expand, collapse and align coloured labels`, async ({ page }) => {
    // Isolated metadata fixture: do not depend on the database having 139 localities.
    await page.route(`**/api/meta/modules/${module}`, async (route) => {
      const response = await route.fetch();
      const metadata = await response.json();
      const locality = metadata.fields.find((field: { name: string }) => field.name === 'locality');
      expect(locality).toBeTruthy();
      locality.options = Array.from({ length: 8 }, (_, index) => ({
        value: `expansion-fixture-${index}`, label: `Expansion locality ${index}`,
        color: index === 1 ? '#22c55e' : null,
      }));
      await route.fulfill({ response, json: metadata });
    });
    await page.goto(`/${module}`);
    await page.getByTestId('quick-filter-button').click();
    const panel = page.getByTestId('quick-filter-overlay');
    await expect(panel).toBeVisible();
    const section = panel.locator('section').filter({ has: page.getByRole('button', { name: 'Locality', exact: true }) });
    const heading = section.getByRole('button', { name: 'Locality', exact: true });
    if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click();
    const rows = section.getByRole('button', { name: /^Expansion locality/ });
    await expect(rows).toHaveCount(5);
    await section.getByRole('button', { name: /more — show all/ }).click();
    await expect(rows).toHaveCount(8);
    const positions = await rows.evaluateAll((buttons) => buttons.map((button) => button.querySelector('.truncate')!.getBoundingClientRect().left));
    expect(new Set(positions).size, 'coloured and uncoloured labels start in the same column').toBe(1);
    await section.getByRole('button', { name: 'Show fewer' }).click();
    await expect(rows).toHaveCount(5);
    await section.getByRole('textbox', { name: 'Search this filter' }).fill('Expansion locality 7');
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveText(/Expansion locality 7/);
  });
}
