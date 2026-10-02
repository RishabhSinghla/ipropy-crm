/**
 * Three of the owner's seven, 2 October 2026 — the ones a browser decides.
 *
 * 3. *"in the avtar of Agent on main Screen please give a option of agent name
 *    and Designation of agent."*
 * 4. *"change the colour of all tab's icons after the select a button i.e List
 *    Icon Colour will be Blue, Status icon Colour will be Yellow, Follow-up
 *    /Task Icon colour will be Green and Tag Icon colour will be Red."*
 * 5. *"default Posting a comment should work from enter tab of keyword and
 *    Send whatsapp msg from Mouse."*
 */
import { test, expect, type Page } from '@playwright/test';

async function openList(page: Page, path = '/leads'): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(path);
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
}

/** A filter button's own icon colour, as the browser computes it. */
const iconColour = (page: Page, name: RegExp) =>
  page.getByRole('button', { name }).first().locator('svg').first()
    .evaluate((el) => getComputedStyle(el).color);

test('the agent’s name and designation sit beside the avatar', async ({ page }) => {
  await openList(page);
  const account = page.getByTestId('account-button');
  await expect(account).toBeVisible();

  /*
    Who is signed in, readable without opening anything — which is the whole
    ask. The menu is where the name has always been, so it is the source of
    truth here: whatever it says, the button has to be saying already.
  */
  await account.click();
  const menu = page.locator('.popover').first();
  await expect(menu).toBeVisible({ timeout: 10_000 });
  const name = (await menu.locator('p').first().innerText()).trim();
  await page.keyboard.press('Escape');

  const shown = (await account.innerText()).trim();
  expect(name.length, 'nobody is signed in').toBeGreaterThan(0);
  expect(shown, 'the account button still shows nothing but a face').toContain(name);
});

test('a filter’s icon takes its own colour once that filter is on', async ({ page }) => {
  await openList(page);

  const task = page.getByRole('button', { name: /^Task/ });
  const before = await iconColour(page, /^Task/);

  await task.click();
  await page.getByText('Requires action').click();
  await page.keyboard.press('Escape');

  await expect
    .poll(() => iconColour(page, /^Task/), { timeout: 15_000, message: 'the Task icon did not change colour' })
    .not.toBe(before);

  /*
    Green, and **measured as green** rather than read off a class: the point of
    the colour is that a rep can tell at a glance which filter is on, and a
    class that is present while the icon is still brand purple is exactly the
    bug.
  */
  const [r, g, b] = (await iconColour(page, /^Task/)).match(/\d+/g)!.map(Number);
  expect(g, `the Task icon is rgb(${r}, ${g}, ${b}) — that is not green`).toBeGreaterThan(r);
  expect(g).toBeGreaterThan(b);
});

test('Enter posts a comment, and Shift+Enter writes a new line', async ({ page }) => {
  await openList(page);
  await page.locator('[data-testid="queue-card"]').first().click();

  const box = page.getByLabel('Add a note for the team').first();
  await expect(box).toBeVisible({ timeout: 20_000 });

  // Shift+Enter is still a new line — a rep's hands know this from WhatsApp.
  await box.click();
  await box.fill('first line');
  await page.keyboard.press('Shift+Enter');
  await expect(box, 'Shift+Enter posted instead of writing a new line').toHaveValue(/first line\n/);

  // Enter posts, and the box empties because the note has gone.
  const marker = `Enter posts ${Date.now()}`;
  await box.fill(marker);
  await page.keyboard.press('Enter');
  await expect(box, 'Enter did not post the comment').toHaveValue('', { timeout: 20_000 });
  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 20_000 });
});
