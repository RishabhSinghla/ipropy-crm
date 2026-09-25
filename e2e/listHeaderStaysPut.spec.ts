/**
 * The column names have to still be there when you have scrolled down.
 *
 * A list of 22,970 is read by scrolling, and a grid of ten columns is
 * unreadable the moment you cannot see which column is which — "is that the
 * budget or the market rate" is not a question a rep should have to scroll back
 * up to answer.
 *
 * The header is `position: sticky`, which is easy to break from a long way
 * away: a wrapper that starts scrolling instead of the body, an ancestor that
 * quietly becomes the scroll container, a row painted over the top of it, or
 * `border-collapse`, which hands a cell's border to the table and takes the
 * sticking with it in some browsers. None of those show up in a typecheck and
 * none of them fail a unit test, so this asks a real browser.
 *
 * It measures three things, because "the header is gone" has three different
 * causes and only one of them is the header:
 *
 *   * the rows actually scrolled — otherwise the test proves nothing;
 *   * the *window* did not, because if the page scrolls the header leaves with
 *     it and no amount of `sticky` will save it;
 *   * the header sits where it started, and nothing is painted over it.
 */
import { expect, test } from '@playwright/test';

// A laptop, which is where the team reads lists. The table is `lg:` and up;
// below that the phone card list replaces it and there is no header to pin.
test.use({ viewport: { width: 1512, height: 820 } });

for (const path of ['/leads', '/properties']) {
  test(`column headers stay put while the rows scroll — ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

    // EVERY header cell, not the first one. The first is the checkbox column,
    // and it was the only one still pinned while every named column scrolled
    // away — so a test that measured `.first()` passed four times in a row
    // against a list whose headers were visibly gone.
    const headers = page.locator('th.list-head');
    await expect(headers.first()).toBeVisible();
    const before = await headers.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));

    // A wheel over the grid, the way a person scrolls — not `scrollTop`, which
    // would pick the scroll container for the browser and hide the bug where
    // the wrong element is the one that scrolls.
    await page.mouse.move(700, 600);
    for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 200);
    await page.waitForTimeout(600);

    const state = await page.evaluate(() => {
      const scroller = [...document.querySelectorAll('div')].find(
        (d) => d.scrollHeight > d.clientHeight + 20 && d.querySelector('table'),
      );
      const th = document.querySelector('th.list-head') as HTMLElement | null;
      const box = th?.getBoundingClientRect();
      const onTop = box
        ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        : null;
      return {
        rowsScrolled: scroller ? Math.round(scroller.scrollTop) : 0,
        windowScrolled: Math.round(window.scrollY),
        coveredByARow: Boolean(onTop?.closest('tbody')),
      };
    });

    expect(state.rowsScrolled, 'the rows did not move, so this proves nothing').toBeGreaterThan(300);
    expect(state.windowScrolled, 'the page scrolled, which takes the header with it').toBe(0);
    expect(state.coveredByARow, 'a row is painted over the header').toBe(false);

    // Every one of them, and still on screen. `position` is asserted outright
    // because that is what actually broke: a Tailwind `relative` on the cell
    // beat the `sticky` in `.list-head`, and a header that has scrolled to
    // y = -581 still reports a perfectly plausible width and height.
    const after = await headers.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
    const positions = await headers.evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).position))]);
    expect(positions, 'every header cell must be sticky, not relative').toEqual(['sticky']);
    expect(after, 'a header drifted with the rows').toEqual(before);
    expect(Math.min(...after), 'a header scrolled off the top of the screen').toBeGreaterThan(0);
  });
}
