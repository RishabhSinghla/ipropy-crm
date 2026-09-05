import { expect, test, type Page } from '@playwright/test';
import { unique } from './helpers';

/**
 * The website enquiry form, walked end to end by the people on both ends of it:
 * the team member who builds the form, and the stranger with no account who
 * fills it in.
 *
 * The submission endpoint and the capture pipeline have their own tests; what
 * never existed is the page in between — the admin panel handed out a link
 * that opened raw JSON. These tests pin the page and the whole loop: form
 * built → visitor fills → real lead a rep can call.
 */

/** Shared across the serial tests: the form this run created, and the visitor who used it. */
const run = {
  publicKey: '',
  phone: `9${String(Date.now()).slice(-9)}`,
  visitorName: unique('Website Visitor'),
};

test.describe.serial('public form as a visitor', () => {
  // Every visitor-side test runs with no session at all — the page must work
  // for someone who has never signed in, which is the whole point of it.
  test.use({ storageState: { cookies: [], origins: [] } });

  let adminToken = '';

  async function adminPost(page: Page, path: string, data: unknown): Promise<import('@playwright/test').APIResponse> {
    return page.request.post(path, { headers: { Authorization: `Bearer ${adminToken}` }, data });
  }

  test('the team creates a form and is handed a key', async ({ page }) => {
    const login = await page.request.post('/api/auth/login', {
      data: { identifier: 'admin@ipropy.com', password: 'Admin@123' },
    });
    expect(login.status()).toBe(200);
    adminToken = ((await login.json()) as { token: string }).token;

    const made = await adminPost(page, '/api/webforms', {
      name: unique('E2E enquiry form'),
      module: 'leads',
      fields: [
        { name: 'first_name', label: 'Full Name', type: 'text', required: true },
        { name: 'mobile', label: 'Phone', type: 'tel', required: true },
        { name: 'message', label: 'Message', type: 'textarea' },
      ],
      successMessage: 'Thanks! We will call you very soon.',
    });
    expect(made.status()).toBe(201);
    run.publicKey = ((await made.json()) as { publicKey: string }).publicKey;
    expect(run.publicKey).toBeTruthy();
  });

  test('the form opens for someone with no account', async ({ page }) => {
    await page.goto(`/f/${run.publicKey}`);
    await expect(page.getByRole('heading', { name: /e2e enquiry form/i })).toBeVisible();
    await expect(page.getByLabel('Full Name')).toBeVisible();
    await expect(page.getByLabel('Phone')).toBeVisible();
    await expect(page.getByLabel('Message')).toBeVisible();
    // A phone field types as a phone field — the numeric keypad on a mobile.
    await expect(page.getByLabel('Phone')).toHaveAttribute('type', 'tel');
  });

  test('an empty submit is stopped at the door', async ({ page }) => {
    await page.goto(`/f/${run.publicKey}`);
    await page.getByRole('button', { name: 'Submit' }).click();
    // HTML5 validation holds the visitor on the form; the browser explains
    // what is missing rather than the CRM silently making a junk lead.
    const message = await page.getByLabel('Full Name').evaluate((el) => (el as HTMLInputElement).validationMessage);
    expect(message).not.toBe('');
    await expect(page.getByText(/thanks/i)).toHaveCount(0);
  });

  test('a filled form is thanked and becomes a lead', async ({ page }) => {
    await page.goto(`/f/${run.publicKey}`);
    await page.getByLabel('Full Name').fill(run.visitorName);
    await page.getByLabel('Phone').fill(run.phone);
    await page.getByLabel('Message').fill('Interested in a 3 BHK in Powai, budget around 3 Cr.');
    await page.getByRole('button', { name: 'Submit' }).click();

    await expect(page.getByText('Thanks! We will call you very soon.')).toBeVisible({ timeout: 15_000 });
  });

  test('a made-up link gets one plain message', async ({ page }) => {
    await page.goto('/f/ipf_does-not-exist');
    await expect(page.getByText('This form is no longer available')).toBeVisible();
  });
});

test.describe('public form becomes a lead', () => {
  test('the enquiry is on the rep\'s list with the visitor\'s name', async ({ page }) => {
    await page.goto('/leads');
    await page.getByPlaceholder(/search leads/i).fill(run.phone);
    await page.waitForTimeout(1200);
    await expect(
      page.locator('tbody tr:visible').filter({ hasText: run.visitorName }),
      'a website enquiry must arrive as a real, callable lead',
    ).toBeVisible();
  });
});
