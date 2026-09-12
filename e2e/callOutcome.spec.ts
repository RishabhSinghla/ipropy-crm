/**
 * The dialog the team starts using tomorrow morning.
 *
 * A rep taps the number on a lead, the phone dials, and when they come back the
 * CRM is already asking what happened. Every part of that had integration
 * coverage and none of it had ever been opened in a browser — which mattered
 * the moment the outcome list stopped being a constant compiled into the bundle
 * and became a fetch of the admin's own picklist. A list that arrives empty, or
 * a default that is no longer on it, is a dialog a rep cannot save, and no
 * server test can see it.
 */
import { expect, test } from '@playwright/test';
import { waitForRecords, searchList } from './helpers';

test.describe.configure({ mode: 'serial' });

const name = `Call Outcome ${Date.now()}`;
let recordUrl = '';

test('a rep adds the lead they are about to ring', async ({ page }) => {
  await page.goto('/leads/new');
  await page.getByRole('textbox', { name: /full name/i }).fill(name);
  await page.getByRole('textbox', { name: /^mobile/i }).fill(`97${String(Date.now()).slice(-8)}`);
  await page.getByTestId('record-form-submit').click();
  await expect(page.getByText(/created/i).first()).toBeVisible({ timeout: 15_000 });
});

test('they open it from the list', async ({ page, context }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  await searchList(page, name);
  await page.waitForTimeout(1200);

  // The list opens records in a new tab on purpose, so the list is never lost.
  const opened = context.waitForEvent('page');
  await page.locator('tr', { hasText: name }).first().click();
  const detail = await opened;
  await detail.waitForLoadState('domcontentloaded');
  await expect(detail.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
  recordUrl = detail.url();
  await detail.close();
});

test('tapping the number asks what happened, with the admin\'s own outcomes', async ({ page }) => {
  await page.goto(recordUrl);
  // The number is a button on the record, not a tel: link — tapping it is what
  // opens the outcome form behind the dialler. Matched on its title: the
  // accessible name is the number itself, which changes every run.
  await page.locator('button[title^="Call "]').first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  const outcome = dialog.getByLabel('Outcome');
  await expect(outcome).toBeVisible();

  // The real list, not an empty select and not one lonely option: the picklist
  // ships with thirteen and an admin only ever adds to it.
  const options = outcome.locator('option');
  expect(await options.count(), 'the outcome list did not load').toBeGreaterThan(5);

  // And whatever it defaults to must be one of them, or the first save fails
  // against a value the server no longer accepts.
  const chosen = await outcome.inputValue();
  const all = await options.allTextContents();
  expect(all.map((t) => t.trim())).toContain(chosen.trim());
});

test('saving the outcome records the call on the lead', async ({ page }) => {
  await page.goto(recordUrl);
  await page.locator('button[title^="Call "]').first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel('Outcome').selectOption('Interested');
  await dialog.getByRole('textbox').last().fill('wants a 3 BHK, will visit Sunday');
  await dialog.getByRole('button', { name: /save call/i }).click();

  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // The Calls tab is where the rep looks next, and an outcome that does not
  // show up there reads as a call that was not logged at all.
  await page.goto(recordUrl);
  await page.getByRole('tab', { name: /calls/i }).or(page.getByRole('button', { name: /^calls$/i })).first().click();
  await expect(page.getByText('Interested').first()).toBeVisible({ timeout: 20_000 });
});

test('an outcome the list does not offer cannot be sent', async ({ page }) => {
  // The guard that keeps reports honest, from the browser's side: the control
  // is a <select>, so there is no free-text path to the endpoint at all.
  await page.goto(recordUrl);
  await page.locator('button[title^="Call "]').first().click();
  const outcome = page.getByRole('dialog').getByLabel('Outcome');
  await expect(outcome).toBeVisible({ timeout: 15_000 });
  expect(await outcome.evaluate((el) => el.tagName)).toBe('SELECT');
  await page.keyboard.press('Escape');
});

test('the outcome list follows the admin, not the bundle', async ({ page }) => {
  // Add an option in Settings and it has to appear in the dialog. This is the
  // whole reason the dropdown stopped being a constant.
  const value = `QA Outcome ${Date.now()}`;
  await page.goto('/admin/picklists');
  await waitForRecords(page).catch(() => undefined);

  const added = await page.evaluate(async (newValue) => {
    const token = localStorage.getItem('ipropy.token');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const current = await (await fetch('/api/meta/picklists/call_disposition', { headers })).json();
    const values = [...current, { value: newValue, label: newValue, isActive: true }]
      .map((v: { value: string; label: string; color?: string | null; isActive?: boolean }) => ({
        value: v.value, label: v.label, color: v.color ?? null, isActive: v.isActive ?? true,
      }));
    const res = await fetch('/api/meta/picklists/call_disposition/values', {
      method: 'PUT', headers, body: JSON.stringify({ values }),
    });
    return res.ok;
  }, value);
  expect(added, 'could not add the option as an admin').toBe(true);

  try {
    await page.goto(recordUrl);
    await page.locator('button[title^="Call "]').first().click();
    const outcome = page.getByRole('dialog').getByLabel('Outcome');
    await expect(outcome).toBeVisible({ timeout: 15_000 });
    await expect(outcome.locator(`option:text-is("${value}")`)).toHaveCount(1);
    await page.keyboard.press('Escape');
  } finally {
    await page.evaluate(async (gone) => {
      const token = localStorage.getItem('ipropy.token');
      await fetch(`/api/meta/picklists/call_disposition/values?value=${encodeURIComponent(gone)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
    }, value);
  }
});
