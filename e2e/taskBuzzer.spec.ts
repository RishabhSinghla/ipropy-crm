/**
 * The today-task buzzer, in a real browser.
 *
 * **9 October 2026, the owner:** every lead due today pops up with a buzzer,
 * first to last, round after round, so the team cannot ignore it.
 *
 * What only a browser can prove: the popup opens over the page on its own, a
 * buzzer starts with it, Next walks the list, and moving the date reads as done.
 */
import { expect, test } from '@playwright/test';

const API = 'http://localhost:4000';
const MARK = `BuzzWalk${Date.now()}`;
const made: string[] = [];
let token = '';

/** "Today" as the server counts it — the organisation's timezone, which the seed sets to India. */
function serverToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${API}/api/auth/login`, {
    data: { email: process.env.E2E_EMAIL ?? 'admin@ipropy.com', password: process.env.E2E_PASSWORD ?? 'Admin@123' },
  });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).token;
  const me = await (await request.get(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  for (let i = 0; i < 2; i += 1) {
    const lead = await request.post(`${API}/api/records/leads`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        full_name: `${MARK} ${i}`, mobile: `96${String(Date.now()).slice(-7)}${i}`, country_code: '91',
        status: 'New', next_followup_at: serverToday(), owner_id: me.id,
      },
    });
    expect(lead.ok(), await lead.text()).toBeTruthy();
    made.push((await lead.json()).id);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of made) {
    await request.delete(`${API}/api/records/leads/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  }
});

test('pops today\'s tasks up with a buzzer, walks them with Next, and counts a moved date as done', async ({ page }) => {
  await page.addInitScript(() => {
    const counter = window as unknown as { buzzes: number };
    counter.buzzes = 0;
    const original = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function createOscillator(this: AudioContext) {
      counter.buzzes += 1;
      return original.call(this);
    };
  });
  await page.goto('/dashboard');
  // The saved session puts today's round off (auth.setup.ts). Bring it forward to now.
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('ipropy.taskBuzzer.')));
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('ipropy.taskBuzzer.')) localStorage.setItem(key, JSON.stringify({ shown: [], nextAt: 0 }));
    }
  });

  const popup = page.getByTestId('task-buzzer');
  await expect(popup).toBeVisible({ timeout: 40_000 });
  await expect(popup).toContainText(/Task due today · 1 of \d+/i);
  await expect.poll(() => page.evaluate(() => (window as unknown as { buzzes: number }).buzzes)).toBeGreaterThan(0);

  // Walk to one of ours.
  for (let i = 0; i < 500; i += 1) {
    if ((await popup.innerText()).includes(MARK)) break;
    await page.getByTestId('task-buzzer-next').click();
  }
  await expect(popup).toContainText(MARK);

  // Move its date: the popup says so and moves on.
  await popup.getByText(/^(today|tomorrow)/i).first().click();
  await page.getByRole('button', { name: /^Next Week$/ }).first().click();
  await expect(page.getByText('Done — date moved')).toBeVisible({ timeout: 10_000 });
});

test('Skip all dismisses reminders for three hours and survives reload', async ({ page }) => {
  await page.goto('/dashboard');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('ipropy.taskBuzzer.')) localStorage.setItem(key, JSON.stringify({ shown: [], nextAt: 0 }));
    }
  });
  await expect(page.getByTestId('task-buzzer')).toBeVisible({ timeout: 40_000 });
  const before = Date.now();
  await page.getByTestId('task-buzzer-skip').click();
  await expect(page.getByTestId('task-buzzer')).toBeHidden();
  const until = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('ipropy.taskBuzzer.skip.'));
    return Number(key && localStorage.getItem(key));
  });
  expect(until - before).toBeGreaterThanOrEqual(3 * 60 * 60_000);
  expect(until - before).toBeLessThan(3 * 60 * 60_000 + 5000);
  await page.reload();
  await page.waitForTimeout(16_000);
  await expect(page.getByTestId('task-buzzer')).toBeHidden();
});
