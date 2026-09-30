/**
 * The Layout Designer changes the split view — every control it offers.
 *
 * **29 September 2026:** the owner called the designer unusable, and the root
 * of it was that several of its controls were saved and then ignored by the
 * split view (the tabs, the tab a record opens on, the pinned key facts).
 * This walks the round trip a person would: change them, save, open the list,
 * see them; press Default, save, see the shipped screen again.
 *
 * It writes the shared Leads layout, so it always puts it back.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
// Two saves and three page loads; the default minute is too tight on a busy machine.
test.setTimeout(150_000);

async function resetToDefault(page: Page): Promise<void> {
  await page.goto('/admin/layouts');
  await expect(page.getByTestId('zone-tabs')).toBeVisible({ timeout: 20_000 });
  let changed = false;
  for (const zone of ['zone-header', 'zone-tabs']) {
    const reset = page.getByTestId(zone).getByRole('button', { name: 'Default' });
    if (await reset.count()) { await reset.click(); changed = true; }
  }
  if (changed) {
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 15_000 });
  }
}

test('tabs and header facts arranged in the designer appear in the split view', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await resetToDefault(page);
  try {
    const tabs = page.getByTestId('zone-tabs');
    // The timeline is first by default, so moving Matching up makes it the
    // tab a record opens on, and renaming the timeline proves the name is read.
    await tabs.getByRole('button', { name: /^Move Matching.* up$/ }).click();
    await tabs.getByLabel('Name of the timeline tab').fill('History');
    await expect(tabs).toContainText('opens on Matching');

    // Whichever field is offered first — the test must not depend on this
    // database having a particular field.
    const header = page.getByTestId('zone-header');
    const picker = header.locator('select');
    const firstOption = picker.locator('option:not([value=""])').first();
    const added = (await firstOption.innerText()).trim();
    await picker.selectOption({ label: added });

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 15_000 });

    await page.goto('/leads');
    const nav = page.getByRole('navigation', { name: 'Record workspace sections' });
    await expect(nav).toBeVisible({ timeout: 20_000 });
    // The tabs are icons since 30 September 2026, so their names are what a
    // screen reader hears — which is also what the designer set.
    await expect(nav.getByRole('button').first()).toHaveAccessibleName(/^Matching/);
    await expect(nav.getByRole('button', { name: /^History/ })).toBeVisible();
    // The first tab is the one a record opens on.
    await expect(nav.locator('button[aria-current="page"]')).toHaveAccessibleName(/^Matching/);
    // Pinned facts sit at the top of the right pane now, not in the header.
    await expect(page.getByTestId('record-inspector')).toContainText(added, { ignoreCase: true });
  } finally {
    await resetToDefault(page);
  }

  await page.goto('/leads');
  const nav = page.getByRole('navigation', { name: 'Record workspace sections' });
  await expect(nav.getByRole('button').first()).toHaveAccessibleName(/^Activity/, { timeout: 20_000 });
});
