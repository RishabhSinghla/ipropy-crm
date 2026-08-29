import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { inlineEditOn, waitForRecords } from './helpers';

/**
 * Automated accessibility checks on the screens people spend their day in.
 *
 * axe catches the mechanical failures — unlabelled controls, colour contrast,
 * broken ARIA, missing landmarks — which is most of what actually blocks a
 * screen-reader or keyboard user. It cannot judge whether a flow *makes sense*
 * without a mouse, so the keyboard journeys below are asserted by hand.
 *
 * Scoped to WCAG 2.1 A/AA, which is the bar enterprise buyers and the
 * accessibility regulations most customers care about actually test against.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Wait for entrance animations to finish before measuring anything.
 *
 * Playwright calls an element visible as soon as it has a box, so a modal is
 * "visible" at opacity 0.15 while animate-fade-in is still running — and axe
 * then measures the *blended* colour. That produced an intermittent contrast
 * failure reporting #657286 on #f0f0f2, which are not colours this app defines
 * anywhere; they are a half-faded token over a half-faded backdrop. Waiting on
 * the animations makes the scan deterministic instead of a race.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running'),
    undefined,
    { timeout: 5_000 },
  ).catch(() => undefined); // a looping animation (spinner) must not hang the scan
}

async function scan(page: Page) {
  await settle(page);
  // Contrast is included: colours come from tokens with a proven ratio
  // (lib/color.ts, tests/color.test.ts), so a regression here is a real bug
  // rather than a known backlog item.
  return new AxeBuilder({ page }).withTags(WCAG).analyze();
}

/** Contrast-only scan, used for the both-themes sweep below. */
async function scanContrast(page: Page) {
  await settle(page);
  return new AxeBuilder({ page }).withTags(WCAG).withRules(['color-contrast']).analyze();
}

/**
 * Flip the theme through the real toggle rather than by setting the class.
 * bootstrap() treats the server-stored user.theme as authoritative, so a
 * client-only change is reverted by the next full page load — which is exactly
 * what every page.goto() below does.
 */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if (isDark === (theme === 'dark')) return;

  // Wait for the profile write, not just the class. setTheme in the store
  // fires the PATCH without awaiting it, so a test that ends here can finish
  // before the preference is saved — leaving the shared admin in dark mode and
  // colouring the *next* run of the whole suite.
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/auth/me') && r.request().method() === 'PATCH',
      { timeout: 10_000 },
    ).catch(() => undefined),
    page.getByRole('button', { name: /toggle theme/i }).click(),
  ]);
  await page.waitForFunction(
    (t) => document.documentElement.classList.contains('dark') === (t === 'dark'),
    theme,
  );
}

/** Readable failure output — axe's raw objects are unreadable in CI logs. */
function summarise(violations: Awaited<ReturnType<typeof scan>>['violations']): string {
  return violations
    .map((v) => `\n  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`)
    .join('');
}

test.describe('accessibility', () => {
  test('login page has no violations', async ({ page }) => {
    await page.goto('/login');
    const { violations } = await scan(page);
    expect(violations, summarise(violations)).toEqual([]);
  });

  test('dashboard has no violations', async ({ page }) => {
    await page.goto('/dashboard');
    const { violations } = await scan(page);
    expect(violations, summarise(violations)).toEqual([]);
  });

  test('list view has no violations', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);
    const { violations } = await scan(page);
    expect(violations, summarise(violations)).toEqual([]);
  });

  test('record detail has no violations', async ({ page, context }) => {
    await page.goto('/leads');
    await waitForRecords(page);

    // A record opens in a new tab by default now, so the page under test may be
    // the popup rather than this one. Handle both, because the setting decides
    // and this test is about the record page either way.
    const popup = context.waitForEvent('page').catch(() => null);
    await page.locator('tbody tr').first().locator('td').nth(1).click();
    const opened = await Promise.race([
      popup,
      page.waitForURL(/\/leads\/[0-9a-f-]{36}/).then(() => null).catch(() => null),
    ]);

    const target = opened ?? page;
    await target.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const { violations } = await scan(target);
    expect(violations, summarise(violations)).toEqual([]);
    if (opened) await opened.close();
  });

  test('the new-record dialog has no violations', async ({ page }) => {
    await page.goto('/leads');
    await page.getByRole('button', { name: /new lead/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const { violations } = await scan(page);
    expect(violations, summarise(violations)).toEqual([]);
  });
});

