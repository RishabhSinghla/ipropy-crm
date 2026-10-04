/**
 * The owner's ten of 3 October 2026, driven in a browser on every module.
 *
 * *"All changes should be in all Modules"* still holds: a promise proved on
 * Contacts and not on Inventories is how a module gets left behind.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

const MODULES = ['leads', 'properties'] as const;

async function openList(page: import('@playwright/test').Page, module: string): Promise<void> {
  await page.goto(`/${module}`);
  await expect(page.getByText(/[\d,]+ records/).first()).toBeVisible({ timeout: 30_000 });
}

async function openFirstRecord(page: import('@playwright/test').Page, module: string): Promise<void> {
  await openList(page, module);
  await page.getByTestId('queue-card').first().click();
  await expect(page.getByTestId('record-menu-bar')).toBeVisible({ timeout: 20_000 });
}

for (const module of MODULES) {
  test(`${module}: the stage button is off the queue header`, async ({ page }) => {
    await openList(page, module);
    /*
      `Filter by <stage>` is the title `StatusBreakdown` gave its own button.
      Naming the control it drew rather than a testid that was never there:
      `toHaveCount(0)` on a locator for something that never existed passes
      while proving nothing, which is the shape of a test that guards air.
    */
    await expect(page.getByTestId('queue-tools').locator('button[title^="Filter by "]')).toHaveCount(0);
    // And it is still asked in the panel, which is where he said it already was.
    await page.getByTestId('quick-filter-button').click();
    await expect(page.getByTestId('quick-filter-overlay')).toBeVisible();
  });

  test(`${module}: the record header is a name, its tags and a bar`, async ({ page }) => {
    await openFirstRecord(page, module);
    const header = page.getByTestId('split-hero-layout');
    // The module's own name went on 3 October 2026.
    await expect(page.getByTestId('record-module-label')).toHaveCount(0);
    // How complete the record is reads as a bar, with the same words a screen
    // reader heard from the ring it replaced.
    await expect(header.getByRole('img', { name: /Record \d+% complete/ })).toBeVisible();
  });

  test(`${module}: the face is the control, and the camera is gone`, async ({ page }) => {
    await openFirstRecord(page, module);
    const header = page.getByTestId('split-hero-layout');
    await expect(header.getByRole('button', { name: /Add a photo|Change or remove the photo/ })).toHaveCount(0);
    // Clicking the face offers what a photo can have done to it.
    await header.getByRole('button', { name: /^Photo of / }).click();
    await expect(page.getByRole('button', { name: /Upload photo|Replace photo/ })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test(`${module}: the chosen menu key is filled, not underlined`, async ({ page }) => {
    await openFirstRecord(page, module);
    const bar = page.getByTestId('record-menu-bar');
    const chosen = bar.locator('button[aria-current="page"]').first();
    await expect(chosen).toBeVisible();
    /*
      Measured, not read off a class name: a class that is present while the
      button still looks like its neighbours is exactly the bug. The chosen
      one has a fill of its own and the others do not.
    */
    const [on, off] = await Promise.all([
      chosen.evaluate((node) => getComputedStyle(node).backgroundColor),
      bar.locator('button:not([aria-current="page"])').first()
        .evaluate((node) => getComputedStyle(node).backgroundColor),
    ]);
    expect(on).not.toBe(off);
    expect(on).not.toMatch(/rgba\(0, 0, 0, 0\)/);
  });

  test(`${module}: universal search opens its results beside the box`, async ({ page }) => {
    await openList(page, module);
    const box = page.getByRole('combobox', { name: 'Search everything' });
    await box.fill(`nothing matches this ${Date.now()}`);
    const notice = page.getByRole('listbox');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    // Beside the box, not a screen away from it.
    const [boxBox, noticeBox] = await Promise.all([box.boundingBox(), notice.boundingBox()]);
    expect(noticeBox!.y - (boxBox!.y + boxBox!.height)).toBeLessThan(120);
    // And the way back is right there.
    await box.fill('');
    await box.press('Escape');
    await expect(notice).toHaveCount(0, { timeout: 20_000 });
  });

  test(`${module}: the queue card says each fact once`, async ({ page }) => {
    await openList(page, module);
    for (const card of await page.getByTestId('queue-card').all()) {
      const lines = (await card.innerText()).split('\n').map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line.includes(', ')) continue;
        const parts = line.split(', ').map((part) => part.trim().toLocaleLowerCase());
        expect(new Set(parts).size, `"${line}" repeats itself`).toBe(parts.length);
      }
    }
  });
}

test('global toolbar replaces duplicate left-pane search controls', async ({ page }) => {
  await openList(page, 'leads');
  await expect(page.getByTestId('list-search')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Search everything' })).toBeVisible();
  await expect(page.locator('#global-search-filter').getByRole('button')).toBeVisible();
  await expect(page.locator('#global-list-options').getByRole('button', { name: 'Import, export and list options' })).toBeVisible();
});

test('the tag cards count the module they open', async ({ page }) => {
  await openList(page, 'leads');
  const cards = page.getByTestId('tag-cards');
  if (!(await cards.count())) test.skip(true, 'no tags are in use on this database');
  const first = cards.locator('button').first();
  const promised = Number((await first.innerText()).replace(/[^\d]/g, ''));
  await first.click();
  // The number on the card is the number the list comes back with.
  await expect.poll(async () => {
    const text = await page.getByText(/[\d,]+ records/).first().innerText();
    return Number((text.match(/of ([\d,]+) records/)?.[1] ?? text.match(/([\d,]+) records/)?.[1] ?? '0').replace(/,/g, ''));
  }, { timeout: 20_000 }).toBe(promised);
});
