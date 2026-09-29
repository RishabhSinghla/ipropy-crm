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
  // A width a rep actually works at. Below about 1400 the hero deliberately
  // wraps its controls onto a second row, which is the graceful answer and not
  // the promise these measure.
  await page.setViewportSize({ width: 1600, height: 900 });
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

    const avatarBox = await header.getByTestId('split-hero-avatar').boundingBox();

    /*
      **The name sits beside the face, with the number under it** — the owner,
      29 September 2026: *"Move Full Name and Mobile adjoining avtar … the name
      and Mobile should be in two row, first row is Name then Below/Second Row
      is Mobile."* They used to ride the row above, at the far end of the
      header from the face they belong to.
    */
    const name = header.getByRole('heading').first();
    const nameBox = await name.boundingBox();
    expect(nameBox, 'no name in the hero').not.toBeNull();
    expect(avatarBox, 'no face in the hero').not.toBeNull();
    expect(nameBox!.x, 'the name should start after the face').toBeGreaterThan(avatarBox!.x);
    expect(nameBox!.y, 'the name should sit level with the face, not above it')
      .toBeGreaterThan(avatarBox!.y - 4);
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

test('the three key pairs read as one row, side by side', async ({ page }) => {
  await openFirstRecord(page, 'leads');

  /*
    Each pair is **two lines now** — the field's name above its value, on the
    owner's instruction of 29 September 2026 — so a height of one small chip
    is no longer the measurement. What is still a promise is that the three
    pairs sit *beside* one another rather than stacking into a column, which
    is what they do when the pane runs out of room.
  */
  const tops = await page.locator('[data-testid="hero-chips"]').evaluate((group) =>
    [...group.children].map((child) => Math.round(child.getBoundingClientRect().top)));

  expect(tops.length, 'nothing to lay out').toBeGreaterThan(1);
  expect(Math.max(...tops) - Math.min(...tops), `the pairs start at ${tops.join(', ')} — that is a column`)
    .toBeLessThan(4);
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
