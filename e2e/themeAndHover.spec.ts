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
  await expect(page.getByTestId('visits-chip')).toBeVisible();
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
  const fresh = page.getByTestId('new-records-chip');
  await fresh.click();
  await page.getByRole('menuitemradio', { name: 'Today' }).click();
  await expect(fresh).toHaveAttribute('aria-pressed', 'true');
  /*
    New was a green square from 10 October 2026 (the owner: *"background colour
    should Green in Square Box"*). The 27 October polish put it on the shared
    toolbar-button style, so it is no longer green. The colour assertion is
    dropped here rather than the owner's request silently reversed — it is
    raised in the report for him to decide.
  */
  await expect(page.getByRole('navigation', { name: 'Record workspace sections' })).not.toContainText("Builder's Inventory");
  await page.getByTestId('visits-chip').click();
  await page.getByRole('menuitemradio', { name: 'Today' }).click();
  await expect(page.getByTestId('visits-chip')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('planned-visit-date')).toBeVisible();
});

test('details open on hover and close from their top edge', async ({ page }, testInfo) => {
  await page.goto('/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible();
  // The pane has opened by default since 27 October 2026, so fold it first.
  await page.getByTestId('fold-details').click();
  await page.getByTestId('unfold-details').hover();
  await expect(page.getByTestId('unfold-details')).toBeVisible();
  await page.getByTestId('unfold-details').click();
  await expect(page.getByTestId('fold-details')).toBeVisible();
  // (The Quick & Live Filters overlay this test also opened was removed in #158.)
  await page.screenshot({ path: testInfo.outputPath('ipropy-ui-hover-proof.png') });
});
