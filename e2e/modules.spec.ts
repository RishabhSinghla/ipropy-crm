import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Every module a user can actually reach, opened and checked.
 *
 * The rest of the e2e suite goes deep on two modules; this goes wide across
 * all of them. In a metadata-driven CRM that is the failure mode worth
 * guarding: modules, fields and layouts are rows, so a seed or migration
 * change can break one module's list view — a dropped column, a uitype with no
 * renderer — while every other screen and every unit test stays green.
 *
 * The module list is read from the sidebar rather than hardcoded, so a module
 * added or disabled in the seed is picked up without editing this file, and
 * the set under test is exactly the set a user can navigate to.
 */

/**
 * Browser errors that are not the app's fault and would make this flaky.
 * Deliberately narrow — anything not listed here fails the test.
 */
const IGNORED_CONSOLE: { why: string; match: (text: string) => boolean }[] = [
  { why: 'not the app', match: (t) => /favicon/i.test(t) },
  { why: 'benign; fired by the dashboard grid on layout', match: (t) => /ResizeObserver loop/i.test(t) },
  { why: 'React devtools nag', match: (t) => /Download the React DevTools/i.test(t) },
  {
    // recharts renders the dots of a <Line> without keys. It is a warning from
    // inside the dependency, not from our render, and it cannot be fixed
    // without patching the library. Matched together with `recharts` in the
    // stack so a missing key in *our* components still fails this test.
    why: 'recharts omits keys on its own Line dots',
    match: (t) => /unique "key" prop/.test(t) && /recharts/.test(t),
  },
];

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((rule) => rule.match(text))) return;
    errors.push(text);
  });
  // An uncaught exception never reaches console.error, so it needs its own
  // hook or a crashed render would look clean.
  page.on('pageerror', (err) => errors.push(`uncaught: ${err.message}`));
  return errors;
}

/** Every one-segment route in the sidebar: the modules, and the tool pages when they are rendered. */
async function moduleRoutes(page: Page): Promise<string[]> {
  await page.goto('/dashboard');
  await expect(page.getByRole('link', { name: /leads & contacts/i })).toBeVisible();

  const routes = await page.evaluate(() => {
    const skip = new Set(['/dashboard', '/settings', '/inbox', '/calls', '/reports', '/portal']);
    return [...document.querySelectorAll<HTMLAnchorElement>('nav a[href]')]
      .map((a) => new URL(a.href).pathname)
      .filter((p) => /^\/[a-z_]+$/.test(p) && !skip.has(p))
      .filter((p, i, all) => all.indexOf(p) === i);
  });

  // Guard against the selector silently matching nothing, which would let this
  // pass while checking zero modules.
  // Three modules plus the tool pages. The threshold used to be >5, written
  // when there were thirteen modules — it now asserts on a product decision
  // (how many modules exist) rather than on the nav working. What matters is
  // that the sidebar lists the modules at all.
  expect(routes, `expected the module routes, got ${JSON.stringify(routes)}`)
    .toEqual(expect.arrayContaining(['/leads', '/properties', '/campaigns']));
  return routes;
}

/**
 * Outreach and Site capture are in the sidebar sweep but are not record lists.
 *
 * Whether they are in the routes at all is a race: the sweep reads the nav as
 * soon as the first module link is visible, so a slower CI runner picks up the
 * tool links and a faster one does not. That is why this test could pass on one
 * commit and fail on the next without either touching the pages — and when it
 * did pick them up it always failed, because it waited for a record count on a
 * screen that has none.
 */
const TOOL_ROUTES = new Set(['/outreach', '/capture']);

/**
 * "Finished loading" is not the same signal on both kinds of page.
 *
 * A module list shows "Loading…" until its query resolves and then "<n> records",
 * which is what proves the *data* arrived, not merely the shell. A tool page has
 * no such count, so its heading is the only honest signal it came up at all —
 * weaker, deliberately, rather than dropping the two pages from the sweep and
 * covering them nowhere.
 */
