/**
 * A list opens on the split view, and a different choice sticks.
 *
 * The owner asked for the desk to be what everybody lands on, in both modules,
 * with anybody free to switch. Both halves need a browser: the default lives in
 * the browser's own storage, and "it stuck" means it survived a reload.
 *
 * Since 27 September 2026 the split view is the only view, so the clearing
 * below is belt and braces: it proves an old stored choice changes nothing.
 * It is done by loading the page, removing the key and reloading. An init script would have cleared it on the *reload* too, which
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

/**
 * The middle pane — the record itself.
 *
 * Since the three-pane rebuild of 27 September 2026 it is a `<section>` rather
 * than a `<main>`, and `page.locator('main')` also matches the app shell's own
 * `<main>`, whose first heading is not the record's name. One helper, so a
 * spec cannot accidentally measure the shell.
 */
function recordPane(page: import('@playwright/test').Page) {
  return page.getByTestId('ipropy-workspace').locator('section').filter({ has: page.getByRole('navigation', { name: 'Record workspace sections' }) }).first();
}

for (const module of ['leads', 'properties']) {
  test(`a fresh person lands on the split view — /${module}`, async ({ page }) => {
    await forgetTheChoice(page, `/${module}`);
    await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  });
}

test('the split view is the only view, whatever a browser remembers', async ({ page }) => {
  /*
    27 September 2026, the owner: the table and the board are gone. A browser
    that remembered choosing the table before then must still land on the
    split view, and nothing offers a way back to a view that no longer exists.
  */
  await page.goto('/leads');
  await page.evaluate(() => {
    try { localStorage.setItem('ipropy.listmode.leads', 'table'); } catch { /* private window */ }
  });
  await page.reload();
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('table')).toHaveCount(0);
  await expect(page.locator('button[title="Table"], button[title="Kanban"]')).toHaveCount(0);
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
  // Delete moved into the three-dot menu on 19 September — one destructive
  // action a thumb's width from Call was one accident waiting — so it is
  // reached rather than sitting in the open.
  await expect(desk.getByText('Basic Information')).toBeVisible();
  await desk.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('button', { name: /^Delete/ })).toBeVisible();
});

test('the queue is faces and facts, with the completeness bar off it', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  const queue = page.locator('aside').first();

  /*
    How complete a record is belongs to the record, not to the queue — the
    owner asked for it off this side. It is still on the open record, thinner
    than it was, so the two assertions together say where it went rather than
    only that it left.
  */
  await expect(queue.getByRole('img', { name: /Record \d+% complete/ })).toHaveCount(0);
  /*
    27 September 2026: it is the ring around the face in the record hero now,
    which is where the prototype puts it. Still a `role="img"` with the same
    spoken label, so this assertion says where it went rather than only that it
    left the queue.
  */
  await expect(recordPane(page).getByRole('img', { name: /Form strength \d+%/ })).toBeVisible();

  /*
    The chevron that used to sit at the end of every row is gone. It pointed
    at nothing — the record opens in the pane already on screen — and the
    owner's word for it was "irritating".
  */
  await expect(queue.locator('svg.lucide-chevron-right')).toHaveCount(0);
});

