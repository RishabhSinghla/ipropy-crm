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

    /*
      The record counter and Next button left this header with the 27 October
      2026 polish, so "beside the record number" no longer has a number to sit
      beside. What still matters is that Call is in the header, after the name.
    */
    const name = header.getByRole('heading').first();
    const [callBox, nameBox] = await Promise.all([call.boundingBox(), name.boundingBox()]);
    expect(callBox!.x, 'Call should come after the name').toBeGreaterThan(nameBox!.x);
  });

  // 2 — the Quick & Live Filters overlay, and its Tag section, were removed on
  // 26 October 2026 (#158); the tag cards beside the search box are covered by
  // ownerTenOctober3 ("the tag cards count the module they open").

  // 4 — *"remove unread list from all modules list completely"*
  test(`${module}: there is no unread list and no unread filter`, async ({ page }) => {
    await openList(page, module);
    // The list picker is gone (#154), so the lists are read from the API the screen reads.
    const token = await page.evaluate(() => localStorage.getItem('ipropy.token'));
    const res = await page.request.get(`/api/views/${module}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.ok()).toBeTruthy();
    const views = (await res.json()) as Array<{ name: string }>;
    expect(views.filter((v) => /^Unread/i.test(v.name))).toEqual([]);
  });

  // 5 — *"Give more space in between rows of record in the left record pane"*
  test(`${module}: the queue rows have room between them`, async ({ page }) => {
    await openList(page, module);
    const cards = page.getByTestId('queue-card');
    expect(await cards.count(), 'needs records in the queue').toBeGreaterThan(1);
    const padding = await cards.first().locator('button').first()
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
    // The 27 October 2026 polish tightened the rows from 16px to 8px; the
    // promise kept is that a row is still not flush against its neighbour.
    expect(padding).toBeGreaterThanOrEqual(8);
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
