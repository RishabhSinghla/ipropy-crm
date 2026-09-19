/**
 * The split view is arranged in one place, for everybody.
 *
 * Until Admin → Split View existed, the three places a field can appear in it
 * were set on three different screens: the line under a name came from a flag
 * in the Field Manager, and the record's header and form from the Layout
 * Designer. This proves the round trip — choose a field, save, and the queue
 * says so — and, just as importantly, that clearing it puts back what the CRM
 * ships rather than leaving a blank pane.
 *
 * It writes a **global** setting, so it restores it in `afterAll` whatever
 * happens. A spec that leaves the whole team's split view rearranged would
 * fail every other spec that runs after it.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

const SETTING = 'ui.split_view';

async function forgetTheChoice(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/leads');
  await page.evaluate(() => {
    try { localStorage.removeItem('ipropy.listmode.leads'); } catch { /* see listMode.ts */ }
  });
  await page.reload();
}

/** Put the setting back to "nobody has arranged anything", which is the shipped state. */
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/leads');
  await page.evaluate(async (key) => {
    const token = localStorage.getItem('ipropy.token');
    await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ settings: { [key]: {} } }),
    });
  }, SETTING);
  await page.close();
});

test('a field chosen in Admin shows up under the name in the queue', async ({ page }) => {
  await page.goto('/admin/split-view');
  await expect(page.getByRole('heading', { name: 'Split view' })).toBeVisible({ timeout: 30_000 });

  /*
    The left pane is the tab it opens on, and the fields offered come from the
    module rather than from a list in this page — so the spec picks one by its
    label. Mobile, because every seeded contact has one and the queue line can
    therefore be checked for a real value rather than for an empty dash.
  */
  const available = page.getByRole('heading', { name: 'Available' }).locator('..');
  await available.locator('label').filter({ hasText: /^Mobile/ }).first().click();

  await expect(page.getByText('Shown, in this order').locator('..')).toContainText('Mobile');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Split view saved')).toBeVisible();

  // And the queue says so. `/api/auth/me` carries the setting, so a reload is
  // what makes it live — the same path every other UI setting takes.
  await forgetTheChoice(page);
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  // A queue row, not the sorting button that shares the pane with them.
  const queue = page.locator('aside').first().locator('button:has(input[type="checkbox"])');
  // Whatever the first row is, its second line is a phone number now rather
  // than the contact type it carried before.
  await expect(queue.first()).toContainText(/\d{5}/);
});

test('clearing it puts back what the CRM ships', async ({ page }) => {
  await page.goto('/admin/split-view');
  await expect(page.getByRole('heading', { name: 'Split view' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Use what the CRM shows' }).click();
  await expect(page.getByText('Shown, in this order').locator('..'))
    .toContainText('falls back to the fields flagged to show under a name');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Split view saved')).toBeVisible();

  await forgetTheChoice(page);
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  // Back to the contact type, which is what `config.listSubtitle` flags.
  await expect(page.locator('aside').first().locator('button:has(input[type="checkbox"])').first())
    .toContainText(/Buyer|Seller|Tenant|Investor/);
});
