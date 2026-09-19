/**
 * Sending one template to many people, and the screen that makes the number
 * unmissable first.
 *
 * On 13 and 16 September a daily workflow whose conditions had emptied itself
 * queued 40,515 WhatsApp messages to 20,209 people in this CRM. Nobody
 * received one only because no provider was connected — luck, not a safeguard.
 * So the rule this spec exists for is: **nothing sends on a click.** You are
 * shown how many people an audience is, and only then is there a button, and
 * it carries that number.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1400, height: 950 } });

/**
 * Switch a provider on the way an admin does, and off again afterwards.
 *
 * Active is not enough: the screen asks whether the provider is *configured*,
 * so a card switched on with nothing in it still reads as not connected —
 * which is the right answer and is what the second test below checks. So this
 * fills in the two fields `conf()` needs, and empties them at the end.
 */
async function provider(page: import('@playwright/test').Page, on: boolean): Promise<void> {
  await page.evaluate(async (active) => {
    const token = localStorage.getItem('ipropy.token');
    await fetch('/api/admin/integrations/whatsapp_whatsmarketing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        isActive: active,
        config: { phoneNumberId: active ? 'e2e' : '' },
        credentials: { apiToken: active ? 'e2e-not-a-real-token' : '' },
      }),
    });
  }, on);
}

test('a campaign cannot be sent before the number has been read', async ({ page }) => {
  await page.goto('/admin/campaigns');
  await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible({ timeout: 30_000 });
  await provider(page, true);
  await page.reload();

  try {
    await page.getByRole('button', { name: 'New campaign' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    /*
      The whole point: there is no Send button at all yet. Not disabled —
      absent, because there is no number for it to carry.
    */
    await expect(dialog.getByRole('button', { name: /^Send to/ })).toHaveCount(0);

    await dialog.getByPlaceholder('Diwali offer, September').fill('E2E campaign');
    await expect(dialog.getByRole('button', { name: 'Who would get this?' })).toBeVisible();
  } finally {
    await provider(page, false);
  }
});

test('with no provider connected it says so rather than offering a button that fails', async ({ page }) => {
  await page.goto('/admin/campaigns');
  await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible({ timeout: 30_000 });
  await provider(page, false);
  await page.reload();

  await expect(page.getByText(/No WhatsApp provider is switched on/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'New campaign' })).toBeDisabled();
});
