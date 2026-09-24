/**
 * The call console the team starts using tomorrow morning.
 *
 * A rep taps the number on a lead, the phone dials, and when they come back the
 * CRM is already asking what happened. Every part of that had integration
 * coverage and none of it had ever been opened in a browser — which mattered
 * the moment the outcome list stopped being a constant compiled into the bundle
 * and became a fetch of the admin's own picklist. A list that arrives empty, or
 * a default that is no longer on it, is a console a rep cannot save, and no
 * server test can see it.
 *
 * The call lives in the record's own header now rather than in a dialog over
 * it (24 September 2026, the owner's own design), so these read the deck in
 * the header — the surface changed twice and the promises
 * are the same ones, deliberately: the list is the admin's, a save reaches the
 * Calls tab, and there is no way to send an outcome the list does not offer.
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

test('tapping the number opens the deck in the header, not a dialog over the record', async ({ page }) => {
  await page.goto(recordUrl);
  // The number is a button on the record, not a tel: link — tapping it is what
  // starts the call. Matched on its title: the accessible name is the number
  // itself, which changes every run.
  await page.locator('button[title^="Call "]').first().click();

  const deck = page.getByTestId('call-deck');
  await expect(deck).toBeVisible({ timeout: 15_000 });

  /*
    The whole point of the change: the record stays readable and editable while
    the call runs. A dialog here would be the thing it replaced.
  */
  expect(await page.getByRole('dialog').count(), 'a dialog opened over the record').toBe(0);
  await expect(page.getByRole('heading', { name })).toBeVisible();

  // The real list, not one lonely option: the picklist ships with thirteen and
  // an admin only ever adds to it.
  const outcomes = deck.getByRole('combobox', { name: /how the call went/i });
  expect(await outcomes.locator('option').count(), 'the outcome list did not load').toBeGreaterThan(5);

  /*
    Mute, keypad and End are drawn and dead, on purpose. Android hands a
    running call to the handset's own dialler and to nobody else, and a red
    End button that ends nothing is the exact failure this repo keeps writing
    down.
  */
  const endCall = deck.getByRole('button', { name: /end call/i });
  await expect(endCall).toBeDisabled();
  await expect(endCall).toHaveAttribute('title', /dialler end a call/i);
  await deck.getByRole('button', { name: /did not call/i }).click();
  await expect(deck).toBeHidden();
});

test('saving the outcome records the call on the lead', async ({ page }) => {
  await page.goto(recordUrl);
  await page.locator('button[title^="Call "]').first().click();

  const deck = page.getByTestId('call-deck');
  await expect(deck).toBeVisible({ timeout: 15_000 });
  await deck.getByRole('combobox', { name: /how the call went/i }).selectOption('Interested');
  await deck.getByRole('button', { name: /^save/i }).click();

  await expect(deck).toBeHidden({ timeout: 20_000 });

  // The Calls tab is where the rep looks next, and an outcome that does not
  // show up there reads as a call that was not logged at all.
  await page.goto(recordUrl);
  await page.getByRole('tab', { name: /calls/i }).or(page.getByRole('button', { name: /^calls$/i })).first().click();
  await expect(page.getByText('Interested').first()).toBeVisible({ timeout: 20_000 });
});

test('an outcome the list does not offer cannot be sent', async ({ page }) => {
  // The guard that keeps reports honest, from the browser's side: the outcome
  // is a list the picklist drew, so there is no free-text path to the endpoint.
  await page.goto(recordUrl);
  await page.locator('button[title^="Call "]').first().click();
  const deck = page.getByTestId('call-deck');
  await expect(deck).toBeVisible({ timeout: 15_000 });
  expect(await deck.locator('input[type="text"]').count()).toBe(0);
  expect(await deck.locator('option').count()).toBeGreaterThan(5);
  await deck.getByRole('button', { name: /did not call/i }).click();
});

test('the outcome list follows the admin, not the bundle', async ({ page }) => {
  // Add an option in Settings and it has to appear on the deck. This is the
  // whole reason the list stopped being a constant in the bundle.
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
    const deck = page.getByTestId('call-deck');
    await expect(deck).toBeVisible({ timeout: 15_000 });
    // Reachable, not merely present: an option Settings can add and the deck
    // cannot pick is Settings editing a list nobody can use.
    await deck.getByRole('combobox', { name: /how the call went/i }).selectOption(value);
    await deck.getByRole('button', { name: /did not call/i }).click();
  } finally {
    await page.evaluate(async (gone) => {
      const token = localStorage.getItem('ipropy.token');
      await fetch(`/api/meta/picklists/call_disposition/values?value=${encodeURIComponent(gone)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
    }, value);
  }
});
