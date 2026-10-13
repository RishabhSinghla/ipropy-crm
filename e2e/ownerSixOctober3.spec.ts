/**
 * The owner's six of 3 October 2026, late — driven in a browser on both modules.
 *
 * Two of these can only be checked here: whether the call icon ended up beside
 * the record number, and whether a tag ticked in the panel reaches the server as
 * `record_tags` rather than as a field of that name.
 */
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, unique } from './helpers';

test.use({ viewport: { width: 1600, height: 900 } });

const MODULES = ['leads', 'properties'] as const;

// The quick filter's tag list starts with an "Unfilled" row that is not a tag,
// and a fresh database has no tags at all, so the test makes its own.
const tagName = unique('QuickTag');
let token = '';
let tagId = '';
test.beforeAll(async ({ request }) => {
  const login = await request.post('http://localhost:4000/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).token;
  const tag = await request.post('http://localhost:4000/api/tags', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: tagName, color: '#dc2626', modules: [...MODULES] },
  });
  expect(tag.ok()).toBeTruthy();
  tagId = (await tag.json()).id;
});
test.afterAll(async ({ request }) => {
  if (tagId) await request.delete(`http://localhost:4000/api/tags/${tagId}`, { headers: { Authorization: `Bearer ${token}` } });
});

async function openList(page: Page, module: string): Promise<void> {
  await page.goto(`/${module}`);
  await expect(page.getByText(/[\d,]+ records/).first()).toBeVisible({ timeout: 30_000 });
}

async function openFirstRecord(page: Page, module: string): Promise<void> {
  await openList(page, module);
  await page.getByTestId('queue-card').first().click();
  await expect(page.getByTestId('record-menu-bar')).toBeVisible({ timeout: 20_000 });
}

for (const module of MODULES) {
  // 1 — *"Move the call icon after record number in Middle header pane"*
  test(`${module}: Call sits beside the record number`, async ({ page }) => {
    await openFirstRecord(page, module);
    const header = page.getByTestId('split-hero-layout');
    const call = header.getByRole('button', { name: /^Call / }).first();
    if (!(await call.count())) test.skip(true, 'the first record has no number');

    const counter = header.getByLabel('Record navigation');
    const [callBox, counterBox] = await Promise.all([call.boundingBox(), counter.boundingBox()]);
    // Inside the navigation group, so the two cannot drift apart when the header
    // wraps — and measured, because "inside" is the whole of the promise.
    expect(await counter.locator('button[aria-label^="Call "]').count(),
      'Call should live in the record-number group').toBeGreaterThan(0);
    expect(callBox!.x, 'Call should come after the number').toBeGreaterThan(counterBox!.x);

    // And it is no longer on the bar's row under the name.
    const bar = header.getByRole('img', { name: /Record \d+% complete/ }).first();
    const barBox = (await bar.boundingBox())!;
    expect(Math.abs((callBox!.y + callBox!.height / 2) - (barBox.y + barBox.height / 2)),
      'Call should have left the completeness bar’s row').toBeGreaterThan(8);
  });

  // 2 — *"need Tag Filter in quick Filter"*
  test(`${module}: tags are a section of the quick filter, and reach the server as tags`, async ({ page }) => {
    await openList(page, module);
    await page.getByTestId('quick-filter-button').click();
    const panel = page.getByTestId('quick-filter-overlay');
    await expect(panel).toBeVisible();

    const heading = panel.getByRole('button', { name: /Tag wise/ });
    await expect(heading).toBeVisible();
    await heading.click();

    /*
      A tag is not a field on the module, so it cannot be sent as one. Watching
      the request is the only way to see that: a filter sent as `{field:"hot"}`
      would answer an error the panel swallows, and the list would simply not
      move, which reads as the tick doing nothing.
    */
    let askedByTag = false;
    await page.route('**/api/records/**', async (route) => {
      const asked = decodeURIComponent(route.request().postData() ?? route.request().url());
      if (asked.includes('record_tags') && asked.includes('has_any')) askedByTag = true;
      await route.continue();
    });

    /*
      A choice is a plain button carrying `aria-pressed`, not a checkbox role —
      and the locator must not have `aria-pressed="false"` in it, or ticking the
      tag makes it match the *next* unticked one and the assertion can never
      pass. Take the name first, then watch that row.
    */
    const row = panel.getByTestId('quick-filter-tags').locator('button[aria-pressed]').filter({ hasText: tagName }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => askedByTag, { timeout: 15_000 }).toBe(true);
  });

  // 4 — *"remove unread list from all modules list completely"*
  test(`${module}: there is no unread list and no unread filter`, async ({ page }) => {
    await openList(page, module);
    await page.getByRole('button', { name: /Choose or manage list views/ }).click();
    await expect(page.getByText('Select a list')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Unread/ })).toHaveCount(0);
  });

  // 5 — *"Give more space in between rows of record in the left record pane"*
  test(`${module}: the queue rows have room between them`, async ({ page }) => {
    await openList(page, module);
    const cards = page.getByTestId('queue-card');
    expect(await cards.count(), 'needs records in the queue').toBeGreaterThan(1);
    const padding = await cards.first().locator('button').first()
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
    // The clickable row itself provides 16px of breathing room between facts.
    expect(padding).toBeGreaterThanOrEqual(14);
  });
}

// 3 — *"decrease the size company logo avtar, bcoz the circle overlap the padding"*
test('the header no longer contains a company avatar', async ({ page }) => {
  await openList(page, 'leads');
  const mark = page.getByTestId('brand-mark');
  await expect(mark).toHaveCount(0);
});

// 4, the other half — *"remove unread functionality from all records"*
test('nothing asks the server about unread any more', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('unseen') || url.includes('/seen')) seen.push(`${request.method()} ${url}`);
  });
  await openList(page, 'leads');
  await page.getByTestId('queue-card').first().click();
  await expect(page.getByTestId('record-menu-bar')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2_000);
  expect(seen, 'the unread endpoints are gone from the server too').toEqual([]);
});
