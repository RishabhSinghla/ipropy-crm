import { expect, test } from '@playwright/test';

/*
  Once an admin gives the two WhatsApp routes their jobs, a sales rep sees ONE
  WhatsApp and nothing of the official API, and the admin-only pages are shut on
  the server as well as hidden on screen.

  Signs in as a seeded demo rep (not an admin). The roles are set through the
  admin API for the length of the test and put back afterwards, so no other spec
  meets a CRM that is split in two.
*/
test('a sales rep sees one WhatsApp and none of the admin-only pages', async ({ page, browser, request }) => {
  await page.goto('/dashboard');
  const adminToken = await page.evaluate(() => localStorage.getItem('ipropy.token'));
  const admin = { Authorization: `Bearer ${adminToken}` };
  const setRoles = (automation: string | null, chat: string | null) =>
    request.put('/api/admin/whatsapp/roles', { headers: admin, data: { automation, chat } });

  expect((await setRoles('whatsapp_whatsmarketing', 'whatsapp_openwa')).ok()).toBeTruthy();
  const rep = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const repPage = await rep.newPage();
    await repPage.goto('/login');
    await repPage.getByLabel('Email or mobile number', { exact: true }).fill('priya.sharma@ipropy.com');
    await repPage.getByLabel('Password', { exact: true }).fill(process.env.E2E_PASSWORD ?? 'Admin@123');
    await repPage.getByRole('button', { name: 'Sign in' }).click();
    await repPage.waitForURL(/\/dashboard/, { timeout: 30_000 });

    const dock = repPage.getByTestId('workspace-dock');
    await expect(dock).toBeVisible();
    const rows = (await dock.locator('a').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.getAttribute('title') || (e.textContent ?? '').trim()))).filter(Boolean);
    // One chat inbox, plus the Lookup tool added on 29 October 2026 (#178); no admin WhatsApp pages.
    expect(rows.filter((row) => /^WhatsApp/.test(row))).toEqual(['WhatsApp', 'WhatsApp Lookup']);
    expect(rows.join('|')).not.toMatch(/Dealer groups|Favourites|WhatsApp API/);

    await repPage.goto('/market');
    await expect(repPage).toHaveURL(/\/dashboard/);
    await repPage.goto('/whatsapp-api');
    await expect(repPage).toHaveURL(/\/dashboard/);

    await repPage.goto('/whatsapp');
    await expect(repPage.locator('main')).toBeVisible();
    expect(await repPage.locator('body').innerText()).not.toMatch(/\bCampaigns\b|\bTemplates\b/);

    const token = await repPage.evaluate(() => localStorage.getItem('ipropy.token') ?? '');
    const as = { Authorization: `Bearer ${token}` };
    // The composer asks for templates on every open: an empty list, not an error.
    const templates = await request.get('/api/whatsapp-business/templates', { headers: as });
    expect(templates.status()).toBe(200);
    expect(await templates.json()).toEqual([]);
    expect((await request.get('/api/whatsapp-business/templates/saved', { headers: as })).status()).toBe(200);
    // Everything else about the official API is refused on the server.
    expect((await request.get('/api/whatsapp-business/campaigns', { headers: as })).status()).toBe(403);
    expect((await request.get('/api/whatsapp-business/overview', { headers: as })).status()).toBe(403);
  } finally {
    await rep.close();
    await setRoles(null, null);
  }
});
