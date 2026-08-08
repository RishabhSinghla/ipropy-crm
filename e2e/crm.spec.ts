import { expect, test } from '@playwright/test';
import { editableCells, login, unique, waitForRecords } from './helpers';

/**
 * The journeys a salesperson actually performs. Each one is a path where a
 * silent break would cost real work: not being able to sign in, not being able
 * to add a lead, or — the subtle one — an inline edit that appears to save in
 * the UI but never reaches the database.
 */

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('signs in and lands on a working dashboard', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /command centre|dashboard/i }).first()).toBeVisible();
  // The sidebar proves module metadata loaded, not just that a shell rendered.
  await expect(page.getByRole('link', { name: /leads & customers/i })).toBeVisible();
});

test('creates a lead and finds it again in the list', async ({ page }) => {
  const surname = unique('E2E');
  // Unique per run: the mobile is a duplicate-check field on Leads, so a
  // hardcoded number makes every run after the first trip the duplicate
  // warning and never submit.
  const mobile = `+919${String(Date.now()).slice(-9)}`;

  await page.goto('/leads');
  await page.getByRole('button', { name: /new lead/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/first name/i).fill('Playwright');
  await dialog.getByLabel(/last name/i).fill(surname);
  await dialog.getByLabel(/^mobile/i).fill(mobile);
  // Lifecycle Stage and Pipeline Status are mandatory on the quick-create
  // layout too — the form refuses to submit without them, which is exactly
  // what this test discovered the first time it ran.
  await dialog.getByLabel(/lifecycle stage/i).selectOption({ index: 1 });
  await dialog.getByLabel(/pipeline status/i).selectOption({ index: 1 });
  await dialog.getByRole('button', { name: /create lead/i }).click();

  // Creating navigates to the new record.
  await expect(page.getByRole('heading', { name: `Playwright ${surname}` })).toBeVisible({ timeout: 30_000 });

  // And it is findable through search, which exercises the list query path.
  await page.goto('/leads');
  await page.getByPlaceholder(/search leads/i).fill(surname);
  // First and last name are separate columns in the table, so match the
  // surname cell rather than the joined label (which only exists as the
  // record's heading on the detail page).
  await expect(page.getByText(surname, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
});

test('inline-edits a picklist in the list and the change survives a reload', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);

  // First Pipeline Status cell in the table.
  const statusCell = page.locator('tbody tr').first().locator('td').nth(6);
  const trigger = statusCell.locator('button[title="Click to edit"]');
  const before = (await trigger.textContent())?.trim();

  await trigger.click();

  // Pick an option that differs from the current value, so the assertion
  // cannot pass by the value simply not changing.
  const options = page.getByRole('button').filter({ hasText: /^(New|Contacted|Qualified|Negotiation)$/ });
  const target = options.filter({ hasNotText: before ?? '___' }).first();
  const chosen = (await target.textContent())?.trim();
  await target.click();

  await expect(trigger).toHaveText(new RegExp(chosen ?? '', 'i'), { timeout: 15_000 });

  // The real assertion: it persisted server-side, not just in local state.
  await page.reload();
  await waitForRecords(page);
  const after = page.locator('tbody tr').first().locator('td').nth(6);
  await expect(after).toContainText(chosen ?? '', { timeout: 30_000 });
});

test('inline-edits a text field on the record detail page', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  // Click the Record # cell, not the row generally: most cells now hold an
  // inline editor that stops propagation, so clicking one opens the editor
  // instead of navigating. Record # is an autonumber, so it stays plain text.
  await page.locator('tbody tr').first().locator('td').nth(1).click();
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 30_000 });

  const company = unique('Co');
  // Company sits in the Basic Information block and is a plain string field.
  // The <dt> renders uppercase via CSS but its DOM text is "Company" —
  // Playwright matches the text node, not the painted glyphs. Step from the
  // label to its sibling <dd>, which is where the editable control lives.
  const value = page.locator('dt', { hasText: /^Company$/ })
    .locator('xpath=following-sibling::dd[1]');
  await value.locator('button[title="Click to edit"]').first().click();

  const input = page.locator('input:focus');
  await input.fill(company);
  await input.press('Enter');

  await expect(page.getByText(company)).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await expect(page.getByText(company)).toBeVisible({ timeout: 30_000 });
});

test('keeps the app usable when a page throws', async ({ page }) => {
  // Navigating to a record id that cannot exist should surface a handled
  // error, never a blank screen — the ErrorBoundary contract.
  await page.goto('/leads/00000000-0000-0000-0000-000000000000');

  // Something must be rendered, and the shell must survive.
  await expect(page.getByRole('link', { name: /leads & customers/i })).toBeVisible({ timeout: 30_000 });
  const body = await page.locator('body').innerText();
  expect(body.trim().length).toBeGreaterThan(0);
});