/**
 * Contrast across both themes and the screens people actually live in.
 *
 * Kept separate from the per-page scans above because it has to drive the
 * theme toggle and walk several routes in one session — the shared admin's
 * theme is a server-side preference, so it must be put back at the end or it
 * leaks into every other spec.
 */
test('has no colour-contrast violations in either theme', async ({ page }) => {
  test.slow(); // ten full page loads plus two axe passes each
  const failures: string[] = [];

  for (const theme of ['light', 'dark'] as const) {
    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: /leads & contacts/i })).toBeVisible();
    await setTheme(page, theme);

    for (const route of ['/dashboard', '/leads', '/properties', '/settings']) {
      await page.goto(route);
      if (route === '/leads' || route === '/properties') await waitForRecords(page);
      await expect(page.getByRole('link', { name: /leads & contacts/i })).toBeVisible();
      const { violations } = await scanContrast(page);
      if (violations.length) failures.push(`\n[${theme}] ${route}${summarise(violations)}`);
    }
  }

  // Restore the shared account before asserting, so a failure here cannot
  // leave every subsequent spec running in the wrong theme.
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: /leads & contacts/i })).toBeVisible();
  await setTheme(page, 'light');

  expect(failures.join(''), failures.join('')).toBe('');
});

test.describe('keyboard operation', () => {
  test('the whole app is reachable without a mouse', async ({ page }) => {
    await page.goto('/dashboard');
    // Wait for the shell: before it renders, RequireAuth shows only a spinner
    // and the skip link does not exist yet.
    await expect(page.getByRole('link', { name: /leads & contacts/i })).toBeVisible();

    // A skip link must be the first focusable thing on the page, or a keyboard
    // user tabs through the entire sidebar on every single page load.
    // Asserted structurally rather than by pressing Tab: where focus starts
    // before the first Tab is inconsistent in headless browsers, and that
    // inconsistency would make this flaky without testing anything more.
    const firstFocusableText = await page.evaluate(() => {
      const sel = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
      const el = document.querySelector<HTMLElement>(sel);
      return el?.textContent?.trim() ?? '';
    });
    expect(firstFocusableText).toMatch(/skip to (main )?content/i);

    // And activating it must actually move focus into the main region.
    const skip = page.getByRole('link', { name: /skip to main content/i });
    await skip.focus();
    await expect(skip).toBeFocused();
    await skip.press('Enter');

    const landed = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.id === 'main' || el?.closest('main') !== null;
    });
    expect(landed).toBe(true);
  });

  test('a modal traps focus and restores it on close', async ({ page }) => {
    await page.goto('/leads');

    const opener = page.getByRole('button', { name: /new lead/i });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Focus must be inside the dialog, otherwise a screen reader keeps
    // reading the page behind it.
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);

    // Tabbing repeatedly must never escape the dialog.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
      expect(inside, `focus escaped the dialog after ${i + 1} tabs`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    // And it must come back to what opened it, not to the top of the document.
    await expect(opener).toBeFocused();
  });

  test('an inline edit can be opened and cancelled from the keyboard', async ({ page }) => {
    await page.goto('/leads');
    await waitForRecords(page);
    // Editing from a list ships off, so this covers the keyboard path only when
    // somebody has switched it on. Skipped rather than deleted: the feature is
    // still there and still has to be operable without a mouse for whoever uses it.
    test.skip(!(await inlineEditOn(page)), 'inline editing is switched off');

    const trigger = page.locator('button[title="Click to edit"]:visible').first();
    await trigger.focus();
    await page.keyboard.press('Enter');

    // Something editable must now hold focus.
    const opened = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.closest('[role="listbox"], .animate-slide-up') !== null;
    });
    expect(opened).toBe(true);

    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });
});
