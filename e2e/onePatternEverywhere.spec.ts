/**
 * One pattern on a phone, a tablet and a laptop — list, tap, record, back.
 *
 * **2 October 2026, the owner:** *"I want to make is as simple as GMAIL/
 * WhatsApp App with all function and filter system … a ten year child can be
 * use this app and we can use Web app, Safari app, Android app in same
 * format."*
 *
 * Below `xl` the two panes used to **stack**, so a phone had to scroll past
 * fifty records to reach the one it had just opened. Now one pane has the
 * screen at a time, exactly as every phone app works, and a wide screen is
 * unchanged — which is the same pattern with room for both, and what Gmail
 * does too.
 *
 * Only a browser can settle any of this: it is entirely about what is on
 * screen at a given width.
 */
import { test, expect, type Page } from '@playwright/test';

const PHONE = { width: 390, height: 844 };     // iPhone 14 / a mid Android
const LAPTOP = { width: 1600, height: 1000 };

async function openList(page: Page, path = '/leads'): Promise<void> {
  await page.goto(path);
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
}

const firstCard = (page: Page) => page.locator('[data-testid="queue-card"]').first();

for (const path of ['/leads', '/properties']) {
  test(`${path}: a phone shows the list, then the record, then the list again`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openList(page, path);

    // 1. The list has the screen to itself.
    await expect(firstCard(page)).toBeVisible();
    await expect(page.getByTestId('activity-pane')).toBeHidden();

    // 2. Tapping a row gives the record the whole screen.
    await firstCard(page).click();
    await expect(page.getByTestId('split-hero-layout')).toBeVisible({ timeout: 20_000 });
    await expect(firstCard(page)).toBeHidden();

    // 3. And the way back is where every phone app puts it.
    const back = page.getByTestId('back-to-list');
    await expect(back).toBeVisible();
    await back.click();
    await expect(firstCard(page)).toBeVisible({ timeout: 20_000 });
  });
}

test('a laptop shows both at once, and offers no way "back"', async ({ page }) => {
  await page.setViewportSize(LAPTOP);
  await openList(page);

  // The split view is unchanged: the queue and the record side by side.
  await expect(firstCard(page)).toBeVisible();
  await expect(page.getByTestId('split-hero-layout')).toBeVisible();
  // Nothing to go back to, so nothing is drawn.
  await expect(page.getByTestId('back-to-list')).toBeHidden();
});

test("the list's pager stands down while a record has a phone's screen", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openList(page);

  const pager = page.getByLabel('Go to page').first();
  await expect(pager, 'the list should offer its pager').toBeVisible();

  await firstCard(page).click();
  await expect(page.getByTestId('split-hero-layout')).toBeVisible({ timeout: 20_000 });
  // A record opened on a phone sitting above a pager for a list that is not on
  // screen is the first thing anybody would call broken.
  await expect(pager).toBeHidden();
});

test('the record keeps its name readable on a phone', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openList(page);
  await firstCard(page).click();

  const header = page.getByTestId('split-hero-layout');
  await expect(header).toBeVisible({ timeout: 20_000 });

  /*
    Measured, not read off a class: sharing one line with the controls, the
    name truncated to three characters — the same fault the chat header met
    once. The heading has to be shown whole.
  */
  const name = header.getByRole('heading').first();
  const cut = await name.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(cut, 'the record name is being cut off on a phone').toBeLessThan(4);
});
