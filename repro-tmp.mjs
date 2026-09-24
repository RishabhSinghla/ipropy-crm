import { chromium } from '@playwright/test';

const API = 'http://localhost:4000';
const WEB = 'http://localhost:5173';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const problems = [];

page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

// Sign in the way a person does.
await page.goto(WEB + '/login');
await page.getByLabel('Email or mobile number', { exact: true }).fill('admin@ipropy.com');
await page.getByLabel('Password', { exact: true }).fill('Admin@123');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
console.log('1. signed in ->', page.url());

// What does the app think the setting is, right now?
const before = await page.evaluate(async () => {
  const token = localStorage.getItem('ipropy.token');
  const r = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  return (await r.json()).ui?.listViews ?? null;
});
console.log('2. me.ui.listViews at boot:', JSON.stringify(before));

// Go to the admin screen and switch the board off, like he would.
await page.goto(WEB + '/admin/list-views');
await page.getByRole('heading', { name: 'List views' }).waitFor({ timeout: 15000 });
const boardButton = page.getByRole('button', { pressed: true }).filter({ hasText: 'Board' }).first();
console.log('3. admin page loaded; board button found:', await boardButton.count() > 0);
await boardButton.click();
await page.click('button:has-text("Save")');
await page.waitForTimeout(2500);

const after = await page.evaluate(async () => {
  const token = localStorage.getItem('ipropy.token');
  const r = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
  return (await r.json()).ui?.listViews ?? null;
});
console.log('4. me.ui.listViews after save:', JSON.stringify(after));

// Now the thing he actually looks at: the buttons above a list.
async function countViewButtons(label) {
  await page.goto(WEB + '/leads');
  await page.waitForTimeout(3500);
  const table = await page.locator('button[title="Table"]').count();
  const board = await page.locator('button[title="Kanban"], button[title="This module has no pipeline field"]').count();
  const split = await page.locator('button[aria-label="Split view"]').count();
  console.log(`${label} table=${table} board=${board} split=${split}`);
  return { table, board, split };
}

const navigated = await countViewButtons('5. after in-app navigation:');
await page.reload();
const reloaded = await countViewButtons('6. after a full page reload:');

if (after && after.kanban === false) console.log('   SERVER: saved correctly');
else { console.log('   SERVER: DID NOT SAVE -> ', JSON.stringify(after)); problems.push('server did not save'); }
if (navigated.board > 0) problems.push('board button still there after navigating');
if (reloaded.board > 0) problems.push('board button STILL there after a full reload');

await page.screenshot({ path: '/tmp/claude-0/-home-user-ipropy-crm/3509af4f-6030-5c00-ba22-1c12f7bc5caf/scratchpad/list-after.png', fullPage: false });
console.log('\nPROBLEMS:', problems.length ? problems.join(' | ') : 'none');
await browser.close();
