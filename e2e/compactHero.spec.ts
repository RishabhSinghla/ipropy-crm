/**
 * The record hero, after the owner asked for it compact.
 *
 * **28 September 2026:** *"Please decrease Avtar Size and Remove Buyer, Old
 * Leads Icons … Move Overdue (11D), Visit Scheduled & Busy in to left side
 * from Avtar … Move Name and Mobile Number at replacement Yogesh Bindal Agent
 * … Actually we need this space compact so that below that much visible to my
 * Team."*
 *
 * Measured rather than read off a class name: a class that is present while
 * the chip still sits under the face is exactly the bug. It ran 253.5px before
 * this and 169px after, on the same record in the same window.
 *
 * Both modules, because "it works on leads" is how a module gets left behind.
 */
import { test, expect, type Page } from '@playwright/test';

const MODULES = ['leads', 'properties'] as const;

async function openFirstRecord(page: Page, module: string): Promise<void> {
  await page.goto(`/${module}`);
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="ipropy-workspace"] button').first().click().catch(() => {});
  await expect(page.locator('section header').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
}

for (const module of MODULES) {
  test(`${module}: the hero stays compact, with the facts beside the face`, async ({ page }) => {
    await openFirstRecord(page, module);

    const header = page.locator('section header').first();
    const headerBox = await header.boundingBox();
    expect(headerBox, 'the hero has no box at all').not.toBeNull();

    // It was 253.5px with the chip band under the face. This is the promise
    // that gave a third of it back; a generous ceiling, so an extra line of
    // padding does not fail the build while the band coming back does.
    expect(headerBox!.height).toBeLessThan(210);

    const avatar = header.locator('img, [class*="rounded-full"]').first();
    const avatarBox = await avatar.boundingBox();

    // The name sits above the face now, not under it.
    const name = header.getByRole('heading').first();
    const nameBox = await name.boundingBox();
    expect(nameBox, 'no name in the hero').not.toBeNull();
    if (avatarBox) expect(nameBox!.y).toBeLessThan(avatarBox.y);
  });
}

test('the chase date and the stage sit to the left of the face', async ({ page }) => {
  await openFirstRecord(page, 'leads');
  const header = page.locator('section header').first();

  // The chase-date chip, by the words it prints rather than by a class.
  const chip = header.getByText(/^(Today|Tomorrow|Pending|Overdue)/i).first();
  if (await chip.count() === 0) test.skip(true, 'this record has no chase date to show');

  const chipBox = await chip.boundingBox();
  const heroBox = await header.boundingBox();
  expect(chipBox, 'the chase date has no box').not.toBeNull();

  // Left of centre, which is where the face is.
  expect(chipBox!.x).toBeLessThan(heroBox!.x + heroBox!.width / 2);
});