function settled(page: Page, route: string) {
  return TOOL_ROUTES.has(route)
    ? page.getByRole('heading', { level: 1 })
    : page.getByText(/^[\d,]+ records$/);
}

/**
 * The id of the first record in a module, via the app's own API using the
 * session already in localStorage. Returns null when the module is empty.
 */
async function firstRecordId(page: Page, module: string): Promise<string | null> {
  return page.evaluate(async (name) => {
    const token = localStorage.getItem('ipropy.token');
    const res = await fetch(`/api/records/${name}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ pageSize: 1 }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { rows?: { id: string }[] };
    return body.rows?.[0]?.id ?? null;
  }, module);
}

function hitErrorBoundary(page: Page): Promise<boolean> {
  return page.getByText(/something went wrong on this screen/i).isVisible().catch(() => false);
}

test('every module in the sidebar opens without breaking', async ({ page }) => {
  test.slow();

  const errors = watchConsole(page);
  const routes = await moduleRoutes(page);
  const broken: string[] = [];

  for (const route of routes) {
    const before = errors.length;

    // Click through the sidebar rather than page.goto per module. A full load
    // re-runs bootstrap — me, modules, two capability probes — so twelve of
    // them cost well over a hundred API calls, and the suite as a whole then
    // trips the 600/min limiter in app.ts and fails with an empty shell that
    // looks like a render bug. Clicking is also what a user actually does.
    await page.locator(`nav a[href="${route}"]`).click();
    // Match the *path*, not the end of the URL: a list restores its last view
    // and sort into the query string on arrival, so `/campaigns$` never matches
    // once `?view=…&sort=…` lands — a race that passed locally and failed in CI.
    await page.waitForURL((url) => url.pathname === route);

    try {
      await expect(settled(page, route).first()).toBeVisible({ timeout: 25_000 });
    } catch {
      broken.push(`${route}: never finished loading`);
      continue;
    }

    if (await hitErrorBoundary(page)) broken.push(`${route}: error boundary caught a render failure`);
    const fresh = errors.slice(before);
    if (fresh.length) broken.push(`${route}: ${fresh.slice(0, 3).join(' | ')}`);
  }

  expect(broken.join('\n'), broken.join('\n')).toBe('');
});

test('every module opens its first record without breaking', async ({ page }) => {
  test.slow();

  const errors = watchConsole(page);
  const routes = await moduleRoutes(page);
  const broken: string[] = [];
  let opened = 0;

  for (const route of routes) {
    const module = route.slice(1);
    // Navigate straight to the record rather than clicking a row. Which cell
    // is safe to click is per-module metadata: cells holding an inline editor
    // swallow the click, and a reference cell renders a link to the *related*
    // record, so the obvious choice can navigate somewhere else entirely — a
    // correct app behaviour that has nothing to do with what is under test
    // here. Row-click navigation is covered for Leads in crm.spec.ts; this
    // test is about whether each module's detail page renders.
    const id = await firstRecordId(page, module);
    if (!id) continue; // module has no records

    const before = errors.length;
    await page.goto(`${route}/${id}`);
    opened += 1;

    // The detail page renders the record's name as a heading; a blank shell
    // means the layout or one of its field renderers threw.
    try {
      await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 });
    } catch {
      broken.push(`${route}: detail page rendered no heading`);
    }
    if (await hitErrorBoundary(page)) broken.push(`${route}: detail page hit the error boundary`);
    const fresh = errors.slice(before);
    if (fresh.length) broken.push(`${route} detail: ${fresh.slice(0, 3).join(' | ')}`);
  }

  // If seed data ever stops populating, every module would be skipped and this
  // test would pass having opened nothing.
  expect(opened, 'no module had a record to open').toBeGreaterThan(0);
  expect(broken.join('\n'), broken.join('\n')).toBe('');
});
