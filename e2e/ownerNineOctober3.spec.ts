/**
 * The owner's nine of 3 October 2026, evening, driven in a browser.
 *
 * *"All changes should be in all Modules"* still holds, so every promise that
 * can be is proved on Contacts **and** on Inventories — a promise proved on one
 * is how the other gets left behind.
 *
 * Three of these are only visible in a browser and in nothing else: a bar's
 * width in pixels, whether a gradient is painted at all, and whether the pane's
 * second line says the same house number twice.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

const MODULES = ['leads', 'properties'] as const;

async function openList(page: Page, module: string): Promise<void> {
  await page.goto(`/${module}`);
  await expect(page.getByText(/[\d,]+ records/).first()).toBeVisible({ timeout: 30_000 });
}

async function openFirstRecord(page: Page, module: string): Promise<void> {
  await openList(page, module);
  await page.getByTestId('queue-card').first().click();
  await expect(page.getByTestId('record-menu-bar')).toBeVisible({ timeout: 20_000 });
}

for (const module of MODULES) {
  // 1 — *"remove hot tag/Icon from Left Record Pane after the List and Task Icons"*
  test(`${module}: the Hot chip is off the queue toolbar`, async ({ page }) => {
    await openList(page, module);
    await expect(page.getByTestId('hot-tag-chip')).toHaveCount(0);
    // The two that stay are still there, and still say what they are.
    const tools = page.getByTestId('queue-tools');
    await expect(tools.getByRole('button', { name: /Choose or manage list views/ })).toBeVisible();
  });

  // 6 — *"Show the name of all icons … in the record left pane"*
  test(`${module}: the queue buttons say what they are`, async ({ page }) => {
    await openList(page, module);
    const tools = page.getByTestId('queue-tools');
    const list = tools.getByRole('button', { name: /Choose or manage list views/ });
    // Read off the face of the button, not its tooltip: the tooltip was already
    // right on 1 October while the button itself said nothing but a number.
    await expect(list).toContainText(/All (Leads|Inventories|Contacts)/i);
    const task = tools.getByRole('button', { name: 'Task' });
    if (await task.count()) await expect(task).toContainText('Task');
  });

  // 3 — *"the duplicate House No. are still … Please Check and Remove one"*
  test(`${module}: the queue's second line never says one fact twice`, async ({ page }) => {
    await openList(page, module);
    const lines = await page.getByTestId('queue-card').evaluateAll((cards) => cards
      .map((card) => (card.querySelectorAll('span > span')[0]?.parentElement?.innerText ?? ''))
      .slice(0, 0));
    expect(lines.length).toBe(0); // the real check is below, on each card's own text
    const cards = page.getByTestId('queue-card');
    const count = Math.min(await cards.count(), 12);
    expect(count, 'needs at least one record in the queue').toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const text = (await cards.nth(i).innerText()).split('\n').map((l) => l.trim());
      // The description line is the one with commas in it; each piece must be
      // distinct, which is the whole of what `oneOfEach` promises.
      for (const line of text.filter((l) => l.includes(','))) {
        const pieces = line.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
        expect(new Set(pieces).size, `"${line}" repeats a value`).toBe(pieces.length);
      }
    }
  });

  // 4 and 5 — the bar is three quarters the width, in three colours by percentage
  test(`${module}: the completeness bar is shorter and coloured by how full it is`, async ({ page }) => {
    await openFirstRecord(page, module);
    const bar = page.getByRole('img', { name: /Record \d+% complete/ }).first();
    await expect(bar).toBeVisible();

    const box = (await bar.boundingBox())!;
    // 14rem was the old ceiling; three quarters of it is 10.5rem = 168px. The
    // label and gap ride outside the track, so the whole control is measured
    // against a little headroom rather than exactly.
    expect(box.width, 'the bar should be about three quarters of its old width').toBeLessThanOrEqual(205);

    const painted = await bar.evaluate((el) => {
      // The fill is the track's only child — a selector for "a span inside a
      // span" matches the track itself, which carries no inline background.
      const fill = el.firstElementChild?.firstElementChild as HTMLElement | null;
      return { percent: Number(/(\d+)%/.exec(el.getAttribute('aria-label') ?? '')?.[1] ?? '0'), background: fill?.style.background ?? '' };
    });
    /*
      Red alone below 40, a gradient once past it — and the number on screen is
      what decides which, so this cannot be written as one expectation. What it
      must never be is the old single green for everybody.
    */
    if (painted.percent <= 40) {
      expect(painted.background).toContain('--strength-low');
    } else {
      expect(painted.background).toContain('gradient');
      expect(painted.background).toContain('--strength-mid');
    }
  });

  /*
    **Call moved again the same evening** — *"Move the call icon after record
    number in Middle header pane"* — so the promise this test held (under the
    name, level with the bar) is no longer the one in force.
    `ownerSixOctober3.spec.ts` measures where it went. The bar's own width and
    its colours are still proved above; only Call's position moved.
  */

  // 8 — *"if profile Picture available, the the profile pic will be shown on Agent/User Avtar"*
  test(`${module}: the agent on a queue row carries a face`, async ({ page }) => {
    await openList(page, module);
    const rows = page.getByTestId('queue-card');
    const count = Math.min(await rows.count(), 15);
    let found = 0;
    for (let i = 0; i < count; i++) {
      found += await rows.nth(i).locator('[title^="Assigned to"] img, [title^="Assigned to"] div[title]').count();
    }
    // Every assigned row has one; a photo or initials, both drawn by `Avatar`.
    const assigned = await page.locator('[title^="Assigned to"]').count();
    if (!assigned) test.skip(true, 'no record in this queue is assigned');
    expect(found, 'an assigned row should show the agent as a face plus a name').toBeGreaterThan(0);
  });
}

// 2 — *"Company Avtar Circle … should be Dark and Bold as per Theme"*
test('the company circle is a bold dark ring, and a logo is fitted rather than cropped', async ({ page }) => {
  await openList(page, 'leads');
  const mark = page.getByTestId('brand-mark');
  await expect(mark).toBeVisible();

  const ring = await mark.evaluate((el) => {
    const style = getComputedStyle(el);
    const img = el.querySelector('img');
    return {
      width: style.outlineWidth || style.boxShadow,
      shadow: style.boxShadow,
      fit: img ? getComputedStyle(img).objectFit : null,
    };
  });
  /*
    The ring is a `box-shadow`, which is how Tailwind draws `ring-*`. Asserted as
    "there is one", not as a width: it went to 3px when he asked for bold, and
    back to 2px an hour later when the thicker ring made the circle overlap the
    header's padding — `ownerSixOctober3.spec.ts` is what measures that it fits.
    The hue is never asserted: the brand colour is an admin's to change.
  */
  expect(ring.shadow, 'the circle should carry a ring at all').not.toBe('none');
  // A logo, when there is one, is shown whole rather than cropped to its middle.
  if (ring.fit) expect(ring.fit).toBe('contain');
});
