import { expect, test } from '@playwright/test';
import { unique } from './helpers';

/**
 * The Reports screen, as its users meet it.
 *
 * Written the day the screen was walked like a real user and two things fell
 * out: money columns were detected by keyword-matching the column name (so a
 * property's monthly rent rendered as a raw ungrouped number while a lead's
 * lifetime value rendered as ₹), and the fully built saved-reports backend had
 * no screen at all — a person built a report, navigated away, and their work
 * was gone.
 */
test.describe.serial('reports', () => {
  let reportName: string;

  /** The builder card: the one holding the Module label. The saved-reports card renders above it whenever anything is saved, so positional selectors like "the first card" lie depending on database contents. */
  function builderCard(page: import('@playwright/test').Page) {
    return page.locator('div.card').filter({ has: page.locator('label', { hasText: 'Module' }) });
  }

  test('a summary run formats its money column as money and can be saved', async ({ page }) => {
    reportName = unique('Rent by status');
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();

    await builderCard(page).locator('select').first().selectOption({ label: 'Properties' });
    await page.getByRole('button', { name: /run report/i }).click();

    // The regression: "Total monthly rent" is a currency field, so its total
    // must read as ₹ — it used to fall out of a keyword list that knew
    // "price" and "value" but not "rent", and rendered a bare number.
    const th = page.getByRole('columnheader', { name: /total monthly rent/i });
    await expect(th).toBeVisible();
    const idx = await th.evaluate((el) => Array.from(el.parentElement?.children ?? []).indexOf(el));
    await expect(page.locator('tfoot td').nth(idx)).toHaveText(/^₹/);

    await page.getByRole('button', { name: 'Save report' }).click();
    await page.getByLabel('Report name').fill(reportName);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Report saved')).toBeVisible();
    await expect(page.locator('li').filter({ hasText: reportName })).toBeVisible();
  });

  test('a saved report survives leaving the page', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Saved reports' })).toBeVisible();
    await expect(page.locator('li').filter({ hasText: reportName })).toBeVisible();
  });

  test('running a saved report puts it back in the builder and runs it', async ({ page }) => {
    await page.goto('/reports');
    const row = page.locator('li').filter({ hasText: reportName });
    await expect(row).toBeVisible();

    // The builder opens on Leads; this saved report is a Properties report,
    // so running it must rederive the module and its controls, not just print.
    await row.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByRole('columnheader', { name: /total monthly rent/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('columnheader', { name: /properties count/i })).toBeVisible();
  });

  test('deleting a saved report asks first and then it is gone', async ({ page }) => {
    await page.goto('/reports');
    const row = page.locator('li').filter({ hasText: reportName });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: `Delete ${reportName}` }).click();
    await expect(page.getByText(/will be gone for everyone/i)).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(row).toHaveCount(0);
    await expect(page.getByText('Report deleted')).toBeVisible();
  });

  test('a tabular report exports as CSV', async ({ page }) => {
    await page.goto('/reports');
    await builderCard(page).locator('select').first().selectOption({ label: 'Properties' });
    await builderCard(page).locator('select').nth(1).selectOption({ label: 'Tabular — one row per record' });
    await page.getByRole('button', { name: /run report/i }).click();

    const csv = page.getByRole('button', { name: /export csv/i });
    await expect(csv).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      csv.click(),
    ]);
    expect(await download.suggestedFilename()).toBe('properties-report.csv');
  });
});

test.describe('reports a rep shares', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a rep who asks for a shared report does not get one', async ({ page }) => {
    // The dialog hides the share switch from non-admins; this pins the server
    // half, because a crafted request must not succeed where the UI refuses.
    await page.goto('/');
    await page.getByRole('textbox', { name: /you@ipropy|email or mobile/i }).fill('aisha.khan@ipropy.com');
    await page.getByRole('textbox', { name: /password/i }).fill('Admin@123');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page.getByRole('link', { name: /dashboard/i }).first()).toBeVisible({ timeout: 20_000 });

    // The API is called with the same bearer token the app itself uses —
    // page.request alone does not carry it, and this test is about what a
    // crafted request can achieve, not about transport.
    const token = await page.evaluate(() => localStorage.getItem('ipropy.token'));
    const auth = token ? { Authorization: `Bearer ${token}` } : {};

    const made = await page.request.post('/api/reports', {
      headers: auth,
      data: {
        name: unique('Rep shared attempt'),
        module: 'properties',
        type: 'summary',
        groupBy: ['status'],
        aggregates: [],
        isShared: true,
      },
    });
    expect(made.status()).toBe(201);
    const { id } = (await made.json()) as { id: string };

    const list = await page.request.get('/api/reports', { headers: auth });
    const mine = (await list.json()) as { id: string; isShared: boolean }[];
    const savedReport = mine.find((r) => r.id === id);
    expect(savedReport, 'the rep should still see their own report').toBeTruthy();
    expect(savedReport?.isShared, 'isShared must be silently refused from a non-admin').toBe(false);

    await page.request.delete(`/api/reports/${id}`, { headers: auth });
  });
});

