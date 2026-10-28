/**
 * The owner's seven of 3 October 2026, driven in a browser on every module.
 *
 * *"All changes should be in all Modules"* was his instruction the day before,
 * and it still holds: a promise proved on Contacts and not on Inventories is
 * how a module gets left behind.
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
  /*
    The "Not filled in" row lived in the Quick & Live Filters overlay, which was
    removed on 26 October 2026 (#158) — the test went with the screen.
  */

  test(`${module}: one More on the record, carrying the record's own actions`, async ({ page }) => {
    await openFirstRecord(page, module);
    // The header's own three-dot circle is gone.
    await expect(page.locator('button[aria-label="More actions"]')).toHaveCount(0);
    // The tag button stays in the header (27 October 2026); the rest of what the
    // three-dot menu held is in the bar's More.
    await expect(page.getByRole('button', { name: 'Edit record tags', exact: true })).toBeVisible();
    await page.getByTestId('record-menu-more').click();
    for (const row of [/Add favourite|Remove favourite/, /Summarise with AI/, /Delete record/]) {
      await expect(page.getByRole('button', { name: row })).toBeVisible();
    }
  });

  test(`${module}: the bar fills the width rather than stopping at five`, async ({ page }) => {
    await openFirstRecord(page, module);
    const bar = page.getByTestId('record-menu-bar');
    const wide = await bar.locator('button').count();
    // Narrow the window until the bar has to give something up, then check it
    // did — measured, not read off a number written into the spec.
    // The queue collapses at tablet width, freeing menu space. A phone-width
    // viewport genuinely constrains the bar and exercises its overflow.
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(async () => {
      expect(await bar.locator('button').count()).toBeLessThan(wide);
    }).toPass({ timeout: 10_000 });
    // Nothing is lost: what left the bar is behind More.
    await expect(page.getByTestId('record-menu-more')).toBeVisible();
  });

  test(`${module}: the note box opens on hover and holds a draft open`, async ({ page }) => {
    await openFirstRecord(page, module);
    // The folded note bar reads "Write a note…" since 27 October 2026.
    await page.getByRole('button', { name: 'Write a note…', exact: true }).click();
    const dock = page.getByTestId('note-dock');
    await expect(dock).toBeVisible();
    const box = page.locator('[data-testid="note-box"]').first();
    await expect(box).toBeVisible();
    // A half-typed note is not a reason to fold the box it is in.
    await box.fill('Half a sentence');
    // Somewhere that is not the dock — the module label it used to hover left
    // the header on 3 October 2026.
    await page.getByTestId('record-menu-bar').hover();
    await expect(box).toBeVisible();
    await box.fill('');
  });
}

test('the toolbar starts closed, however it was left', async ({ page }) => {
  await openList(page, 'leads');
  // Open them…
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(page.getByTestId('workspace-dock')).toBeVisible();
  /*
    The details pane has opened by default since 27 October 2026 (fba48312);
    the owner's 3 October instruction was that it start closed. Only the
    toolbar is pinned to "starts closed" here until the owner says which is
    meant — see the report that went with this change.
  */
  // …and a reload puts the toolbar away again: *"when we Refresh or Login to CRM"*.
  await page.reload();
  await expect(page.getByText(/[\d,]+ records/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('workspace-dock-frame')).toHaveAttribute('data-folded', 'true');
});

test('the folded toolbar is icons, not a blank strip', async ({ page }) => {
  await openList(page, 'leads');
  const folded = page.getByTestId('workspace-dock-folded');
  await expect(folded).toBeVisible();
  // One row per destination, each reachable by name even with no words drawn.
  await expect(folded.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(folded.getByRole('link', { name: 'WhatsApp' })).toBeVisible();
  // Opening it brings the names back.
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(page.getByTestId('workspace-dock').getByText('Dashboard', { exact: true })).toBeVisible();
});

test('the tag cards sit after the company name and narrow a list', async ({ page }) => {
  await openList(page, 'leads');
  const cards = page.getByTestId('tag-cards');
  if (!(await cards.count())) test.skip(true, 'no tags are in use on this database');
  await expect(cards).toBeVisible();
  const first = cards.locator('button').first();
  const name = (await first.innerText()).split('\n')[0]!;
  const before = await page.getByText(/[\d,]+ records/).first().innerText();

  /*
    **A tag is not a field on the module**, so it cannot be sent as one — it has
    to reach the server as `record_tags` with `has_any`. Sent as a field name the
    request is refused, or worse, silently matches nothing. This assertion lived
    in `listPicker.spec.ts` until 3 October 2026, when tags left that panel and
    these cards became the one way to choose one.
  */
  let askedByTag = false;
  await page.route('**/api/records/**', async (route) => {
    const asked = decodeURIComponent(route.request().postData() ?? route.request().url());
    if (asked.includes('record_tags') && asked.includes('has_any') && asked.includes(name)) askedByTag = true;
    await route.continue();
  });

  await first.click();
  await expect.poll(() => askedByTag, { timeout: 15_000 }).toBe(true);
  // It reaches the server: the whole total moves, not just the page.
  await expect(page.getByText(/[\d,]+ records/).first()).not.toHaveText(before, { timeout: 15_000 });
  expect(page.url()).toContain(`tag=${encodeURIComponent(name)}`);
  // A second click is the way back — a card that can only narrow is a dead end.
  await cards.locator('button').first().click();
  await expect(page.getByText(/[\d,]+ records/).first()).toHaveText(before, { timeout: 15_000 });
});
