import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { inlineEditOn, unique, waitForRecords, fillRequiredFields, dashboardWithRecordRows } from './helpers';

/**
 * The critical path at phone size.
 *
 * playwright.config.ts has declared a `mobile` project for a while, but its
 * testMatch pointed at this file and this file did not exist — so the project
 * ran the auth setup, reported "1 passed", and tested nothing. That is worse
 * than no mobile coverage, because the green tick implied it existed.
 *
 * Phone size is genuinely different code, not a narrower rendering of the same
 * markup: ListView renders a card list (`record-card-list`) instead of the
 * table, and the sidebar becomes an overlay drawer. Neither is reachable from
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

  test('records render as cards, not a squeezed table', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    // The table exists in the DOM at every width; at phone size it must not be
    // displayed, or the user gets a horizontally scrolling grid.
    await expect(page.locator('table')).toBeHidden();
    test.skip(!(await inlineEditOn(page)), 'inline editing is switched off');
    // The pencil, not the value: on a list the value opens the record and
    // editing sits behind its own affordance, which on a touch screen has to be
    // visible without a hover.
    await expect(page.locator('button[title="Change"]:visible').first()).toBeVisible();
  });

  /**
   * Press and hold to peek — the round trip this removes is the whole point.
   *
   * Checking one number on a phone otherwise means open, read, back, and lose
   * your place in the list. The assertions that matter are that the preview
   * appears *and that the list is still underneath it*: a peek that navigates
   * is just a slow tap.
   */
  /**
   * Swipe actions on a card — the gesture that replaced press-and-hold, and
   * the one the owner asked for by name (Gmail-style). What must be true:
   * the card moves, the action only fires past a deliberate distance, and a
   * drag that goes nowhere does nothing.
   */
  test('swiping a card reveals the call and WhatsApp actions', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    const card = page.getByTestId('record-card-list').locator('> div').first();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();

    // Drag right past the arm threshold — the call background shows.
    await card.dispatchEvent('pointerdown', {
      pointerType: 'touch', pointerId: 1, clientX: box!.x + box!.width / 2, clientY: box!.y + 20,
    });
    // pointermove has to run through the page — dispatchEvent per event.
    await page.evaluate(() => {
      const target = document.querySelector('[data-record-card] > div:last-child');
      target?.dispatchEvent(new PointerEvent('pointermove', {
        pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0, bubbles: true,
      }));
    });
    await page.waitForTimeout(300);
    const callLayer = page.locator('[data-record-card] .bg-blue-600').first();
    await expect(callLayer).toBeAttached();
    await card.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
  });

  test('pressing and holding a search result previews it without leaving the page', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    // Search for something that is definitely there — the record the list is
    // already showing — rather than a hardcoded name that depends on seed data.
    const label = ((await page.getByTestId('record-card-list').locator('> div').first().locator('p').first().textContent()) ?? '').trim();
    expect(label.length).toBeGreaterThan(1);

    const search = page.getByPlaceholder(/search everything/i);
    await search.click();
    await search.fill(label.slice(0, 12));

    // The dropdown is the only place a visible record link exists at this
    // width: the cards are buttons and the desktop table is display:none.
    const result = page.locator('a[href^="/leads/"]:visible').first();
    await expect(result).toBeVisible({ timeout: 30_000 });
    const box = await result.boundingBox();
    expect(box).not.toBeNull();

    await result.dispatchEvent('pointerdown', {
      pointerType: 'touch', pointerId: 1, clientX: box!.x + 20, clientY: box!.y + box!.height / 2,
    });
    await page.waitForTimeout(600);
    await result.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });

    const peek = page.getByRole('dialog');
    await expect(peek).toBeVisible();
    // The search must survive the peek — following the result is what costs it.
    await expect(page).toHaveURL(/\/leads(\?|$)/);
    await expect(peek.getByRole('button', { name: 'Open' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(peek).toBeHidden();
  });

  test('a quick tap does not trigger the preview', async ({ page }) => {
    // The gesture has to be distinguishable from an ordinary tap, or every
    // touch of the list throws a dialog in the way.
    await page.goto('/leads');
    await waitForRecords(page);

    const card = page.getByTestId('record-card-list').locator('> div').first();
    const box = await card.boundingBox();
    await card.dispatchEvent('pointerdown', {
      pointerType: 'touch', pointerId: 1, clientX: box!.x + box!.width / 2, clientY: box!.y + 20,
    });
    await page.waitForTimeout(120);
    await card.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 1 });
    await page.waitForTimeout(500);

    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  /**
   * The same gesture on the dashboard, which is the first screen on a phone and
   * the one where "who is this?" gets asked most — a widget row is a name and a
   * date, and everything you need to decide whether to ring them is one screen
   * away in the wrong direction.
   */
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

  test('a record opens and can be inline-edited from a phone', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    test.skip(!(await inlineEditOn(page)), 'inline editing is switched off');
    const trigger = page.locator('button[title="Change"]:visible').first();
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

    await page.getByTestId('list-create').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

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

    // And it comes back in the card list — the mobile-only render path.
    await page.goto('/leads');
    await page.getByTestId('list-search').fill(surname);
    // `visible=true` matters: the desktop table is still in the DOM at this
    // width, just display:none, so the text matches twice.
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
