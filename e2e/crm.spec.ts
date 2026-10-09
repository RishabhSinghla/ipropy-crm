import { expect, test } from '@playwright/test';
import { unique, waitForRecords, fillRequiredFields, searchList, openCreateDialog, waitForShell, openFirstRecord, openDetailsPane } from './helpers';

/**
 * The journeys a salesperson actually performs. Each one is a path where a
 * silent break would cost real work: not being able to sign in, not being able
 * to add a lead, or — the subtle one — an inline edit that appears to save in
 * the UI but never reaches the database.
 */

test('signs in and lands on a working dashboard', async ({ page }) => {
  // auth.setup.ts performed the actual sign-in; this confirms the restored
  // session lands on a working dashboard.
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /command centre|dashboard/i }).first()).toBeVisible();
  // The switcher proves module metadata loaded, not just that a shell
  // rendered: it is named from the modules, so a shell without them shows
  // nothing. It replaced the row of tabs this used to look for.
  await waitForShell(page);
});

test('creates a lead and finds it again in the list', async ({ page }) => {
  const surname = unique('E2E');
  // Unique per run: the mobile is a duplicate-check field on Leads, so a
  // hardcoded number makes every run after the first trip the duplicate
  // warning and never submit.
  const mobile = `9${String(Date.now()).slice(-9)}`;

  await page.goto('/leads');
  const dialog = await openCreateDialog(page, /new lead/i);
  // One name field, not two — see migration 026. `first_name`/`last_name` are
  // derived from it and were retired from every form.
  await dialog.getByLabel(/full name/i).fill(`Playwright ${surname}`);
  await dialog.getByLabel(/^mobile/i).fill(mobile);
  // Everything else the form insists on, whatever that is today. Which fields
  // are mandatory is an admin setting, so naming them here would mean this test
  // reports "creating a lead is broken" the next time he tightens one.
  await fillRequiredFields(dialog);
  await dialog.getByTestId('record-form-submit').click();

  // Quick-create deliberately stays on the list rather than opening the new
  // record — see ListView's onSaved. The refetch is what has to surface it.
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // And it is findable through search, which exercises the list query path.
  await page.goto('/leads');
  await searchList(page, surname);
  await expect(
    page.getByText(`Playwright ${surname}`, { exact: true }).locator('visible=true').first(),
  ).toBeVisible({ timeout: 30_000 });
});

test('inline-edits a text field on the record in the split view', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  // The record opens beside the queue; its fields edit where they stand.
  await openFirstRecord(page);
  await openDetailsPane(page);

  // Fields live in the right-hand pane since 30 September 2026, beside
  // whichever tab is open, so there is no tab to ask for.
  await expect(page.getByTestId('record-inspector')).toBeVisible({ timeout: 30_000 });

  const typed = unique('Co');

  // Whichever text field the layout happens to show, rather than a named one.
  //
  // This used to click the field called Company, which is on the module and is
  // not on his detail layout, because which fields appear there is a Layout
  // Designer decision. The behaviour under test is that clicking a value opens
  // an editor and what you type is still there after a reload. Any text field
  // demonstrates that; naming one only asserts on how this database is set up
  // today.
  const triggers = page.locator('[data-field-box]:visible').filter({ has: page.getByRole('button', { name: /^Change / }) });
  await expect(triggers.first()).toBeVisible({ timeout: 30_000 });

  let edited = false;
  const count = await triggers.count();
  for (let i = 0; i < count && !edited; i += 1) {
    await triggers.nth(i).click();
    const input = page.locator('input:focus:not([type="checkbox"]):not([type="radio"])');
    // Wait for it rather than counting straight away. The editor is rendered by
    // React on the click, so an immediate count is a race that reads zero and
    // moves on from a field that was about to work.
    const opened = await input.waitFor({ state: 'attached', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      // A picker or a date, which opens something other than a text box.
      await page.keyboard.press('Escape');
      continue;
    }
    // A dropdown's search box (the owner, the stage, the type — all in the
    // right pane since 30 September 2026) also opens as a text box, and typing
    // into it saves nothing. So a field counts as edited only once the record
    // was actually written.
    const saved = page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && res.url().includes('/api/records/') && res.ok(),
      { timeout: 5_000 },
    ).then(() => true).catch(() => false);
    await input.fill(typed);
    await input.press('Enter');
    edited = await saved;
    if (!edited) await page.keyboard.press('Escape');
  }
  expect(edited, 'no inline-editable text field on the record').toBe(true);

  await expect(page.getByText(typed).first()).toBeVisible({ timeout: 15_000 });

  // The edit made this the most recently updated record, so it leads the queue.
  await page.reload();
  await openFirstRecord(page);
  await openDetailsPane(page);
  await expect(page.getByTestId('record-inspector')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(typed).first()).toBeVisible({ timeout: 30_000 });
});

test('keeps the app usable when a page throws', async ({ page }) => {
  // Navigating to a record id that cannot exist should surface a handled
  // error, never a blank screen — the ErrorBoundary contract.
  await page.goto('/leads/00000000-0000-0000-0000-000000000000');

  // Something must be rendered, and the shell must survive.
  await waitForShell(page);
  const body = await page.locator('body').innerText();
  expect(body.trim().length).toBeGreaterThan(0);
});
