import { chromium } from '@playwright/test';
const WEB = 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();

await page.goto(WEB + '/login');
await page.getByLabel('Email or mobile number', { exact: true }).fill('admin@ipropy.com');
await page.getByLabel('Password', { exact: true }).fill('Admin@123');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(/\/dashboard/, { timeout: 30000 });

// Put every view back on first, so the run starts from a known place.
await page.goto(WEB + '/admin/list-views');
await page.getByRole('heading', { name: 'List views' }).waitFor({ timeout: 15000 });
for (const name of ['Table', 'Board', 'Split view']) {
  const b = page.getByRole('button', { pressed: false }).filter({ hasText: name }).first();
  if (await b.count()) await b.click();
}
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(1500);

// Now switch the board off and walk to the list WITHOUT reloading — clicking,
// the way a person does. This is the path the earlier check missed, because
// page.goto() is a full page load and hides the whole problem.
await page.getByRole('button', { pressed: true }).filter({ hasText: 'Board' }).first().click();
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(2000);

await page.getByRole('link', { name: /^Contacts$/ }).first().click().catch(async () => {
  // Fall back to the in-app router without a document load.
  await page.evaluate(() => window.history.pushState({}, '', '/leads'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
});
await page.waitForTimeout(3500);

const board = await page.locator('button[title="Kanban"], button[title="This module has no pipeline field"]').count();
const table = await page.locator('button[title="Table"]').count();
const split = await page.locator('button[aria-label="Split view"]').count();
console.log(`WITHOUT a reload: table=${table} board=${board} split=${split}`);
console.log(board === 0 ? 'PASS — the board button went away without a refresh'
                        : 'FAIL — the board button is still there until you refresh');
await browser.close();
