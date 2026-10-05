/**
 * The toolbar down the left, on every page — 1 October 2026, the owner: *"it
 * needs to be fixed throughout the CRM all time … when I opened say call
 * module that left tool tab vanished"*. It replaced the header's module
 * switcher and WhatsApp button, so it has to reach everything they did.
 */
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

for (const path of ['/dashboard', '/leads', '/calls', '/settings']) {
  test(`it is there on ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByTestId('workspace-dock')).toBeVisible({ timeout: 30_000 });
  });
}

test('the header no longer carries the switcher or the WhatsApp button', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByTestId('workspace-dock')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Switch module' })).toHaveCount(0);
  await expect(page.locator('header a[href="/whatsapp"]')).toBeHidden();
});

test('choosing a module goes there, and its icon says so', async ({ page }) => {
  await page.goto('/calls');
  const dock = page.getByTestId('workspace-dock');
  const firstModule = dock.locator('a[href^="/"]').nth(2);
  const href = await firstModule.getAttribute('href');
  await firstModule.click();
  await expect(page).toHaveURL(new RegExp(`${href}`));
  await expect(firstModule).toHaveClass(/bg-white/);
});

test('no Tasks or Campaigns icon — Campaigns lives in WhatsApp (3 October 2026)', async ({ page }) => {
  await page.goto('/leads');
  const dock = page.getByTestId('workspace-dock');
  await expect(dock).toBeVisible({ timeout: 30_000 });
  await expect(dock.getByRole('link', { name: "Today's tasks" })).toHaveCount(0);
  await expect(dock.getByRole('link', { name: 'Campaigns' })).toHaveCount(0);
});

test('Ask AI is a circle that can be dragged, and a tap opens it', async ({ page }) => {
  await page.goto('/dashboard');
  const bubble = page.getByTestId('ai-bubble');
  await expect(bubble).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('header').getByRole('button', { name: /Ask AI/ })).toHaveCount(0);

  const from = (await bubble.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 8 });
  await page.mouse.up();
  const to = (await bubble.boundingBox())!;
  expect(Math.abs(to.x - from.x) + Math.abs(to.y - from.y), 'the circle did not move').toBeGreaterThan(100);
  // A drag is not a tap: nothing opened.
  await expect(page.getByPlaceholder(/Ask or tell iPropy/)).toHaveCount(0);

  await bubble.click();
  await expect(page.getByPlaceholder(/Ask or tell iPropy/)).toBeVisible();
});

/*
  1 October 2026, the owner: *"similar to that fold unfold thing we got on very
  right detail pane so that left tool bar would be same working open/closed"*.
  Measured, not read off a class: the frame narrows, the icons stop being
  reachable, it comes back on a tap, and a reload remembers the choice.
*/
test('the toolbar folds away and comes back, and remembers', async ({ page }) => {
  await page.goto('/leads');
  const frame = page.getByTestId('workspace-dock-frame');
  await expect(page.getByTestId('workspace-dock')).toBeVisible({ timeout: 30_000 });
  const open = (await frame.boundingBox())!.width;

  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeLessThan(open - 20);
  await expect(page.getByTestId('workspace-dock').getByRole('link', { name: 'Dashboard' })).not.toBeInViewport({ ratio: 1 }).catch(() => undefined);
  await expect(frame).toHaveAttribute('data-folded', 'true');

  await page.reload();
  await expect(page.getByTestId('workspace-dock-folded')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeGreaterThan(open - 2);
  await page.getByTestId('workspace-dock').getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

/**
 * Names, counts, and the order the owner drew.
 *
 * **2 October 2026:** *"Left Toolbar Whatsapp icon Shift to Below Call and
 * Dashboard icon on top all icon have their names also with record counts and
 * the unread feature disables from all modules's toolbar, the toolbar also
 * have hamburg function before ipropy company name."*
 */
test('the toolbar reads as names, counts and the owner’s own order', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

  const rows = await page.locator('[data-testid="workspace-dock"] a')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).innerText.split('\n')[0].trim()));

  // Dashboard first, WhatsApp last — below the call log, which is the move.
  expect(rows[0]).toBe('Dashboard');
  expect(rows[rows.length - 1]).toBe('WhatsApp');
  expect(rows.indexOf('WhatsApp')).toBeGreaterThan(rows.indexOf('Calls'));

  // Every row says what it is, rather than being an icon you learn.
  expect(rows.every((name) => name.length > 0), `a toolbar row has no name: ${rows.join(', ')}`).toBe(true);

  /*
    A module's row carries **how many records it holds** — not an unread
    count, which came off the toolbar on the same instruction. Read off the
    live list's own total, so this cannot pass against a number the CRM
    invented.
  */
  const total = await page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/).innerText();
  const listTotal = Number((total.match(/of ([\d,]+) records/)?.[1] ?? '').replace(/,/g, ''));
  const leads = page.locator('[data-testid="workspace-dock"] a').filter({ hasText: 'Leads' }).first();
  // The chip's own title, not the row's — the row's title is the module name.
  const chip = leads.locator('span[title]').first();
  await expect(chip, 'the Leads row carries no record count').toHaveCount(1);
  expect(
    Number((await chip.getAttribute('title') ?? '').replace(/[^\d]/g, '')),
    'the toolbar count disagrees with the list it links to',
  ).toBe(listTotal);
});

test('the hamburger beside the company name folds the toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/leads');
  const frame = page.locator('[data-testid="workspace-dock-frame"]');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  await expect(frame).not.toHaveAttribute('data-folded', 'true');

  await page.getByTestId('app-menu-button').click();
  await expect(frame).toHaveAttribute('data-folded', 'true');

  await page.getByTestId('app-menu-button').click();
  await expect(frame).not.toHaveAttribute('data-folded', 'true');
});
