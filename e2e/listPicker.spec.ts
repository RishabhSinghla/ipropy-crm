/**
 * Choosing which saved list the queue shows, and managing one from its own row.
 *
 * **Tags left this panel on 3 October 2026**, on the owner's instruction —
 * *"remove tag list from the dropdown of this list"*. They are cards on the main
 * toolbar now, and `ownerBatchOctober3.spec.ts` is what proves a card reaches
 * the server as `record_tags`.
 *
 * The one thing only a browser proves here: the row's actions menu used to be
 * positioned `absolute` inside a list that scrolls, and `overflow-y-auto` clips
 * an absolutely-placed child — so Edit and Delete were cut off or invisible on
 * any row below the first few, which reads exactly like the controls not
 * existing. Nothing but a real browser measures that.
 */
import { test, expect, type Page } from '@playwright/test';

async function openPicker(page: Page) {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Choose or manage list views/ }).click();
  await expect(page.getByText('Select a list')).toBeVisible();
}

test('the picker holds lists and no tags', async ({ page }) => {
  await openPicker(page);
  await expect(page.getByRole('button', { name: /^All Leads/ })).toBeVisible();
  // The heading is gone, not merely empty: a "Tags" section with nothing under
  // it reads as tags being broken rather than as tags having moved.
  await expect(page.getByText('Tags', { exact: true })).toHaveCount(0);
});

test('the button says which list is on', async ({ page }) => {
  await openPicker(page);
  /*
    **The name is back on the pill** — *"Also Show the name of all icons 'All
    Leads/Inventory, Followup, Tag Name (hot)' in the record left pane"*
    (3 October 2026), reversing the icons-only row of 1 October. Read off the
    button's own text, not its tooltip: the tooltip was already right while the
    face of it said nothing.
  */
  await expect(page.getByRole('button', { name: /Choose or manage list views/ })).toContainText('All Leads');
  await expect(page.getByRole('button', { name: 'Task' })).toContainText('Task');
});

test('the search box narrows the lists', async ({ page }) => {
  await openPicker(page);
  const box = page.getByPlaceholder('Search for a list');

  await box.fill('zzz-nothing-matches-this');
  await expect(page.getByText(/Nothing matches/)).toBeVisible();

  await box.fill('');
  await expect(page.getByRole('button', { name: /^All Leads/ })).toBeVisible();
});

test('a list can be acted on from its own row, and the menu is not clipped', async ({ page }) => {
  await openPicker(page);

  const lists = page.getByRole('navigation', { name: 'Lists' });
  // The last row, deliberately: the first one was never the one that broke.
  const rows = lists.getByRole('button', { name: /^Actions for / });
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  await last.click();

  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  await expect(edit).toBeVisible();
  await expect(page.getByRole('button', { name: 'Duplicate' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Set as default/ })).toBeVisible();

  /*
    Measured, not read off a class name. A panel clipped by its scroller is
    still "visible" to Playwright as far as its own box goes — what gives it
    away is the box sitting outside the scroller it lives in.
  */
  const inside = await edit.evaluate((el) => {
    const panel = el.closest('.popover')!.getBoundingClientRect();
    const scroller = el.closest('nav')!.getBoundingClientRect();
    return panel.bottom <= scroller.bottom + 1 && panel.top >= scroller.top - 1;
  });
  expect(inside, 'the actions menu should sit inside the list it scrolls with').toBe(true);
});

test('a built-in list cannot be deleted', async ({ page }) => {
  await openPicker(page);
  await page.getByRole('button', { name: /^Actions for All Leads$/ }).click();
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});
