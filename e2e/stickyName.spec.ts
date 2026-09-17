/**
 * The name column stays put when the grid scrolls sideways.
 *
 * A wide table scrolled right left every row anonymous: the columns moved and
 * the one saying *who this is* went with them. The checkbox and the first
 * column are pinned, the way a spreadsheet freezes its first column.
 *
 * Two assertions, because either alone can pass while the screen is wrong.
 * The computed style is the rule; the measurement is the proof, and it only
 * runs when this database's list is wide enough to scroll at all — a rule that
 * holds on a grid with nothing to scroll has proved nothing.
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Wide enough for the desktop table — below 1024px the list renders as cards.
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto('/leads');
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
});

test('the checkbox and the name are pinned to the left of the grid', async ({ page }) => {
  const row = page.locator('tbody tr').first();
  const box = row.locator('td').first();
  const name = row.locator('td').nth(1);

  await expect(box).toHaveCSS('position', 'sticky');
  await expect(box).toHaveCSS('left', '0px');
  await expect(name).toHaveCSS('position', 'sticky');
  // The name starts where the checkbox column ends (SELECT_COL_WIDTH).
  await expect(name).toHaveCSS('left', '40px');

  /*
    A pinned cell with a see-through background lets the scrolling columns
    read straight through it, which is worse than not pinning it at all. The
    stripe lives on the <tr>, so the cell inherits a real colour.
  */
  for (const cell of [box, name]) {
    const bg = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg, 'a pinned cell must be opaque').not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
});

/*
  The whole header row stays while the rows scroll under it. It reads as a
  one-line rule and was broken for real: the header cell carried Tailwind's
  `relative`, which wins on source order over the sticky the header class
  applies, so every column heading scrolled away with its rows.
*/
test('the column headings stay while the rows scroll under them', async ({ page }) => {
  const heading = page.locator('thead th').nth(2);
  await expect(heading).toHaveCSS('position', 'sticky');

  const handle = await page.locator('table').first().evaluateHandle((table) => {
    let el: HTMLElement | null = table.parentElement;
    while (el && el.scrollHeight - el.clientHeight < 100) el = el.parentElement;
    return el;
  });
  const scroller = handle.asElement();
  if (!scroller) test.skip(true, 'not enough rows to scroll');

  const before = Math.round((await heading.boundingBox())!.y);
  await scroller!.evaluate((el) => { (el as HTMLElement).scrollTop = 700; });
  await expect.poll(async () => Math.round((await heading.boundingBox())!.y)).toBe(before);
});

test('the name does not move when the table scrolls sideways', async ({ page }) => {
  const name = page.locator('tbody tr').first().locator('td').nth(1);
  const handle = await page.locator('table').first().evaluateHandle((table) => {
    let el: HTMLElement | null = table.parentElement;
    while (el && el.scrollWidth - el.clientWidth < 40) el = el.parentElement;
    return el;
  });
  const scroller = handle.asElement();
  if (!scroller) test.skip(true, 'this list fits the window, so there is nothing to scroll');

  const before = Math.round((await name.boundingBox())!.x);
  await scroller!.evaluate((el) => { (el as HTMLElement).scrollLeft = (el as HTMLElement).scrollWidth; });
  await expect.poll(async () => Math.round((await name.boundingBox())!.x)).toBe(before);
});
