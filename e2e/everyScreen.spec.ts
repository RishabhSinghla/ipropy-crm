/**
 * Open every screen and see whether it actually works.
 *
 * The API sweeps in `scripts/daily-paths.mjs` prove the server answers. They
 * cannot see a screen that renders an error boundary, throws in an effect,
 * or paints an empty shell because one field it names has been deleted — and
 * that last one is this project's most repeated bug, so the admin screens are
 * exactly where it would land.
 *
 * Run against a database mirrored to production's field shape
 * (`scripts/mirror-prod-shape.sh`). On a fresh seed every field exists and this
 * proves much less.
 *
 * What counts as broken, deliberately narrowly: an uncaught exception, a
 * console error, a failed API call, or a page with nothing on it. Warnings are
 * ignored — React is noisy in development and a test that fails on noise gets
 * switched off.
 */
import { test, expect, type Page } from '@playwright/test';

const ADMIN_SCREENS = [
  'modules', 'fields', 'layouts', 'views', 'header', 'picklists', 'users',
  'roles', 'sharing', 'map', 'workflows', 'import', 'matching', 'units',
  'integrations', 'settings', 'brand', 'system',
];

interface Trouble { kind: string; detail: string }

/** Everything that went wrong while the page was open. */
function watch(page: Page): Trouble[] {
  const trouble: Trouble[] = [];
  page.on('pageerror', (e) => trouble.push({ kind: 'threw', detail: String(e).slice(0, 180) }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // A 429 is the suite's own doing — a hundred specs share one account — and
    // says nothing about the screen. Everything else counts.
    if (text.includes('429') || text.includes('Too many requests')) return;
    trouble.push({ kind: 'console', detail: text.slice(0, 180) });
  });
  page.on('response', (r) => {
    if (r.status() < 400 || !r.url().includes('/api/')) return;
    if (r.status() === 404 || r.status() === 429) return;
    trouble.push({ kind: `HTTP ${r.status()}`, detail: r.url().replace(/^https?:\/\/[^/]+/, '') });
  });
  return trouble;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(350);
}

test.describe('every screen', () => {
  for (const screen of ADMIN_SCREENS) {
    test(`admin: ${screen} opens without throwing`, async ({ page }) => {
      const trouble = watch(page);
      await page.goto(`/admin/${screen}`);
      await settle(page);

      // Something has to be on it. An admin screen that renders its chrome and
      // no content is the shape a deleted field produces.
      const text = (await page.locator('body').innerText().catch(() => '')) ?? '';
      expect(text.trim().length, `/admin/${screen} rendered nothing`).toBeGreaterThan(40);
      expect(text).not.toContain('Something went wrong');

      expect(
        trouble,
        `/admin/${screen}:\n${trouble.map((t) => `  ${t.kind}: ${t.detail}`).join('\n')}`,
      ).toEqual([]);
    });
  }

  for (const path of ['/dashboard', '/leads', '/properties', '/settings', '/capture']) {
    test(`${path} opens without throwing`, async ({ page }) => {
      const trouble = watch(page);
      await page.goto(path);
      await settle(page);
      const text = (await page.locator('body').innerText().catch(() => '')) ?? '';
      expect(text.trim().length, `${path} rendered nothing`).toBeGreaterThan(40);
      expect(trouble, `${path}:\n${trouble.map((t) => `  ${t.kind}: ${t.detail}`).join('\n')}`).toEqual([]);
    });
  }

  test('a record opens without throwing', async ({ page }) => {
    const trouble = watch(page);
    await page.goto('/leads');
    const row = page.locator('tbody tr:visible, [data-record-card]:visible').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await settle(page);

    const text = (await page.locator('body').innerText().catch(() => '')) ?? '';
    expect(text.trim().length).toBeGreaterThan(40);
    expect(trouble, `record detail:\n${trouble.map((t) => `  ${t.kind}: ${t.detail}`).join('\n')}`).toEqual([]);
  });
});
