/**
 * A list opens on the split view, and a different choice sticks.
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
import { fieldEditor } from './helpers';

test.use({ viewport: { width: 1600, height: 900 } });

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
  test(`a fresh person lands on the split view — /${module}`, async ({ page }) => {
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

test('a value is typed in where it stands, and the change sticks', async ({ page }) => {
  /*
    The owner's instruction on 19 September: "no clicking of edit button, no
    opening of any other sort of things, just write then and there". So this
    spec replaces the one that opened a dialog — it clicks the value itself.
  */
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  // Company is free text, optional, and on no list this suite asserts against.
  const marker = `Split edit ${Date.now()}`;
  const cell = fieldEditor(page, /^Change Company$/);
  await expect(cell).toBeVisible({ timeout: 20_000 });
  await cell.click();

  // Scoped to the page, not the desk: the editor floats in a portal on
  // `body`, so a locator rooted in the workspace finds nothing at all.
  const box = page.getByRole('textbox', { name: /company/i }).first();
  await expect(box).toBeVisible({ timeout: 10_000 });
  await box.fill(marker);
  await box.press('Enter');

  /*
    Saved, not merely accepted: a reload reads it back from the server. And no
    dialog appeared at any point, which is the other half of the ask.
  */
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('ipropy-workspace').getByText(marker)).toBeVisible({ timeout: 30_000 });
});

test('nothing in the split view sends you to another page', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  /*
    Both buttons the owner asked to be rid of: the Edit button that opened a
    dialog, and the one beside Delete that opened the record's own page. The
    whole record is here, so neither has anywhere better to go.
  */
  await expect(desk.getByRole('button', { name: /^Edit$/ })).toHaveCount(0);
  await expect(page.locator('button[title="Open the full record page"]')).toHaveCount(0);

  // And the two that stayed are icons, not sentences.
  const call = page.locator('button[title^="Call "]').first();
  if (await call.count()) await expect(call).not.toContainText('Call');
});

test('the divider moves the split, and the width is remembered', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });

  const queue = page.locator('aside').first();
  const before = (await queue.boundingBox())!.width;

  /*
    Keyboard rather than a drag. A pointer drag is the gesture a rep performs,
    but it is also the flakiest thing Playwright can be asked to do across a
    1.5px target — and the handler is the same either way, so the arrow keys
    prove the divider moves and the reload proves it was remembered.
  */
  const handle = page.getByRole('separator', { name: 'Resize the list' });
  await expect(handle).toBeVisible();
  await handle.focus();
  for (let i = 0; i < 4; i += 1) await handle.press('ArrowRight');

  const after = (await queue.boundingBox())!.width;
  expect(after, 'the divider did not move the list').toBeGreaterThan(before);

  await page.reload();
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  const remembered = (await page.locator('aside').first().boundingBox())!.width;
  expect(Math.abs(remembered - after), 'the width was not remembered').toBeLessThan(4);
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

test('the queue leads with a face, a bar and the module\'s own fact', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  const queue = page.locator('aside').first();

  // How complete the record is, as a line with the number beside it, rather
  // than as a ring around the avatar.
  await expect(queue.getByRole('img', { name: /Record \d+% complete/ }).first()).toBeVisible();

  /*
    The chevron that used to sit at the end of every row is gone. It pointed
    at nothing — the record opens in the pane already on screen — and the
    owner's word for it was "irritating".
  */
  await expect(queue.locator('svg.lucide-chevron-right')).toHaveCount(0);
});

test('the queue can be ticked in bulk and sorted from its own header', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  const queue = page.locator('aside').first();

  // One box beside the module's name ticks everything on the page, which is
  // what the bulk-edit bar needs to appear.
  const all = queue.getByRole('checkbox', { name: /^Select all/ });
  await all.check();
  await expect(queue.getByRole('checkbox').nth(1)).toBeChecked();
  await expect(page.getByText(/selected/i).first()).toBeVisible();
  await all.uncheck();

  // And the one menu that orders the queue, which is what replaced the bare
  // word STATUS in that header.
  await page.getByRole('button', { name: 'Sort this list' }).click();
  await page.getByRole('button', { name: /A–Z/ }).first().click();
  await expect(page.getByRole('button', { name: 'Sort this list' })).toContainText('A–Z');
});

test('the notes sit beside the record rather than in a third column', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  /*
    Two panes, as the owner asked: the notes moved out of their own column and
    in beside the fields. Measured rather than read off a class name, because
    a class that is present while the card still sits underneath is exactly
    the bug.
  */
  const fields = desk.getByText('Basic Information').first();
  const notes = desk.getByRole('heading', { name: 'Notes' });
  await expect(notes).toBeVisible();
  const fieldsBox = (await fields.boundingBox())!;
  const notesBox = (await notes.boundingBox())!;
  expect(notesBox.x, 'the notes are below the fields, not beside them').toBeGreaterThan(fieldsBox.x);
  expect(Math.abs(notesBox.y - fieldsBox.y), 'the notes start well below the fields').toBeLessThan(40);

  // And the third divider went with it.
  await expect(page.getByRole('separator', { name: 'Resize the notes panel' })).toHaveCount(0);
});
