/**
 * "Verify with Truecaller" on a public enquiry form.
 *
 * Two promises, and the second is the one that protects what is live today:
 * the control appears when an admin has switched the card on, and **nothing
 * changes at all** when nobody has. The same rule the WhatsApp composer
 * follows, for the same reason — the fallback is what production is running
 * and it is the easy thing to lose while adding the thing that replaces it.
 *
 * It builds its own form through the API rather than looking for one that
 * happens to exist: a spec that depends on what is already in the database
 * reports the machine it ran on.
 *
 * What cannot be driven from here is the verified path itself. That needs
 * Truecaller's own servers to post a callback and a real profile to be fetched
 * from `*.truecaller.com`, which this container cannot reach — so the round
 * trip is proved against a real database in
 * `tests/integration/truecallerVerification.test.ts` instead, and the last
 * mile needs a phone.
 */
import { test, expect, type Page } from '@playwright/test';

const marker = `tc-form-${Date.now()}`;

/** The token is a bare string under this key — see CLAUDE.md; the obvious guess is wrong. */
async function asAdmin<T>(page: Page, path: string, method: string, body?: unknown): Promise<T> {
  return page.evaluate(async ({ path, method, body }) => {
    const token = localStorage.getItem('ipropy.token');
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
    return res.json();
  }, { path, method, body }) as Promise<T>;
}

async function makeForm(page: Page): Promise<string> {
  const created = await asAdmin<{ publicKey: string }>(page, '/api/webforms', 'POST', {
    name: marker,
    fields: [
      { name: 'first_name', label: 'Your name', required: true },
      { name: 'mobile', label: 'Mobile', required: true },
      { name: 'message', label: 'Message' },
    ],
  });
  return created.publicKey;
}

async function switchTruecaller(page: Page, on: boolean): Promise<void> {
  await asAdmin(page, '/api/admin/integrations/truecaller', 'PUT', {
    isActive: on,
    config: { appKey: 'e2e-app-key', partnerName: 'iPropy' },
  });
}

test.describe('the enquiry form', () => {
  test('offers nothing extra while the card is switched off', async ({ page }) => {
    await page.goto('/');
    await switchTruecaller(page, false);
    const publicKey = await makeForm(page);

    await page.goto(`/f/${publicKey}`);
    await expect(page.getByRole('heading', { name: marker })).toBeVisible({ timeout: 20_000 });

    // The form works exactly as it does on production today.
    await expect(page.getByRole('button', { name: /Verify with Truecaller/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  });

  test('offers the button once an admin switches it on', async ({ page }) => {
    await page.goto('/');
    await switchTruecaller(page, true);
    const publicKey = await makeForm(page);

    try {
      await page.goto(`/f/${publicKey}`);
      const verify = page.getByRole('button', { name: /Verify with Truecaller/i });
      await expect(verify).toBeVisible({ timeout: 20_000 });

      // Pressing it asks our own server for a nonce before anything else.
      const started = page.waitForResponse((r) =>
        r.url().includes('/api/public/truecaller/start') && r.request().method() === 'POST');
      await verify.click();
      expect((await started).status()).toBe(200);

      // On a desktop browser Truecaller cannot answer, and the form says so
      // rather than leaving somebody on a spinner for ever.
      await expect(page.getByText(/Please fill the form in below/i)).toBeVisible({ timeout: 90_000 });
      await expect(page.getByRole('button', { name: 'Submit' })).toBeEnabled();
    } finally {
      await page.goto('/');
      await switchTruecaller(page, false);
    }
  });
});
