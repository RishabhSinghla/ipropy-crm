import { expect, test } from '@playwright/test';

test('tag counts use the facet response and Unfilled is selectable', async ({ page }) => {
  await page.route('**/api/tags*', async (route) => {
    await route.fulfill({ json: [{ id: 'fixture-tag', name: 'scoped-test-tag', color: null, modules: [], usage_count: 999 }] });
  });
  await page.route('**/api/records/leads/facet?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('field') !== 'record_tags') return route.continue();
    await route.fulfill({ json: { values: [{ value: 'scoped-test-tag', label: 'scoped-test-tag', count: 7 }], blank: 3 } });
  });
  await page.goto('/leads');
  await page.getByTestId('quick-filter-button').click();
  const panel = page.getByTestId('quick-filter-overlay');
  const heading = panel.getByRole('button', { name: 'Tag wise', exact: true });
  if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click();
  const section = panel.getByTestId('quick-filter-tags');
  await expect(section.getByRole('button', { name: /scoped-test-tag/ })).toContainText('7');
  await expect(section.getByRole('button', { name: /Unfilled/ })).toContainText('3');
  await section.getByRole('button', { name: /Unfilled/ }).click();
  await expect(section.getByRole('button', { name: /Unfilled/ })).toHaveAttribute('aria-pressed', 'true');
});
