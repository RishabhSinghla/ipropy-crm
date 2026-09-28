/**
 * A stored payload can actually be read.
 *
 * Admin → Integrations → Lead inbox has always said "every payload is stored
 * before processing", and until 28 September 2026 there was no way to see one
 * — which made the promise unverifiable on exactly the morning a lead source
 * starts failing silently.
 *
 * It creates its own delivery through the Truecaller listening door rather
 * than looking for whatever is already in the inbox: a spec that depends on
 * what is already in the database reports the machine it ran on.
 */
import { test, expect } from '@playwright/test';

const marker = `browser-check-${Date.now()}`;

test('a lead inbox row shows exactly what arrived, minus the credentials', async ({ page, request }) => {
  await request.post('/api/webhooks/truecaller', {
    headers: {
      'x-truecaller-signature': `signature-${marker}`,
      authorization: 'Bearer must-not-be-stored',
    },
    data: { requestId: marker, status: 'verified', phoneNumber: '919812345678' },
  });

  await page.goto('/admin/integrations');
  await page.getByRole('button', { name: /Lead inbox/i }).click();
  await expect(page.getByText('Raw inbound leads')).toBeVisible({ timeout: 20_000 });

  // The door answers 200 before it writes, so the row can lag the response.
  const row = page.locator('tr', { hasText: 'truecaller' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });

  await row.getByRole('button', { name: 'Show' }).click();

  await expect(page.getByText(marker).first()).toBeVisible();
  await expect(page.getByText(`signature-${marker}`)).toBeVisible();
  // The one header that is only ever a secret never reaches the screen.
  await expect(page.getByText('must-not-be-stored')).toHaveCount(0);
});
