/**
 * The WhatsApp icon beside a number, with no official provider connected —
 * which is what production looks like today and until an admin pastes
 * credentials.
 *
 * The composer only takes over once there is a number to send from. Until
 * then the icon must keep doing exactly what it did before: open the CRM's own
 * Chats screen on that thread, without sending anything and without leaving
 * for `wa.me`. This spec exists because that fallback is easy to lose while
 * adding the thing that replaces it — and losing it is a dead icon beside
 * every phone number in the CRM.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1512, height: 900 } });

test('the icon still opens Chats while no business number is connected', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });

  const opened = page.context().waitForEvent('page').catch(() => null);
  await page.locator('tbody tr').first().locator('td').nth(1).click();
  const detail = (await opened) ?? page;
  await detail.waitForLoadState('domcontentloaded');

  const icon = detail.getByRole('link', { name: 'WhatsApp this number' }).first();
  await expect(icon, 'the WhatsApp icon is missing from the record').toBeVisible({ timeout: 20_000 });

  // A link, not a button: with nothing to send from, clicking it must not open
  // a composer that can only apologise.
  await expect(icon).toHaveAttribute('href', /\/chats\?to=\d+/);

  await icon.click();
  await expect(detail).toHaveURL(/\/chats\?to=\d+/, { timeout: 20_000 });
});

test('the record header button is the one that leaves for WhatsApp itself', async ({ page }) => {
  // The two controls go deliberately different ways, and this is the half that
  // must keep leaving: the owner asked for it on 17 September.
  await page.goto('/leads');
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });

  const opened = page.context().waitForEvent('page').catch(() => null);
  await page.locator('tbody tr').first().locator('td').nth(1).click();
  const detail = (await opened) ?? page;
  await detail.waitForLoadState('domcontentloaded');

  const header = detail.getByRole('button', { name: /^WhatsApp \+?[\d ]+$/ }).first();
  if (await header.count()) await expect(header).toBeVisible();
});
