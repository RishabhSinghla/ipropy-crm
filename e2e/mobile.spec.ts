import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { unique, waitForRecords } from './helpers';

/**
 * The critical path at phone size.
 *
 * playwright.config.ts has declared a `mobile` project for a while, but its
 * testMatch pointed at this file and this file did not exist — so the project
 * ran the auth setup, reported "1 passed", and tested nothing. That is worse
 * than no mobile coverage, because the green tick implied it existed.
 *
 * Phone size is genuinely different code, not a narrower rendering of the same
 * markup: ListView renders a card list (md:hidden) instead of the table, and
 * the sidebar becomes an overlay drawer (lg:hidden). Neither is reachable from
 * the desktop project at any point, and the desktop axe scans skip both
 * because axe ignores elements that are display:none at the current viewport —
 * which is how two unlabelled drawer buttons survived the accessibility pass.
 */

test.describe('phone', () => {
  test('the sidebar drawer opens, navigates and closes', async ({ page }) => {
    await page.goto('/dashboard');

    // Wait for the shell before asserting anything about the drawer: the nav
    // does not exist during bootstrap, and "not rendered yet" would satisfy a
    // hidden-check for the wrong reason.
    const openButton = page.getByRole('button', { name: 'Open menu' });
    await expect(openButton).toBeVisible();
    const leadsLink = page.getByRole('link', { name: /leads & customers/i });
    await expect(leadsLink).toBeAttached();

    // toBeInViewport, not toBeHidden: the drawer is moved off-canvas with
    // -translate-x-full, so it keeps a real bounding box and stays "visible"
    // by Playwright's definition even when the user cannot see or reach it.
    await expect(leadsLink).not.toBeInViewport();

    await openButton.click();
    await expect(leadsLink).toBeInViewport();

    await leadsLink.click();
    await page.waitForURL(/\/leads/);
    // Navigating must dismiss the drawer; leaving it open covers the page the
    // user just asked for.
    await expect(leadsLink).not.toBeInViewport();
  });

  test('records render as cards, not a squeezed table', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    // The table exists in the DOM at every width; at phone size it must not be
    // displayed, or the user gets a horizontally scrolling grid.
    await expect(page.locator('table')).toBeHidden();
    await expect(page.locator('button[title="Click to edit"]:visible').first()).toBeVisible();
  });

  test('a record opens and can be inline-edited from a phone', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    const trigger = page.locator('button[title="Click to edit"]:visible').first();
    await trigger.click();

    // Whatever editor opens, it must be an actual form control rather than the
    // read-only span — that is the difference between "editable" and "looks
    // editable".
    const editor = page.locator('input:visible, select:visible, textarea:visible').first();
    await expect(editor).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('creating a lead works on a phone', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    await page.getByRole('button', { name: /new lead/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const surname = unique('Phone');
    await dialog.getByLabel(/first name/i).fill('Mobile');
    await dialog.getByLabel(/last name/i).fill(surname);
    // Mobile is duplicate-checked, so it must be unique per run.
    await dialog.getByLabel(/^mobile/i).fill(`+919${String(Date.now()).slice(-9)}`);
    // Both are mandatory on the quick-create layout.
    await dialog.getByLabel(/lifecycle stage/i).selectOption({ index: 1 });
    await dialog.getByLabel(/pipeline status/i).selectOption({ index: 1 });
    await dialog.getByRole('button', { name: /create lead/i }).click();

    await expect(page.getByRole('heading', { name: `Mobile ${surname}` })).toBeVisible({ timeout: 30_000 });

    // And it comes back in the card list — the mobile-only render path.
    await page.goto('/leads');
    await page.getByPlaceholder(/search leads/i).fill(surname);
    // The card shows the record's joined label, not the separate name columns
    // the desktop table splits it into — and `visible=true` matters because
    // that table is still in the DOM at this width, just display:none.
    await expect(
      page.getByText(`Mobile ${surname}`).locator('visible=true').first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('has no accessibility violations at phone size', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    const closed = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(summarise(closed.violations), 'drawer closed').toBe('');

    // Scan again with the drawer open: it is the one piece of UI that only
    // exists at this width, so it is the one axe has never seen.
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('link', { name: /leads & customers/i })).toBeVisible();
    const open = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(summarise(open.violations), 'drawer open').toBe('');
  });
});

function summarise(violations: { impact?: string | null; id: string; help: string; nodes: { target: unknown[] }[] }[]): string {
  return violations
    .map((v) => `\n  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`)
    .join('');
}
