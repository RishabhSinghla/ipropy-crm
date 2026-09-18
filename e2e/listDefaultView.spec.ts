/**
 * A list opens on the iPROPY desk, and a different choice sticks.
 *
 * The owner asked for the desk to be what everybody lands on, in both modules,
 * with anybody free to switch. Both halves need a browser: the default lives in
 * the browser's own storage, and "it stuck" means it survived a reload.
 *
 * The rest of this suite signs in with `table` already stored, because those
 * specs are about the table — so this is the only place the real default is
 * checked, and the clearing is done by loading the page, removing the key and
 * reloading. An init script would have cleared it on the *reload* too, which
 * reads exactly like the preference failing to stick.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1512, height: 900 } });

async function forgetTheChoice(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.goto(path);
  await page.evaluate(() => {
    try {
      localStorage.removeItem('ipropy.listmode.leads');
      localStorage.removeItem('ipropy.listmode.properties');
    } catch { /* a browser refusing storage still gets the default */ }
  });
  await page.reload();
}

for (const module of ['leads', 'properties']) {
  test(`a fresh person lands on the iPROPY desk — /${module}`, async ({ page }) => {
    await forgetTheChoice(page, `/${module}`);
    await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  });
}

test('choosing the table keeps it chosen, on that module only', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });

  await page.locator('button[title="Table"]').click();
  await expect(page.locator('table').first()).toBeVisible();

  // The point of remembering it: a reload, not a re-render.
  await page.reload();
  await expect(page.locator('table').first()).toBeVisible({ timeout: 30_000 });

  // And the habit is per module — a choice made on Contacts must not follow
  // somebody to Inventory, which is a different job on the same screen.
  await page.goto('/properties');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
});

test('the record\'s own tabs open inside the desk, not on another page', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  const listUrl = page.url();

  /*
    The complaint this answers: every tab used to send you to the record page,
    which is the trip the desk exists to save. So the assertion is not only
    that each tab renders — it is that the URL never moved.
  */
  for (const tab of ['Timeline', 'Matching', 'Files', 'Calls', 'WhatsApp']) {
    await page.getByRole('button', { name: new RegExp(`^${tab}`) }).first().click();
    await expect(page.getByTestId('ipropy-workspace')).toBeVisible();
    expect(page.url(), `${tab} navigated away from the list`).toBe(listUrl);
  }
});

test('a record can be edited from the desk and the change sticks', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /^Edit$/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  // Company is free text, optional, and on no list this suite asserts against.
  const marker = `Desk edit ${Date.now()}`;
  const company = dialog.getByLabel('Company');
  await company.fill(marker);
  await dialog.getByRole('button', { name: /save changes/i }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // Saved, not merely accepted: reopening reads it back from the server.
  await page.getByRole('button', { name: /^Edit$/ }).first().click();
  await expect(page.getByRole('dialog').getByLabel('Company')).toHaveValue(marker, { timeout: 20_000 });
});

test('the desk offers the record, its fields and a way to delete it', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  // The field card is what makes the desk somewhere a value gets fixed rather
  // than only read, and Delete is what makes it somewhere the work finishes.
  await expect(desk.getByText('Basic Information')).toBeVisible();
  await expect(page.locator('button[title^="Delete "]')).toBeVisible();
});
