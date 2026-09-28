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
 * The call lives in the record's notes pane rather than in a dialog over
 * it, so these read the compact in-record deck — the surface changed and the promises
 * are the same ones, deliberately: the list is the admin's, a save reaches the
 * Calls tab, and there is no way to send an outcome the list does not offer.
 */
import { expect, test, type Locator } from '@playwright/test';
import { waitForRecords, searchList, openFromListByName } from './helpers';

test.describe.configure({ mode: 'serial' });

const name = `Call Outcome ${Date.now()}`;

/* The CRM-configured outcomes, rendered as one accessible dropdown. */
function outcomeSelect(deck: Locator): Locator {
  return deck.getByRole('combobox', { name: 'Call disposition' });
}
async function chooseOutcome(deck: Locator, value: string): Promise<void> {
  await outcomeSelect(deck).selectOption({ label: value });
}
let recordUrl = '';

test('a rep adds the lead they are about to ring', async ({ page }) => {
  await page.goto('/leads/new');
  await page.getByRole('textbox', { name: /full name/i }).fill(name);
  await page.getByRole('textbox', { name: /^mobile/i }).fill(`97${String(Date.now()).slice(-8)}`);
  await page.getByTestId('record-form-submit').click();
  await expect(page.getByText(/created/i).first()).toBeVisible({ timeout: 15_000 });
});

test('they open it from the list', async ({ page }) => {
  await page.goto('/leads');
  // The search box renders before the list does, and typing into it while the
  // cards are still coming filters nothing.
  await waitForRecords(page);
  // The record opens beside the queue, in the split view.
  recordUrl = await openFromListByName(page, 'leads', name);
});

test('tapping the number opens the deck beside the record, not a dialog over it', async ({ page }) => {
  await page.goto(recordUrl);
  const deck = page.getByTestId('call-deck-panel').or(page.getByTestId('call-deck')).first();
  // The deck is a permanent part of the work pane. At rest it gives an
  // unambiguous answer before anybody presses Call.
  await expect(deck).toBeVisible({ timeout: 15_000 });
  await expect(deck.getByTestId('call-panel-status')).toContainText('No call in progress');
  // The number is a button on the record, not a tel: link — tapping it is what
  // starts the call. Matched on its title: the accessible name is the number
  // itself, which changes every run.
  await page.locator('button[title^="Call "]').first().click();

  await expect(deck).toBeVisible({ timeout: 15_000 });

  /*
    The whole point of the change: the record stays readable and editable while
    the call runs. A dialog here would be the thing it replaced.
  */
  expect(await page.getByRole('dialog').count(), 'a dialog opened over the record').toBe(0);
  await expect(page.getByRole('heading', { name })).toBeVisible();

  // The real list, not one lonely option: the picklist ships with thirteen and
  // an admin only ever adds to it.
  expect(await outcomeSelect(deck).locator('option').count(), 'the outcome list did not load').toBeGreaterThan(5);

  /*
    Speaker, hold and End are dead, with the reason, until a phone says
    iPropy is its calling app — Android lets nobody else touch a running
    call, and a red End that ends nothing is the failure this repo keeps
    writing down. No handset here has said so.
  */
  const endCall = deck.getByRole('button', { name: /end call/i });
  await expect(endCall).toBeDisabled();
  await expect(endCall).toHaveAttribute('title', /calling app|Control calls from the CRM/i);
  await expect(deck.getByRole('button', { name: /^hold/i })).toBeDisabled();
  await deck.getByRole('button', { name: /save & exit/i }).click();
  await expect(deck).toBeVisible();
  await expect(deck.getByTestId('call-panel-status')).toContainText('No call in progress');
});

test('saving the outcome records the call on the lead', async ({ page }) => {
  await page.goto(recordUrl);
  await page.locator('button[title^="Call "]').first().click();

  const deck = page.getByTestId('call-deck-panel').or(page.getByTestId('call-deck')).first();
  await expect(deck).toBeVisible({ timeout: 15_000 });
  await chooseOutcome(deck, 'Interested');
  await deck.getByRole('button', { name: /save & exit/i }).click();

  await expect(deck).toBeVisible({ timeout: 20_000 });
  await expect(deck.getByTestId('call-panel-status')).toContainText('No call in progress');

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
  const deck = page.getByTestId('call-deck-panel').or(page.getByTestId('call-deck')).first();
  await expect(deck).toBeVisible({ timeout: 15_000 });
  expect(await deck.locator('input[type="text"]').count()).toBe(0);
  expect(await outcomeSelect(deck).locator('option').count()).toBeGreaterThan(5);
  await deck.getByRole('button', { name: /save & exit/i }).click();
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
    const deck = page.getByTestId('call-deck-panel').or(page.getByTestId('call-deck')).first();
    await expect(deck).toBeVisible({ timeout: 15_000 });
    // Reachable, not merely present: an option Settings can add and the deck
    // cannot pick is Settings editing a list nobody can use.
    await chooseOutcome(deck, value);
    await deck.getByRole('button', { name: /save & exit/i }).click();
  } finally {
    await page.evaluate(async (gone) => {
      const token = localStorage.getItem('ipropy.token');
      await fetch(`/api/meta/picklists/call_disposition/values?value=${encodeURIComponent(gone)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
    }, value);
  }
});

/**
 * Save & Next opens the next person **and rings them**.
 *
 * This has now failed twice for two different reasons, and neither was visible
 * to any other layer. First the record was fetched only while a call was
 * already running, so arriving on `?dial=1` the number was unknown and the
 * effect returned early. Then the record page — which is only a waypoint once
 * the split view is the default — mounted its own call provider for a tick,
 * saw the flag it had just been handed and spent it against the old address.
 * Both times Save & Next opened the next person and rang nobody.
 *
 * So the promise is pinned here: the flag survives the hand-off, a deck comes
 * up on the next person, and the flag does not come back afterwards — because
 * a flag left in the address re-rings somebody on the next refresh.
 */
test('Save & Next carries the call to the next person', async ({ page }) => {
  await page.goto(recordUrl);
  await page.locator('button[title^="Call "]').first().click();

  const deck = page.getByTestId('call-deck-panel').or(page.getByTestId('call-deck')).first();
  await expect(deck).toBeVisible({ timeout: 15_000 });
  const next = deck.getByRole('button', { name: /save & next/i });
  const wasOffered = (await next.count()) > 0;
  const save = wasOffered ? next : deck.getByRole('button', { name: /save & exit/i });

  await chooseOutcome(deck, 'Interested');
  await save.click();

  // Landed on somebody else, still in whichever view this person uses.
  await expect.poll(() => page.url(), { timeout: 25_000 }).not.toContain(recordUrl.split('/').pop());

  if (wasOffered) {
    // A deck on the next person, which is the half that kept breaking.
    await expect(page.getByTestId('call-deck-panel').or(page.getByTestId('call-deck')).first()).toBeVisible({ timeout: 20_000 });
  }
  // And the flag is gone, or the next refresh rings them again.
  expect(page.url()).not.toContain('dial=1');
});
