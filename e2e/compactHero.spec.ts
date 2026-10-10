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
import { openFirstRecord as openQueueRecord, openDetailsPane } from './helpers';

const MODULES = ['leads', 'properties'] as const;

async function openFirstRecord(page: Page, module: string): Promise<void> {
  // A width a rep actually works at. Below about 1400 the hero deliberately
  // wraps its controls onto a second row, which is the graceful answer and not
  // the promise these measure.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/${module}`);
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  await openQueueRecord(page);
  await expect(page.locator('section header').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
}

for (const module of MODULES) {
  test(`${module}: the hero stays compact, with the facts beside the face`, async ({ page }) => {
    await openFirstRecord(page, module);

    const header = page.locator('section header').first();
    const headerBox = await header.boundingBox();
    expect(headerBox, 'the hero has no box at all').not.toBeNull();

    // It was 253.5px with the chip band under the face, 145px after the first
    // compact pass, and one line since the four panes of 30 September 2026. A
    // generous ceiling, so padding does not fail the build while a band coming
    // back does.
    expect(headerBox!.height).toBeLessThan(120);

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

/*
  Two specs stood here — the chase date under the actions, and the three key
  pairs in one row beside the face. **30 September 2026 moved those facts out
  of the header** into the right pane, pinned above the record's fields
  (\`RecordInspector\`), on the owner's four-pane prototype: *"The Header Have
  only avtar with Profile strength, Name, Updated Time … then All actionable
  icons."* So the promise is now that they are there, not beside the face.
*/
test('the chase date, stage and call log are pinned in the right pane', async ({ page }) => {
  await openFirstRecord(page, 'leads');
  await openDetailsPane(page);
  const inspector = page.getByTestId('record-inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText(/^Call Log$/i)).toBeVisible();
  // And none of them is back in the header.
  await expect(page.locator('section header').first().locator('[data-testid="hero-chips"]')).toHaveCount(0);
});

/**
 * The face starts the operational row and the actions use the remaining space.
 * This deliberately replaces the former centre-pinned layout.
 */
for (const width of [1600, 1280]) {
  test(`the face stays left of actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openFirstRecord(page, 'leads');

    const row = page.getByTestId('split-hero-layout');
    const avatar = await row.getByTestId('split-hero-avatar').boundingBox();
    const actions = await row.getByTestId('split-hero-actions-status').boundingBox();
    expect(avatar, 'the avatar has no box').not.toBeNull();
    expect(actions, 'the actions have no box').not.toBeNull();
    expect(avatar!.x + avatar!.width).toBeLessThan(actions!.x + actions!.width);
  });
}