test('the record\'s controls sit either side of the name, not above it', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });

  /*
    The prototype of 27 September 2026 centres the face and the name and puts
    the controls in two groups either side of it. Measured rather than read off
    a class: the star has to fall on the same band as the name and to the
    *right* of it, which is the only thing that says it is beside the name
    rather than stacked above it.
  */
  const header = recordPane(page).locator('header').first();
  const name = header.getByRole('heading').first();
  const star = header.locator('button[title$="starred"], button[title^="Star "]').first();
  const nameBox = (await name.boundingBox())!;
  const starBox = (await star.boundingBox())!;
  const middle = starBox.y + starBox.height / 2;

  expect(starBox.x, 'the star is to the left of the name').toBeGreaterThan(nameBox.x);
  expect(middle, 'the star sits above the name block').toBeGreaterThan(nameBox.y - 90);
  expect(middle, 'the star sits below the name block').toBeLessThan(nameBox.y + nameBox.height + 20);
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

  /*
    And the one menu that orders the queue, which is what replaced the bare
    word STATUS in that header. Ordering only: it used to carry a second
    section choosing which follow-ups to show, and the toolbar above already
    has that control — two ways to ask one question is how they end up
    disagreeing.

    **27 September 2026:** the menu used to be one row per field — the name
    A–Z, each subtitle field A–Z, the stage — and the owner asked for those to
    go. It is eight named questions with **one** A–Z / Z–A control for the
    whole menu now, and nothing chosen until somebody chooses.
  */
  await page.getByRole('button', { name: 'Sort this list' }).click();
  await expect(page.getByRole('button', { name: 'Everyone' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sort this list' })).toContainText('No sorting');

  await page.getByTestId('queue-sort-menu').getByText('Recently updated', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sort this list' })).toContainText('Recently updated');

  // The direction is its own control, and it is dead until an order is chosen.
  await page.getByRole('button', { name: 'Sort this list' }).click();
  await page.getByRole('button', { name: 'A–Z', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sort this list' })).toContainText('Recently updated');
});

test('the notes are the third pane, beside the record', async ({ page }) => {
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  /*
    **27 September 2026, the owner:** three panes, with *"call deck merge in to
    Note/Comment pane/Box"*. The notes moved out from under the fields and into
    a pane of their own on the right, which is the half that used to be taken
    away whenever a call started.

    Measured rather than read off a class name, because a class that is present
    while the pane still sits underneath is exactly the bug.
  */
  const fields = desk.getByText(/Information$/).first();
  const notes = desk.getByTestId('notes-panel');
  await expect(notes).toBeVisible();
  const fieldsBox = (await fields.boundingBox())!;
  const notesBox = (await notes.boundingBox())!;
  expect(notesBox.x, 'the notes are not to the right of the fields').toBeGreaterThan(fieldsBox.x);
  expect(notesBox.y, 'the notes start below the fields rather than beside them').toBeLessThan(fieldsBox.y + 200);

  // Three panes, so the queue's divider is still the only one that drags.
  await expect(page.getByRole('separator', { name: 'Resize the notes panel' })).toHaveCount(0);
  await expect(page.getByRole('separator', { name: 'Resize the list' })).toHaveCount(1);
});

test('a record\'s tags read as chips, before the icons', async ({ page }) => {
  /*
    The owner asked for tags visible on the record in every view, "in chip
    shape … beside and before the icons". They used to trail the name after
    "Updated …", capped at two, which is where a chip goes unread.

    Measured rather than read off a class: the chip has to sit to the *left* of
    the star, which is the only thing that says it is before the icons rather
    than merely present somewhere in the header.
  */
  await forgetTheChoice(page, '/leads');
  const desk = page.getByTestId('ipropy-workspace');
  await expect(desk).toBeVisible({ timeout: 30_000 });

  const header = recordPane(page).locator('header').first();
  const dialog = page.getByRole('dialog');
  /*
    Retried, because the "Tags updated" toast lands over this corner of the
    header for a few seconds and a click that hits it opens nothing at all.
  */
  const openTheDialog = async (): Promise<void> => {
    await expect(async () => {
      await header.getByRole('button', { name: 'Edit tags' }).click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  };

  await openTheDialog();
  // A tag, not the dialog's own controls — and not its icon-only close
  // button, whose empty name slips through a `hasNotText` filter and shuts
  // the dialog instead of choosing anything.
  const option = dialog.getByRole('button')
    .filter({ hasText: /\w/ })
    .filter({ hasNotText: /^(Cancel|Save tags)$/ })
    .first();
  if (!(await option.count())) test.skip(true, 'no tags in this database');
  const name = (await option.innerText()).trim();
  await option.click();
  await dialog.getByRole('button', { name: 'Save tags' }).click();
  await expect(dialog).toHaveCount(0);

  const chip = header.getByText(name, { exact: true }).first();
  await expect(chip).toBeVisible({ timeout: 10_000 });
  const star = header.locator('button[title$="starred"], button[title^="Star "]').first();
  const chipBox = (await chip.boundingBox())!;
  const starBox = (await star.boundingBox())!;
  expect(chipBox.x, 'the tag chip is not before the icons').toBeLessThan(starBox.x);

  // Put the record back the way it was found.
  await openTheDialog();
  await dialog.getByRole('button', { name }).first().click();
  await dialog.getByRole('button', { name: 'Save tags' }).click();
  await expect(chip).toHaveCount(0, { timeout: 10_000 });
});
