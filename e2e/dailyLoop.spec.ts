/**
 * The thing a rep does forty times a day.
 *
 * Creating and deleting records is covered elsewhere. This is the part in
 * between and the part nobody had tested: open a lead, change something on it
 * without leaving the page, and leave a note for a colleague. If inline editing
 * breaks, the CRM still looks perfect and nobody can do their job in it.
 *
 * It leans on each edit button naming its own field. They were all called
 * "Click to edit" until this spec needed to tell them apart — twenty identical
 * buttons on one record, which was a screen-reader problem long before it was a
 * testing one.
 */
import { expect, test } from '@playwright/test';
import { waitForRecords, searchList, fieldEditor, openFromListByName } from './helpers';

test.describe.configure({ mode: 'serial' });

const name = `Daily Loop ${Date.now()}`;
let recordUrl = '';

test('a rep adds a lead they just spoke to', async ({ page }) => {
  await page.goto('/leads/new');
  await page.getByRole('textbox', { name: /full name/i }).fill(name);
  // `Date.now() % 9000` cycles every nine seconds, so two runs in the same
  // afternoon collide and the duplicate check answers with an error toast
  // instead of "created" — which reads as the create screen being broken. The
  // last eight digits of the clock cycle once a day instead.
  await page.getByRole('textbox', { name: /^mobile/i }).fill(`98${String(Date.now()).slice(-8)}`);
  await page.getByTestId('record-form-submit').click();
  // Named rather than matched on /created/i alone: if the save is refused, this
  // says which message actually appeared instead of "element not found".
  const toast = page.getByRole('status').or(page.getByText(/created|already exists|could not/i)).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText(/created/i);
});

test('they open it from the list', async ({ page }) => {
  await page.goto('/leads');
  // The search box renders before the list does, and typing into it while the
  // cards are still coming filters nothing.
  await waitForRecords(page);
  // The record opens beside the queue, in the split view.
  recordUrl = await openFromListByName(page, 'leads', name);
});

test('they change the pipeline status without leaving the page', async ({ page }) => {
  /*
    The whole point of inline editing. A rep who has just rung somebody changes
    the status in one click; making them open an edit form, save and come back
    is what turns a thirty-second job into a reason not to bother.
  */
  await page.goto(recordUrl);
  await fieldEditor(page, /^Change Pipeline Status$/).click();

  // The stage list itself, by the option wanted: the split view has other
  // (hidden) dropdowns on the page, so "the first option anywhere" is not it.
  const contacted = page.getByRole('option', { name: 'Contacted' });
  await expect(contacted).toBeVisible({ timeout: 10_000 });
  await contacted.click();

  // It saves on its own — no Save button in the inline flow.
  await expect(page.getByText('Contacted').first()).toBeVisible({ timeout: 10_000 });

  // And it is really stored, not just on screen.
  await page.reload();
  await expect(page.getByText('Contacted').first()).toBeVisible({ timeout: 15_000 });
});

test('they leave a note for whoever picks this up next', async ({ page }) => {
  const note = `Rang them, call back Tuesday ${Date.now()}`;
  await page.goto(recordUrl);

  // The box at the foot of the timeline since 30 September 2026. Its button
  // says "Comment" there, beside Send WhatsApp.
  await page.getByLabel('Add a note for the team').first().fill(note);
  await page.getByRole('button', { name: /^(post|comment)$/i }).first().click();

  await expect(page.getByText(note)).toBeVisible({ timeout: 15_000 });

  // A note that vanishes on reload is worse than no note: the rep believes the
  // next person will see it.
  await page.reload();
  await expect(page.getByText(note)).toBeVisible({ timeout: 15_000 });
});

test('every editable field says which field it is', async ({ page }) => {
  /*
    Pinned because it was not true. Every value on a record was a button whose
    only accessible name was its tooltip, so the page offered twenty buttons all
    called "Click to edit" and nothing said which was the mobile number and
    which was the budget.
  */
  await page.goto(recordUrl);
  await expect(page.getByRole('button', { name: /^Change /}).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('button', { name: 'Click to edit', exact: true }),
    'a button named only for the gesture tells nobody what it edits',
  ).toHaveCount(0);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/leads');
  await searchList(page, name).catch(() => undefined);
  await page.close();
});
