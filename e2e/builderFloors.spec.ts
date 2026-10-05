/**
 * Builder Floors, in a real browser.
 *
 * **5 October 2026**, from the owner's own spreadsheet. A green test run is not a
 * working screen: this module is seed data, and every screen that draws it — the
 * left toolbar, the queue, the record pane, the lists — is generic code reading
 * metadata. That is exactly the combination that can be perfectly correct in the
 * database and show a person nothing at all.
 *
 * **Two locator traps cost a run here, and both are ones this repo has already
 * written down.**
 *
 * The workspace dock renders **twice** — an expanded `complementary` and a
 * collapsed `navigation` — so `getByRole('link').first()` resolves to whichever
 * copy is in the DOM first and that one may be the hidden one. The click then
 * waits for visibility for ever. `:visible` is the fix, the same lesson as
 * measuring `.first()` on a header cell when only one column was still pinned.
 *
 * And this list's count line reads **"Builder Floors (4)"**, not the
 * `/^[\d,]+ records$/` that nine other specs wait on. Guessing that wording
 * meant waiting for text no screen was ever going to print — which reads
 * exactly like a page that will not load.
 */
import { expect, test } from '@playwright/test';

/** The one in the toolbar a person can actually see, not its folded twin. */
const DOCK_LINK = 'a[href="/builder_floors"]:visible';

/**
 * What to wait for once the queue has loaded.
 *
 * **Not the count line**, which is the trap that cost a second run. The header
 * prints the module's label and `({rows.length})` as **two sibling spans**, so
 * `getByText(/Builder Floors \(\d+\)/)` matches nothing at all — the
 * accessibility tree joins them into "Builder Floors (4)" and the DOM never
 * does. Waiting for text no element will ever contain reads exactly like a page
 * that refuses to load.
 *
 * The select-all checkbox is one element, its label is built from the module's
 * own label, and it only exists once the queue has rows.
 */
const QUEUE_READY = 'Select all builder floors shown';

test('is reachable from the navigation, not only by URL', async ({ page }) => {
  await page.goto('/dashboard');
  const link = page.locator(DOCK_LINK).first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  /*
    Asserted as a real link to the real address rather than clicked. The click
    hung on "scrolling into view" for a minute: the dock is a folding panel whose
    rows carry a CSS transition, and a moving target never satisfies Playwright's
    stability check. What this promise is actually about is that the module is
    *in* the navigation — the Chats page was once the one screen nobody could
    reach — and whether a nav link navigates is generic behaviour other specs
    already cover.
  */
  await expect(link).toHaveAttribute('href', '/builder_floors');
  await page.goto('/builder_floors');
  await expect(page.getByLabel(QUEUE_READY)).toBeVisible({ timeout: 30_000 });
});

test('opens on the split view, with a floor in the queue and its record beside it', async ({ page }) => {
  await page.goto('/builder_floors');
  await expect(page.getByLabel(QUEUE_READY)).toBeVisible({ timeout: 30_000 });

  const workspace = page.getByTestId('ipropy-workspace');
  await expect(workspace).toBeVisible({ timeout: 30_000 });

  /*
    A house is named "<locality> <house no>" — neither half identifies one
    alone, which is why `labelFields` is both: sixty houses share a locality and
    a house number repeats across them. Matching the name proves the label is
    built from the module's own metadata rather than falling back to the
    module's singular.
  */
  const row = workspace.getByRole('button').filter({ hasText: /B-114|C-3614|B-1396/ }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  // The record beside it, drawn from this module's own blocks.
  await expect(workspace.getByText(/House No\./i).first()).toBeVisible({ timeout: 20_000 });
  await expect(workspace.getByText(/First Floor/i).first()).toBeVisible({ timeout: 20_000 });
});

test("shows the locality's whole table — every builder's house in it", async ({ page }) => {
  /*
    *"We want to see a table in Middle Pane under manu bar a Name of Builder's
    Floor … we want create multiple unit of multiple builder under in a
    locality."* The columns are the module's own fields, so this asserts the
    ones he listed by name — a table that silently lost the Top Floor price
    would still be a table.
  */
  await page.goto('/builder_floors');
  await expect(page.getByLabel(QUEUE_READY)).toBeVisible({ timeout: 30_000 });

  const workspace = page.getByTestId('ipropy-workspace');
  const row = workspace.getByRole('button').filter({ hasText: /B-114|C-3614|B-1396/ }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();

  await page.getByRole('button', { name: /Builder's Floor/i }).first().click();
  const table = page.getByTestId('builder-floor-table');
  await expect(table).toBeVisible({ timeout: 20_000 });

  // His columns, in his words.
  for (const column of [
    /House No\./i, /Builder's Name/i, /Mobile Number/i, /Facing/i, /Size/i,
    /Bedrooms/i, /Status/i, /Amenities/i,
    /First Floor/i, /Second Floor/i, /Third Floor/i, /Fourth Floor/i, /Top Floor/i,
  ]) {
    await expect(table.getByRole('columnheader', { name: column }).first()).toBeVisible();
  }

  // Multiple builders, multiple houses, one locality — the whole point.
  await expect(table.getByRole('row')).toHaveCount(4); // header + three houses
});

test('offers this module\'s own dropdowns, which no screen names', async ({ page }) => {
  /*
    Floor, Accommodation and Floor Availability are seeded picklists reaching the
    form through the ordinary describe. If one is missing the cause is the seed,
    not this screen — which is why this asserts on the form a person fills in
    rather than on the API that answers it.
  */
  await page.goto('/builder_floors/new');
  await expect(page.locator('form, main').first()).toBeVisible({ timeout: 30_000 });
  for (const label of [/House No\./i, /Locality/i, /Builder's Name/i, /Mobile Number/i]) {
    await expect(page.getByText(label).first()).toBeVisible({ timeout: 20_000 });
  }
});

test('Sold is a list of its own, and the default list is the floors on the market', async ({ page }) => {
  /*
    *"If the unit sold then the move on separate folder."* It is a saved view and
    not a second table, so what is proved is that both lists exist as real places
    and that the default is the narrowed one — with "All Builder Floors" still
    there as the way back to everything, because a default view that drops
    records and offers no escape is reported as data loss.
  */
  await page.goto('/builder_floors');
  await expect(page.getByLabel(QUEUE_READY)).toBeVisible({ timeout: 30_000 });

  const picker = page.getByRole('button', { name: /Choose or manage list views/i }).first();
  await expect(picker).toBeVisible({ timeout: 20_000 });
  // The default is already the narrowed list, before anybody chooses.
  await expect(picker).toContainText(/On the Market/i);

  await picker.click();
  for (const name of [/On the Market/i, /^Sold$/i, /All Builder Floors/i]) {
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 });
  }
});
