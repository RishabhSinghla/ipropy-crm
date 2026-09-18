/**
 * The WhatsApp Templates admin screen.
 *
 * The mapping itself is proved against a real database; what needs a browser
 * is that the page is reachable, says the truth when no provider is connected,
 * and does not pretend a template list exists when there is none.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1512, height: 900 } });

test('the templates screen is reachable and honest about the provider', async ({ page }) => {
  await page.goto('/admin/whatsapp-templates');
  await expect(page.getByRole('heading', { name: 'WhatsApp Templates' })).toBeVisible({ timeout: 30_000 });

  // No provider on this database, so it says so — and still offers the page,
  // because a mapping can be prepared before the provider is connected.
  await expect(page.getByText(/No WhatsApp Business provider is switched on/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /sync from provider/i })).toBeVisible();

  /*
    This database still holds the templates seeded before WhatsApp was removed
    last year, and they show — which is the right answer: their wording is
    still there to map. Either state is legitimate, so the assertion is that
    the page says which one it is rather than showing nothing at all.
  */
  await expect(
    page.getByText(/No templates yet/i).or(page.getByText(/\{\{1\}\}/).first()),
  ).toBeVisible({ timeout: 20_000 });
});
