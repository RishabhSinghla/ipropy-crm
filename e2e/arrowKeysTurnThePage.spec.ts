/**
 * Left and right arrows turn the page, on every module.
 *
 * **29 September 2026, the owner:** *"Arrow Key doesn\'t Work for Next record
 * or Back Record, Keep in mind all changes mandatory for all modules"*, then,
 * correcting himself: *"Sorry its arrow key from laptop for next page and back
 * page."* So this is the pager at the top right — the ‹ 1 / 10 › — which until
 * now could only be clicked.
 *
 * Only a browser can settle it: it is a document-level key listener, and what
 * makes it safe is *where* the key landed, which is a fact about the live DOM
 * rather than about the function.
 */
import { test, expect, type Page } from '@playwright/test';

const MODULES = [
  { path: '/leads', name: 'Contacts' },
  { path: '/properties', name: 'Inventories' },
];

/** Which page the list is on, read off the pager's own box. */
async function pageNumber(page: Page): Promise<string> {
  return page.getByRole('spinbutton', { name: 'Go to page' }).first().inputValue();
}

for (const module of MODULES) {
  test.describe(module.name, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto(module.path);
      await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
    });

    test('right turns forward and left comes back', async ({ page }) => {
      test.skip(await pageNumber(page) === '' , 'no pager on this list');
      // Click the page background so focus is on no control in particular —
      // which is how a rep who has just been reading arrives at the keyboard.
      await page.locator('body').click({ position: { x: 5, y: 400 } });

      await page.keyboard.press('ArrowRight');
      await expect.poll(() => pageNumber(page), { timeout: 15_000 }).toBe('2');

      await page.keyboard.press('ArrowLeft');
      await expect.poll(() => pageNumber(page), { timeout: 15_000 }).toBe('1');
    });

    test('an arrow typed into a box moves the cursor, never the page', async ({ page }) => {
      const box = page.getByPlaceholder(/Search/i).first();
      await box.click();
      await box.fill('abc');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(800);
      expect(await pageNumber(page), 'typing in a box turned the page').toBe('1');
    });

    test('the first page does not go back past itself', async ({ page }) => {
      await page.locator('body').click({ position: { x: 5, y: 400 } });
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(600);
      expect(await pageNumber(page)).toBe('1');
    });
  });
}
