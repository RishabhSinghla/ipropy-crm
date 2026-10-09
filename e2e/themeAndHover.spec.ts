import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, unique } from './helpers';

test.use({ viewport: { width: 1600, height: 900 } });
let token = '';
let recordId = '';
let tagId = '';
let visitFieldId = '';
let tagName = '';
test.beforeAll(async ({ request }) => {
  const login = await request.post('http://localhost:4000/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).token;
  const headers = { Authorization: `Bearer ${token}` };
  const visitName = `visit_planned_${Date.now()}`;
  const field = await request.post('http://localhost:4000/api/meta/modules/leads/fields', { headers, data: { name: visitName, label: 'Visit Planned date', uitype: 'date' } });
  expect(field.ok()).toBeTruthy();
  visitFieldId = (await field.json()).id;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const record = await request.post('http://localhost:4000/api/records/leads', { headers, data: { full_name: unique('Hover proof'), mobile: `9${String(Date.now()).slice(-9)}`, [visitName]: date } });
  expect(record.ok()).toBeTruthy();
  recordId = (await record.json()).id;
  tagName = unique('HoverTag');
  const tag = await request.post('http://localhost:4000/api/tags', { headers, data: { name: tagName, color: '#dc2626', modules: ['leads'] } });
  expect(tag.ok()).toBeTruthy();
  tagId = (await tag.json()).id;
  expect((await request.post(`http://localhost:4000/api/records/leads/${recordId}/tags`, { headers, data: { tags: [tagName] } })).ok()).toBeTruthy();
});
test.afterAll(async ({ request }) => {
  const headers = { Authorization: `Bearer ${token}` };
  if (recordId) await request.delete(`http://localhost:4000/api/records/leads/${recordId}`, { headers });
  if (tagId) await request.delete(`http://localhost:4000/api/tags/${tagId}`, { headers });
  if (visitFieldId) await request.delete(`http://localhost:4000/api/meta/fields/${visitFieldId}`, { headers });
});

test('toolbar hover is an overlay; New and tags use the active theme', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible();
  await expect(page.getByTestId('planned-visit-date')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Visits today/ })).toBeVisible();
  const frame = page.getByTestId('workspace-dock-frame');
  const before = await page.getByTestId('ipropy-workspace').boundingBox();
  await frame.hover();
  await expect(page.getByTestId('workspace-dock').getByText('Leads', { exact: true })).toBeVisible();
  const after = await page.getByTestId('ipropy-workspace').boundingBox();
  expect(after!.x).toBe(before!.x);
  await page.getByPlaceholder('Search everything…').hover();
  await expect(frame).toHaveAttribute('data-folded', 'true');
  // This spec's own tag, not whichever happens to be first on the machine running it.
  const tag = page.getByTestId('tag-cards').getByRole('button', { name: new RegExp(tagName.slice(0, 15), 'i') });
  await expect(tag).toBeVisible();
  await tag.click();
  await expect(tag).toHaveAttribute('aria-pressed', 'true');
  const fresh = page.getByRole('button', { name: /^New \d/ });
  await fresh.click();
  await expect(fresh).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    const tagColour = await tag.evaluate(element => getComputedStyle(element).backgroundColor);
    return await fresh.evaluate(element => getComputedStyle(element).backgroundColor) === tagColour;
  }).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Record workspace sections' })).not.toContainText("Builder's Inventory");
  await page.getByRole('button', { name: /^Visits today/ }).click();
  await expect(page.getByRole('button', { name: /^Visits today/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('planned-visit-date')).toBeVisible();
});

test('details open on hover and close from their top edge', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible();
  await page.getByTestId('unfold-details').hover();
  await expect(page.getByTestId('fold-details')).toBeVisible();
  await page.getByTestId('fold-details').click();
  await page.getByPlaceholder('Search everything…').hover();
  await expect(page.getByTestId('unfold-details')).toBeVisible();
  await page.getByRole('button', { name: 'Quick and live filters', exact: true }).click();
  await expect(page.getByText('Quick & Live Filters', { exact: true })).toBeVisible();
  await page.getByTestId('quick-filter-overlay').getByRole('button', { name: /close/i }).click();
  await expect(page.getByText('Quick & Live Filters', { exact: true })).not.toBeVisible();
  await page.screenshot({ path: '/private/tmp/ipropy-ui-hover-proof.png' });
});
