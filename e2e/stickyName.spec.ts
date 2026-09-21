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

  /*
    A grid wide enough to scroll, made rather than hoped for.

    The table is `table-fixed w-full`, so with the shipped widths the columns
    shrink to fit and there is nothing to scroll sideways at all — which is a
    fact about this browser's saved layout, not about the pinning, and it is
    what made this spec read as a failing feature for a day. Column widths live
    in localStorage per browser (`lib/columnWidths.ts`), so setting a wide one
    is the same thing a rep does by dragging a divider.
  */
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ipropy.colwidths.leads', JSON.stringify({
        full_name: 420, mobile: 320, email: 420, lead_status: 320, contact_type: 320,
      }));
    } catch { /* a private window; the assertion below says so */ }
  });

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
  The header row scrolling away with its rows is covered whole, on both
  modules, by `listHeaderStaysPut.spec.ts` — every header cell rather than the
  first, which is the distinction that let the bug hide. Not repeated here.
*/
test('the name does not move when the table scrolls sideways', async ({ page }) => {
  const name = page.locator('tbody tr').first().locator('td').nth(1);
  /*
    The table's **own** horizontal scroller, and nothing else.

    This used to walk up until it found any ancestor with something to scroll,
    which on a window where the columns happen to fit sails past the table's
    container and lands on an unrelated one. Scrolling that moves the whole
    table, pinned cell included, and the test fails about a column that is
    pinned perfectly well — which is how this spent a day being read as a real
    bug. The column widths are per browser, so which machine this runs on
    decides whether the table overflows at all: the same rule as the unique
    markers, applied to a saved layout.
  */
  const handle = await page.locator('table').first().evaluateHandle((table) => {
    let el: HTMLElement | null = table.parentElement;
    while (el) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return el;
      el = el.parentElement;
    }
    return null;
  });
  const scroller = handle.asElement();
  if (!scroller) test.skip(true, 'this list has no horizontal scroller');
  const room = await scroller!.evaluate((el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth);
  expect(room, 'the grid has nothing to scroll sideways, so this proves nothing').toBeGreaterThanOrEqual(40);

  const before = Math.round((await name.boundingBox())!.x);
  await scroller!.evaluate((el) => { (el as HTMLElement).scrollLeft = (el as HTMLElement).scrollWidth; });
  await expect.poll(async () => Math.round((await name.boundingBox())!.x)).toBe(before);
});
