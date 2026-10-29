/**
 * The WhatsApp chat on a contact, with OpenWA as the connection — driven in a
 * real browser against a pretend OpenWA (`packages/server/tests/fakes`). No
 * real WhatsApp message is sent or read anywhere.
 *
 * What it proves that the API tests cannot: that a customer's message shows up
 * on the right contact, that typing and pressing Send reaches OpenWA, that the
 * ticks move, that a refusal is shown in words, that the banner appears when the
 * phone is unlinked, and that the panel is usable on a phone in dark mode.
 *
 * It temporarily switches the OpenWA card on in whatever database the dev stack
 * uses and puts every WhatsApp card back exactly as it found it.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, openFromListByName, unique } from './helpers';
import { inboundMessage, startFakeOpenWa, type FakeOpenWa } from '../packages/server/tests/fakes/fakeOpenWa';

const API = 'http://localhost:4000';
const SECRET = 'e2e-openwa-webhook-secret-123456';
const WEBHOOK = `${API}/api/webhooks/whatsapp/openwa`;

test.use({ viewport: { width: 1512, height: 900 } });
test.describe.configure({ mode: 'serial' });

let fake: FakeOpenWa;
let auth: Record<string, string> = {};
let previouslyActive: string[] = [];
const name = unique('OpenWA Chat');
const mobile = `9${String(Date.now()).slice(-9)}`;
const stranger = `8${String(Date.now()).slice(-9)}`;

async function api(request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: unknown) {
  const res = await request[method](`${API}${path}`, { headers: auth, data });
  return { status: res.status(), body: await res.json().catch(() => ({})) as Record<string, any> };
}

test.beforeAll(async ({ request }) => {
  fake = await startFakeOpenWa({ sessionName: 'company' });
  const login = await request.post(`${API}/api/auth/login`, { data: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  auth = { Authorization: `Bearer ${(await login.json()).token}` };

  const cards = await api(request, 'get', '/api/admin/integrations');
  const list = (cards.body as unknown as { provider: string; isActive: boolean }[]);
  expect(list.some((c) => c.provider === 'whatsapp_openwa'),
    'the OpenWA card is missing — run `npm run db:seed` once so the integration row exists').toBe(true);
  previouslyActive = list.filter((c) => c.provider.startsWith('whatsapp_') && c.isActive).map((c) => c.provider);

  const saved = await api(request, 'put', '/api/admin/integrations/whatsapp_openwa', {
    config: {
      baseUrl: fake.baseUrl, sessionName: 'company',
      dailyCapPerUser: '200', dailyCapPerNumber: '50', minSpacingSeconds: '3',
    },
    credentials: { apiKey: fake.apiKey, webhookSecret: SECRET },
    isActive: true,
  });
  expect(saved.status).toBe(200);

  const lead = await api(request, 'post', '/api/records/leads', { full_name: name, mobile });
  expect(lead.status, JSON.stringify(lead.body)).toBeLessThan(300);
});

test.afterAll(async ({ request }) => {
  // The contacts this spec made, so the next spec that opens "the first record"
  // does not land on a contact with a WhatsApp history it did not expect.
  const found = await api(request, 'post', '/api/records/leads/search', { search: 'OpenWA Chat', pageSize: 100 });
  const mine = ((found.body.rows ?? found.body.records ?? []) as { id: string; label: string }[])
    .filter((row) => row.label === name);
  for (const row of mine) await request.delete(`${API}/api/records/leads/${row.id}`, { headers: auth });
  const created = await api(request, 'post', '/api/records/leads/search', { search: 'Meera Kapoor', pageSize: 20 });
  for (const row of ((created.body.rows ?? created.body.records ?? []) as { id: string; label: string }[])) {
    await request.delete(`${API}/api/records/leads/${row.id}`, { headers: auth });
  }
  await api(request, 'put', '/api/admin/integrations/whatsapp_openwa', { isActive: false });
  for (const provider of previouslyActive) {
    if (provider !== 'whatsapp_openwa') await api(request, 'put', `/api/admin/integrations/${provider}`, { isActive: true });
  }
  await fake.close();
});

async function openChat(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/leads');
  const url = await openFromListByName(page, 'leads', name);
  await page.goto(url);
  // The tab carries a message count ("WhatsApp 1"); the first match is the tab, the second a quick action.
  await page.getByRole('button').filter({ hasText: /^WhatsApp/ }).first().click();
}

test('a customer\'s message appears on the contact, under a date', async ({ page }) => {
  const res = await fake.deliver(WEBHOOK, SECRET, 'message.received',
    inboundMessage({ phone: `91${mobile}`, id: `E2E${Date.now()}A`, body: 'Is the 3 BHK still available?' }));
  expect(res.status).toBe(200);
  await openChat(page);
  await expect(page.getByText('Is the 3 BHK still available?')).toBeVisible({ timeout: 30_000 });
  // The day sits once, down the middle.
  await expect(page.getByText(/^today$/i).first()).toBeVisible();
});

test('typing a reply and pressing Send reaches OpenWA, once, to that contact only', async ({ page }) => {
  await openChat(page);
  const before = fake.sends.length;
  await page.getByLabel('Write a WhatsApp message').fill('Yes, it is. Shall we visit on Saturday?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // A paragraph in the thread, not the text still sitting in the box.
  await expect(page.locator('p', { hasText: 'Yes, it is. Shall we visit on Saturday?' })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fake.sends.length, { timeout: 15_000 }).toBe(before + 1);
  expect(fake.sends.at(-1)).toMatchObject({ route: 'send-text', chatId: `91${mobile}@c.us` });
  await expect(page.getByText(/sent via the business number/i).first()).toBeVisible();
});

test('a read receipt moves the ticks to read', async ({ page }) => {
  const sentId = fake.sends.at(-1)!.id;
  await fake.deliver(WEBHOOK, SECRET, 'message.ack', { id: sentId, status: 'read', chatId: `91${mobile}@c.us` });
  await openChat(page);
  await expect(page.getByText(/read via the business number/i).first()).toBeVisible({ timeout: 30_000 });
});

test('OpenWA\'s own rate limit is shown in plain words and the message is marked not delivered', async ({ page }) => {
  await openChat(page);
  await page.waitForTimeout(3500); // the minimum spacing between sends
  fake.pacingRetryAfter = 30;
  await page.getByLabel('Write a WhatsApp message').fill('This one is paced');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/try again in about 30 seconds/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('NOT delivered').first()).toBeVisible();
  fake.pacingRetryAfter = null;
});

test('the banner says so when the phone is no longer linked, and nothing is sent', async ({ page, request }) => {
  fake.status = 'disconnected';
  await api(request, 'get', '/api/whatsapp-business/openwa/health?fresh=1');
  await openChat(page);
  await expect(page.getByRole('alert').filter({ hasText: /disconnected|not connected/i })).toBeVisible({ timeout: 30_000 });
  const before = fake.sends.length;
  // Since 29 October 2026 the box is shut with the reason instead of letting a
  // paragraph be typed and then refused, so nothing can be sent at all.
  try {
    const box = page.getByLabel('Write a WhatsApp message');
    await expect(box).toBeDisabled();
    await expect(box).toHaveAttribute('placeholder', /not connected right now/i);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    expect(fake.sends).toHaveLength(before);
  } finally {
    // Always put the fake back, or the next test meets a phone that is "unlinked".
    fake.status = 'ready';
    await api(request, 'get', '/api/whatsapp-business/openwa/health?fresh=1');
  }
});

test('on a phone, and with the dark theme classes on, the panel fits the screen and the composer is reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/leads');
  // On a phone the queue fills the screen; tapping a card opens the record.
  const card = page.getByTestId('queue-card').filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator('button').first().click();
  // At phone width the less-used tabs sit behind "More".
  await page.getByTestId('record-menu-more').click();
  await page.getByRole('button').filter({ has: page.locator('span.truncate', { hasText: /^WhatsApp$/ }) }).first().click();
  // The CRM ships light-only today, but every class here carries a dark twin;
  // switching the class on proves the twins keep text readable.
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(page.getByLabel('Write a WhatsApp message')).toBeVisible({ timeout: 30_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'the page scrolls sideways on a phone').toBeLessThanOrEqual(1);
  await page.screenshot({ path: process.env.OPENWA_SHOT ?? 'test-results/openwa-mobile-dark.png' });
});

test('a stranger lands in Unmatched numbers, and one click makes them a contact', async ({ page }) => {
  await fake.deliver(WEBHOOK, SECRET, 'message.received', inboundMessage({
    phone: `91${stranger}`, id: `E2E${Date.now()}S`, body: 'Saw your ad, what is the price?', contact: { pushName: 'Meera Kapoor' },
  }));
  await page.goto('/whatsapp/chats');
  // The filter is a native dropdown.
  await page.locator('select').filter({ has: page.locator('option[value="unmatched"]') }).selectOption('unmatched');
  await page.getByText('Saw your ad, what is the price?').first().click();
  await page.getByRole('button', { name: 'Create contact from this chat' }).click();
  await expect(page.getByText(/Contact created from this chat/i)).toBeVisible({ timeout: 20_000 });
});
