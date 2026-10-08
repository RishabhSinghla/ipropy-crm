/**
 * Projects, in a real browser.
 *
 * **8 October 2026, the owner:** *"make me a project module in the CRM wherein we
 * can input all details of all projects we got … DLF, BPTP, Omaxe etc."*
 *
 * What only a browser can prove: the module is in the navigation, a project
 * opens on its Units tab, and that tab finds the Inventories carrying the
 * project's name — typed differently, as a rep would type it.
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

test("opens a project on its Units tab, finding the units however the name was typed", async ({ page }) => {
  const id = made.find((m) => m.module === 'projects')!.id;
  await page.goto(`/projects?open=${id}`);
  const row = page.getByTestId('queue-card').filter({ hasText: MARK }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The row's second line is the project's own facts, not a unit's.
  await expect(row).toContainText('BPTP');
  await expect(row).toContainText('Faridabad');

  const table = page.getByTestId('builder-floor-table');
  await expect(table).toBeVisible({ timeout: 20_000 });
  await expect(table).toContainText(`${MARK} BPTP Terra`);
  await expect(table.getByRole('row').filter({ hasText: `${MARK}-T2-704` })).toHaveCount(1);
});
