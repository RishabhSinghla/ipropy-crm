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
 * this, 169px after the first pass, and 145px once the chips went into a row
 * and the agent moved up beside the page number — same record, same window.
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
    expect(headerBox!.height).toBeLessThan(180);

    const avatar = header.locator('img, [class*="rounded-full"]').first();
    const avatarBox = await avatar.boundingBox();

    // The name sits above the face now, not under it.
    const name = header.getByRole('heading').first();
    const nameBox = await name.boundingBox();
    expect(nameBox, 'no name in the hero').not.toBeNull();
    if (avatarBox) expect(nameBox!.y).toBeLessThan(avatarBox.y);
  });
}

test('the chase date, stage and call outcome sit below the actions on the right', async ({ page }) => {
  await openFirstRecord(page, 'leads');
  const header = page.locator('section header').first();

  // The chase-date chip, by the words it prints rather than by a class.
  const chip = header.getByText(/^(Today|Tomorrow|Pending|Overdue)/i).first();
  if (await chip.count() === 0) test.skip(true, 'this record has no chase date to show');

  const chipBox = await chip.boundingBox();
  const avatarBox = await header.getByTestId('split-hero-avatar').boundingBox();
  const actionRowBox = await header.getByTestId('split-hero-actions-status').locator('> span').first().boundingBox();
  expect(chipBox, 'the chase date has no box').not.toBeNull();
  expect(avatarBox, 'the avatar has no box').not.toBeNull();
  expect(actionRowBox, 'the actions have no box').not.toBeNull();

  expect(chipBox!.x).toBeGreaterThan(avatarBox!.x + avatarBox!.width);
  expect(chipBox!.y).toBeGreaterThanOrEqual(actionRowBox!.y + actionRowBox!.height);
});

test('the three chips read as one row, not a column', async ({ page }) => {
  // A width a rep actually works at. At a narrow pane the third chip wraps on
  // purpose, which is the graceful answer rather than one that leaves the
  // panel — so the promise is pinned where it is a promise.
  await page.setViewportSize({ width: 1600, height: 900 });
  await openFirstRecord(page, 'leads');

  const header = page.locator('section header').first();
  const chipRow = header.getByTestId('split-hero-status-row').locator('> span');

  /*
    The row's own height, not each chip's top. They are centred against one
    another and differ by a pixel or two, so comparing tops reports the
    alignment rather than the wrapping — which is how this assertion first
    failed against a row that was plainly one line on screen.
  */
  const box = await chipRow.boundingBox();
  expect(box, 'no chips beside the face').not.toBeNull();

  const count = await chipRow.evaluate((el) => el.children.length);
  expect(count, 'nothing to lay out').toBeGreaterThan(1);

  // One row of small chips is 24px. A second line would be about 28 more.
  expect(box!.height, `the chips are ${box!.height}px tall — that is more than one row`)
    .toBeLessThan(34);
});

/**
 * The face starts the operational row and the actions use the remaining space.
 * This deliberately replaces the former centre-pinned layout.
 */
for (const width of [1600, 1280]) {
  test(`the face stays left of actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFirstRecord(page, 'leads');

    const row = page.locator('section header').first().getByTestId('split-hero-layout');
    const avatar = await row.getByTestId('split-hero-avatar').boundingBox();
    const actions = await row.getByTestId('split-hero-actions-status').boundingBox();
    expect(avatar, 'the avatar has no box').not.toBeNull();
    expect(actions, 'the actions have no box').not.toBeNull();
    expect(avatar!.x + avatar!.width).toBeLessThan(actions!.x + actions!.width);
  });
}
