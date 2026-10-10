/**
 * The record's one menu bar, arranged by the person using it.
 *
 * **2 October 2026, the owner:** *"Please Make Menu tab Drag and drop in menu
 * bar, so that user can set menu button and they can choose button as per their
 * priority and if button too much, then 'More hamburger' will be shown … And
 * all tab of activity move/merge in to menu bar i.e All, Comment, Messages,
 * Calls, Changes, Files and after selection of a Tab please give a option to
 * make New call/Post Comment/Add New files/Send New whatsapp … after the Resign
 * Middle Menu bar then the extra icon of Header also will be remove from header
 * like, Star, Tag icons."*
 *
 * Both modules, because *"All changes should be in all Modules"* — "it works on
 * leads" is exactly how a module gets left behind.
 *
 * The arrangement lives in the browser's own storage, so the only way to prove
 * it stuck is to move something and reload. Each test clears the key first:
 * otherwise a run inherits the previous run's arrangement and proves nothing.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

const MODULES = ['leads', 'properties'] as const;

async function openFirstRecord(page: import('@playwright/test').Page, module: string): Promise<void> {
  await page.goto(`/${module}`);
  await page.evaluate((name) => {
    try { localStorage.removeItem(`ipropy.recordMenu.${name}`); } catch { /* a browser refusing storage still gets the default */ }
  }, module);
  await page.reload();
  await expect(page.getByText(/[\d,]+ records/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('queue-card').first().click();
  await expect(page.getByTestId('record-menu-bar')).toBeVisible();
}

for (const module of MODULES) {
  test(`${module}: as many as fit on the bar, and More for the rest`, async ({ page }) => {
    await openFirstRecord(page, module);
    const bar = page.getByTestId('record-menu-bar');
    /*
      **Not a fixed five.** Since 3 October 2026 the bar measures itself and
      carries as many entries as the width allows — the owner's *"if Menu bar
      is full otherwise all menus shown in toolbar till hidden/overlapping"*.
      So the promise is that something is on it and that More is there, not a
      number: a number would be a measurement of this machine's window.
    */
    const more = page.getByTestId('record-menu-more');
    await expect(more).toBeVisible();
    expect(await bar.locator('button').count()).toBeGreaterThan(1);

    await more.click();
    // The record's own actions are in it, so it is never an empty control.
    await expect(page.getByRole('button', { name: /Summarise with AI/ })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test(`${module}: nothing is lost when the bar runs out of room`, async ({ page }) => {
    await openFirstRecord(page, module);
    const bar = page.getByTestId('record-menu-bar');
    const wide = await bar.locator('button').count();
    // At 900px the responsive queue collapses, giving the menu more room.
    // Use a phone-width window to actually exercise menu overflow.
    await page.setViewportSize({ width: 600, height: 900 });
    // Measured, not read off a number: narrow the window and the bar gives
    // something up.
    await expect(async () => {
      expect(await bar.locator('button').count()).toBeLessThan(wide);
    }).toPass({ timeout: 10_000 });
    // And what left the bar is reachable, which is the half that matters.
    await page.getByTestId('record-menu-more').click();
    await expect(page.getByRole('button', { name: /Move .* to the front of the bar/ }).first()).toBeVisible();
  });

  test(`${module}: the activity tabs are in the bar, not a second row`, async ({ page }) => {
    await openFirstRecord(page, module);
    // The stream's own chip row is gone: it named Calls and Files a second
    // time, two rows apart, meaning something different each time.
    await expect(page.getByRole('group', { name: 'Show in the timeline' })).toHaveCount(0);
    // Comments is on the bar, and choosing it still shows the stream.
    await page.getByTestId('record-menu-bar').getByRole('button', { name: /^Notes/ }).click();
    await expect(page.getByTestId('activity-feed')).toBeVisible();
  });

  test(`${module}: the bar offers what the section lets you start`, async ({ page }) => {
    await openFirstRecord(page, module);
    await page.getByTestId('record-menu-bar').getByRole('button', { name: /^Notes/ }).click();
    const action = page.getByTestId('record-menu-action');
    await expect(action).toBeVisible();
    await action.getByRole('button', { name: 'Write a note' }).click();
    // It puts the cursor in the note box that is already there rather than
    // opening a second one: two places to type is two drafts to lose.
    await expect(page.locator('[data-testid="note-box"]:focus')).toHaveCount(1);
  });

  test(`${module}: an arrangement sticks`, async ({ page }) => {
    await openFirstRecord(page, module);
    const bar = page.getByTestId('record-menu-bar');
    const before = (await bar.locator('button').allInnerTexts()).slice(0, 2);
    // Alt and an arrow key, because dragging is a mouse and an arrangement a
    // keyboard cannot reach is one half the team does not have.
    await bar.locator('button').first().focus();
    await page.keyboard.press('Alt+ArrowRight');
    const after = (await bar.locator('button').allInnerTexts()).slice(0, 2);
    expect(after[0]).not.toBe(before[0]);
    await page.reload();
    await expect(page.getByTestId('record-menu-bar')).toBeVisible({ timeout: 30_000 });
    const reloaded = (await page.getByTestId('record-menu-bar').locator('button').allInnerTexts()).slice(0, 2);
    expect(reloaded[0]).toBe(after[0]);
  });

  test(`${module}: star and tag actions are available in the record header`, async ({ page }) => {
    await openFirstRecord(page, module);
    const header = page.getByTestId('ipropy-workspace');
    await expect(header.getByRole('button', { name: /Star this record|Remove from starred/ })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Edit record tags', exact: true })).toBeVisible();
    // The actions moved out of More; do not leave duplicate menu controls.
    await page.getByTestId('record-menu-more').click();
    await expect(page.getByRole('button', { name: /Add a tag|^Tags \(/ })).toHaveCount(0);
  });
}
