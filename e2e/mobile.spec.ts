import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { unique, waitForRecords, fillRequiredFields, dashboardWithRecordRows, searchList, openCreateDialog } from './helpers';

/**
 * The critical path at phone size.
 *
 * playwright.config.ts has declared a `mobile` project for a while, but its
 * testMatch pointed at this file and this file did not exist — so the project
 * ran the auth setup, reported "1 passed", and tested nothing. That is worse
 * than no mobile coverage, because the green tick implied it existed.
 *
 * Phone size is genuinely different code, not a narrower rendering of the same
 * markup: the sidebar becomes an overlay drawer. (The phone-width card list
 * went with the table on 27 September 2026; a phone browser gets the split
 * view, and the phone app has screens of its own.) Neither is reachable from
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
    // `nav-item` is the drawer's own class: three navs carry this href since
    // the sidebar became a top bar (top tabs, drawer, bottom bar), and the
    // top-bar tab is first in the DOM but display:none at phone size.
    const leadsLink = page.locator('nav a.nav-item[href="/leads"]');
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

  test('a dashboard row previews without leaving the dashboard', async ({ page }) => {
    await page.goto(await dashboardWithRecordRows(page));

    const row = page.locator('a[href^="/leads/"]:visible').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    const box = await row.boundingBox();

    await row.dispatchEvent('pointerdown', {
      pointerType: 'touch', pointerId: 1, clientX: box!.x + 20, clientY: box!.y + box!.height / 2,
    });
    await page.waitForTimeout(600);
    await row.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
    // The click a lifted finger produces. Without the capture-phase guard this
    // is what followed the link out from under the preview.
    await row.dispatchEvent('click', { button: 0 });

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  /**
   * Escape produces no click at all, so a flag set by the peek and cleared by
   * the click would still be standing — and would eat the next genuine tap on
   * the same row. It is a timestamp for exactly this.
   */
  test('a tap still works after a preview was dismissed with Escape', async ({ page }) => {
    await page.goto(await dashboardWithRecordRows(page));

    const row = page.locator('a[href^="/leads/"]:visible').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    const href = await row.getAttribute('href');
    const box = await row.boundingBox();

    await row.dispatchEvent('pointerdown', {
      pointerType: 'touch', pointerId: 1, clientX: box!.x + 20, clientY: box!.y + box!.height / 2,
    });
    await page.waitForTimeout(600);
    await row.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    // Past the grace window, so this is a new gesture rather than the tail of
    // the old one.
    await page.waitForTimeout(800);
    await page.locator(`a[href="${href}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(href!.replace(/\//g, '\\/')));
  });

  test('creating a lead works on a phone', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    const dialog = await openCreateDialog(page, /new lead/i);

    const surname = unique('Phone');
    // One name field since migration 026, and the mobile takes the national
    // number only — ten digits, unique per run because it is duplicate-checked.
    await dialog.getByLabel(/full name/i).fill(`Mobile ${surname}`);
    await dialog.getByLabel(/^mobile/i).fill(`9${String(Date.now()).slice(-9)}`);
    // And whatever else is mandatory today. That is an admin setting, so it is
    // discovered rather than listed here.
    await fillRequiredFields(dialog);
    await dialog.getByTestId('record-form-submit').click();

    // Quick-create stays on the list by design — see ListView's onSaved.
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // And it comes back in the list.
    await page.goto('/leads');
    await searchList(page, surname);
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
    await expect(page.locator('nav a.nav-item[href="/leads"]')).toBeVisible();
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
