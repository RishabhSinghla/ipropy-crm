import { expect, test } from '@playwright/test';
import { columnIndex, editableCells, unique, waitForRecords, fillRequiredFields, openRecordTab , inlineEditOn } from './helpers';

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
  // The sidebar proves module metadata loaded, not just that a shell rendered.
  await expect(page.getByRole('link', { name: /leads & contacts/i })).toBeVisible();
});

test('creates a lead and finds it again in the list', async ({ page }) => {
  const surname = unique('E2E');
  // Unique per run: the mobile is a duplicate-check field on Leads, so a
  // hardcoded number makes every run after the first trip the duplicate
  // warning and never submit.
  const mobile = `9${String(Date.now()).slice(-9)}`;

  await page.goto('/leads');
  await page.getByRole('button', { name: /new lead/i }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // One name field, not two — see migration 026. `first_name`/`last_name` are
  // derived from it and were retired from every form.
  await dialog.getByLabel(/full name/i).fill(`Playwright ${surname}`);
  await dialog.getByLabel(/^mobile/i).fill(mobile);
  // Everything else the form insists on, whatever that is today. Which fields
  // are mandatory is an admin setting, so naming them here would mean this test
  // reports "creating a lead is broken" the next time he tightens one.
  await fillRequiredFields(dialog);
  await dialog.getByRole('button', { name: /create lead/i }).click();

  // Quick-create deliberately stays on the list rather than opening the new
  // record — see ListView's onSaved. The refetch is what has to surface it.
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // And it is findable through search, which exercises the list query path.
  await page.goto('/leads');
  await page.getByPlaceholder(/search leads/i).fill(surname);
  // `visible=true` matters: ListView renders both a mobile card list and a
  // desktop table, so the name is in the DOM twice and only one is displayed.
  await expect(
    page.getByText(`Playwright ${surname}`, { exact: true }).locator('visible=true').first(),
  ).toBeVisible({ timeout: 30_000 });
});

test('inline-edits a picklist in the list and the change survives a reload', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);

  // Find the Pipeline Status column by its header rather than by a fixed
  // index: the default view's columns are metadata an admin can reorder, and a
  // hardcoded nth() turns any such change into a mystery test failure.
  const statusIndex = await columnIndex(page, 'Pipeline Status');
  const statusCell = page.locator('tbody tr').first().locator('td').nth(statusIndex);
  test.skip(!(await inlineEditOn(page)), 'inline editing is switched off');
  const trigger = statusCell.locator('button[title="Click to edit"]');
  const before = (await trigger.textContent())?.trim();

  await trigger.click();

  // Pick an option that differs from the current value, so the assertion
  // cannot pass by the value simply not changing. Scoped by role: the popover
  // is portalled to the end of <body>, so "a button whose text is New" would
  // otherwise match another row's cell before it matched an option.
  const options = page.getByRole('option');
  const target = options.filter({ hasNotText: before ?? '___' }).first();
  const chosen = (await target.textContent())?.trim();
  await target.click();

  await expect(trigger).toHaveText(new RegExp(chosen ?? '', 'i'), { timeout: 15_000 });

  // The real assertion: it persisted server-side, not just in local state.
  await page.reload();
  await waitForRecords(page);
  const after = page.locator('tbody tr').first().locator('td').nth(statusIndex);
  await expect(after).toContainText(chosen ?? '', { timeout: 30_000 });
});

test('inline-edits a text field on the record detail page', async ({ page, context }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  // No skip: a record page is always editable, whatever the list setting says.
  // Click the Record # cell, not the row generally: most cells now hold an
  // inline editor that stops propagation, so clicking one opens the editor
  // instead of navigating. Record # is an autonumber, so it stays plain text.
  const popup = context.waitForEvent('page').catch(() => null);
  await page.locator('tbody tr').first().locator('td').nth(1).click();

  // Records open in a new tab by default, so the page under test may be that
  // one. Handle both, because a setting decides which.
  const opened = await Promise.race([
    popup,
    page.waitForURL(/\/leads\/[0-9a-f-]{36}/).then(() => null).catch(() => null),
  ]);
  if (opened) page = opened;
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 30_000 });

  // Fields live on Overview, and which tab a record opens on is an admin
  // setting — his own detail layout opens on Timeline. Ask for the tab.
  await openRecordTab(page, 'Overview');

  const typed = unique('Co');

  // Whichever text field the layout happens to show, rather than a named one.
  //
  // This used to click the field called Company, which is on the module and is
  // not on his detail layout, because which fields appear there is a Layout
  // Designer decision. The behaviour under test is that clicking a value opens
  // an editor and what you type is still there after a reload. Any text field
  // demonstrates that; naming one only asserts on how this database is set up
  // today.
  const triggers = page.locator('dd button[title="Click to edit"]:visible');
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
    await input.fill(typed);
    await input.press('Enter');
    edited = true;
  }
  expect(edited, 'no inline-editable text field on the record').toBe(true);

  await expect(page.getByText(typed).first()).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await openRecordTab(page, 'Overview');
  await expect(page.getByText(typed).first()).toBeVisible({ timeout: 30_000 });
});

test('keeps the app usable when a page throws', async ({ page }) => {
  // Navigating to a record id that cannot exist should surface a handled
  // error, never a blank screen — the ErrorBoundary contract.
  await page.goto('/leads/00000000-0000-0000-0000-000000000000');

  // Something must be rendered, and the shell must survive.
  await expect(page.getByRole('link', { name: /leads & contacts/i })).toBeVisible({ timeout: 30_000 });
  const body = await page.locator('body').innerText();
  expect(body.trim().length).toBeGreaterThan(0);
});
