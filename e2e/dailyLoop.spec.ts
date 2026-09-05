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

test.describe.configure({ mode: 'serial' });

const name = `Daily Loop ${Date.now()}`;
let recordUrl = '';

test('a rep adds a lead they just spoke to', async ({ page }) => {
  await page.goto('/leads/new');
  await page.getByRole('textbox', { name: /full name/i }).fill(name);
  await page.getByRole('textbox', { name: /^mobile/i }).fill(String(9811570000 + (Date.now() % 9000)));
  await page.getByTestId('record-form-submit').click();
  await expect(page.getByText(/created/i).first()).toBeVisible({ timeout: 15_000 });
});

test('they open it from the list', async ({ page, context }) => {
  await page.goto('/leads');
  await page.getByTestId('list-search').fill(name);
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

test('they change the pipeline status without leaving the page', async ({ page }) => {
  /*
    The whole point of inline editing. A rep who has just rung somebody changes
    the status in one click; making them open an edit form, save and come back
    is what turns a thirty-second job into a reason not to bother.
  */
  await page.goto(recordUrl);
  await page.getByRole('button', { name: /^Edit Pipeline Status$/ }).first().click();

  const options = page.getByRole('option').or(page.locator('select').first());
  await expect(options.first()).toBeVisible({ timeout: 10_000 });

  await page.getByRole('option', { name: 'Contacted' }).click().catch(async () => {
    await page.locator('select').first().selectOption({ label: 'Contacted' });
  });

  // It saves on its own — no Save button in the inline flow.
  await expect(page.getByText('Contacted').first()).toBeVisible({ timeout: 10_000 });

  // And it is really stored, not just on screen.
  await page.reload();
  await expect(page.getByText('Contacted').first()).toBeVisible({ timeout: 15_000 });
});

test('they leave a note for whoever picks this up next', async ({ page }) => {
  const note = `Rang them, call back Tuesday ${Date.now()}`;
  await page.goto(recordUrl);

  await page.getByPlaceholder(/add a note/i).fill(note);
  await page.getByRole('button', { name: /^post$/i }).click();

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
  await expect(page.getByRole('button', { name: /^Edit /}).first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('button', { name: 'Click to edit', exact: true }),
    'a button named only for the gesture tells nobody what it edits',
  ).toHaveCount(0);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/leads');
  await page.getByTestId('list-search').fill(name).catch(() => undefined);
  await page.close();
});
