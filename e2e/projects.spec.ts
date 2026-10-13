/**
 * Projects, in a real browser.
 *
 * **8 October 2026, the owner:** *"make me a project module in the CRM wherein we
 * can input all details of all projects we got … DLF, BPTP, Omaxe etc."*
 *
 * What only a browser can prove: the module is in the navigation and a rep can
 * explicitly link an existing Inventory record from the project's dedicated
 * Availability workspace.
 */
import { expect, test } from '@playwright/test';

const API = 'http://localhost:4000';
const MARK = `ProjectWalk${Date.now()}`;
const made: { module: string; id: string }[] = [];
let token = '';

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${API}/api/auth/login`, {
    data: { email: process.env.E2E_EMAIL ?? 'admin@ipropy.com', password: process.env.E2E_PASSWORD ?? 'Admin@123' },
  });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).token;
  const headers = { Authorization: `Bearer ${token}` };

  const project = await request.post(`${API}/api/records/projects`, {
    headers,
    data: { project_name: `${MARK} BPTP Terra`, developer: 'BPTP', project_status: 'Under Construction', city: 'Faridabad', locality: 'Sector 37D' },
  });
  expect(project.ok(), await project.text()).toBeTruthy();
  made.push({ module: 'projects', id: (await project.json()).id });

  const unit = await request.post(`${API}/api/records/properties`, {
    headers,
    data: {
      full_name: `${MARK} Seller`, mobile: `98${String(Date.now()).slice(-8)}`, country_code: '91',
      project_name: `${MARK.toLowerCase()} bptp terra`, status: 'Available', unit_number: `${MARK}-T2-704`,
    },
  });
  expect(unit.ok(), await unit.text()).toBeTruthy();
  made.push({ module: 'properties', id: (await unit.json()).id });
});

test.afterAll(async ({ request }) => {
  for (const { module, id } of made) {
    await request.delete(`${API}/api/records/${module}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  }
});

test('is in the navigation, not only at an address', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('a[href="/projects"]').first()).toBeAttached({ timeout: 30_000 });
});

test('opens a project and explicitly links an existing Inventory unit', async ({ page }) => {
  await page.goto('/projects');
  const row = page.getByRole('button').filter({ hasText: MARK }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('BPTP');
  await expect(row).toContainText('Faridabad');
  await row.click();
  await expect(page.getByRole('heading', { name: 'Project Explorer' })).toBeVisible();

  // Project Explorer intentionally keeps its own workspace rather than the
  // generic split-view queue. Units are linked explicitly from Availability;
  // a matching project_name alone must not silently duplicate/link records.
  await page.getByRole('button', { name: 'Availability', exact: true }).click();
  const search = page.getByPlaceholder('Search Inventory by name, house number, locality…');
  await search.fill(`${MARK}-T2-704`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const linkButton = page.getByRole('button', { name: 'Link unit' }).first();
  await expect(linkButton).toBeVisible({ timeout: 20_000 });
  await expect(linkButton.locator('..')).toContainText(`${MARK} Seller`);
  await linkButton.click();
  await expect(page.getByText(`${MARK} Seller`).last()).toBeVisible();
});
