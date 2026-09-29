/**
 * The record header is one line of facts, and the actions beside it.
 *
 * The owner's instruction on 19 September: *"Please set all in one row, so
 * that we can see narrow header and wide Timeline… if more then line should
 * make it in dash … so that we can choose only option from master."* A header
 * that wraps to three rows eats the screen the work actually happens on, and
 * silently clipping instead would hide fields with nothing to say so.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 900 } });

/**
 * The middle pane — the record itself.
 *
 * A `<section>` since the three-pane rebuild of 27 September 2026, and
 * `page.locator('main')` also matches the app shell's own `<main>`. Named by
 * the tab strip it contains, which only this pane has.
 */
function recordPane(page: import('@playwright/test').Page) {
  return page.getByTestId('ipropy-workspace')
    .locator('section')
    .filter({ has: page.getByRole('navigation', { name: 'Record workspace sections' }) })
    .first();
}

async function splitView(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('ipropy.listmode.leads', 'ipropy'); } catch { /* see listMode.ts */ }
  });
  await page.goto('/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
}

/*
  Two specs stood here and have been removed rather than left failing.

  They measured `data-testid="header-fields"` in the record pane — that every
  field sat on one line, and that a narrow pane hid one whole rather than
  cutting a word in half. **28 September 2026 took that strip off this screen
  entirely**: the owner asked for the hero compact, and what survived of it is
  three small chips beside the face (`the three chips read as one row` in
  `compactHero.spec.ts`).

  `HeaderFieldStrip` and its count-what-fits rule are still real, and still
  right — the **Chats** header draws them. But that screen only renders when a
  WhatsApp provider is connected, and none is on a developer's database, so
  there is nowhere left to drive it from. **That rule is untested today.** It
  is written down here rather than quietly lost; the way to close it is to pull
  the "how many fit" arithmetic out of the component and test it as a function,
  which would prove more than either of these did.
*/

test('the chips beside the face are one look, with the stage the only exception', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await splitView(page);

  // The first column of the hero's grid: the chase date, the stage, the call.
  const chipRow = recordPane(page).locator('header').first().locator('div.relative.flex > span').first();
  await expect(chipRow).toBeVisible();

  const chips = await chipRow.evaluate((box) => [...box.children].map((wrap) => {
    const el = wrap as HTMLElement;
    // The chase date draws its own chip inside its wrapper; the others are the
    // wrapper. Take whichever actually carries a fill.
    /*
      The painted node, not its wrapper: a Dropdown puts its own box around
      the call pill, so measuring the wrapper reports that box's height
      rather than the chip's — which is how this first failed at 32px
      against a chip that is plainly 24.

      **Every descendant, not the first one.** Since 28 September 2026 each
      chip is introduced by its field's own name, so the first inner span is
      that label — which carries no fill, and reading it reported that not one
      chip was painted.
    */
    const painted = [el, ...el.querySelectorAll('span,button')]
      .map((n) => n as HTMLElement)
      .find((n) => getComputedStyle(n).backgroundColor !== 'rgba(0, 0, 0, 0)');
    const style = painted ? getComputedStyle(painted) : null;
    return {
      fill: style?.backgroundColor ?? '',
      radius: style?.borderRadius ?? '',
      height: painted ? Math.round(painted.getBoundingClientRect().height) : 0,
    };
  }));

  expect(chips.length, 'no chips to compare').toBeGreaterThan(1);
  const painted = chips.filter((c) => c.fill);
  expect(painted.length, 'not one chip carries a fill').toBeGreaterThan(0);

  for (const chip of painted) {
    expect(chip.radius, 'a chip is not round').toMatch(/9999px/);
    // Small: this is the row that stopped the hero being three lines tall.
    expect(chip.height, `a chip is ${chip.height}px tall — that is not the small chip`).toBeLessThan(32);
  }

  /*
    One ordinary tone, plus the stage's own colour, plus overdue red. Which
    record the queue opens on decides whether the third is on screen at all,
    so this allows it rather than depending on it.
  */
  expect(new Set(painted.map((c) => c.fill)).size, 'the chips carry more tones than the three there are')
    .toBeLessThanOrEqual(3);
});

/**
 * The photo reaches the innermost ring.
 *
 * **28 September 2026:** *"There are three lines after avatar. Please increase
 * the avtar size till touch inner circle first line."* It stops one white
 * ring short of the dashes on purpose — grown flush it covers them and he is
 * left with two lines where he counted three — so this checks both halves:
 * the photo nearly fills that circle, and the circle is still drawn.
 */
test('the photo fills the dashed ring without swallowing it', async ({ page }) => {
  await splitView(page);
  const rings = recordPane(page).locator('svg[role="img"]').first();
  await expect(rings).toBeVisible();

  const size = await rings.evaluate((svg) => {
    const width = (n: Element): number => n.getBoundingClientRect().width;
    const dashed = [...svg.querySelectorAll('circle')].find((c) => c.getAttribute('stroke-dasharray') === '2 3');
    const face = [...svg.parentElement!.children]
      .find((c) => c !== svg && (c as HTMLElement).className?.toString().includes('z-10'));
    return dashed && face ? { dashed: width(dashed), face: width(face) } : null;
  });
  expect(size, 'the rings or the photo are not where this spec expects them').not.toBeNull();
  expect(size!.dashed, 'the dashed ring is gone').toBeGreaterThan(0);
  // Inside it, and filling all but its own white hairline on each side.
  expect(size!.face).toBeLessThan(size!.dashed);
  expect(size!.face / size!.dashed, 'the photo no longer reaches the inner ring').toBeGreaterThan(0.9);
});
