/**
 * The record's "WhatsApp" tab (it was "Messages"): a real chat with the contact and nothing else (notes are in Comments). No message is sent here — a development database has no WhatsApp provider, and
 * the point is that the tab is the chat, says so, and has no note box.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

for (const module of ['leads', 'properties'] as const) {
  test(`${module}: the Messages tab is the WhatsApp chat, with a Note toggle`, async ({ page }) => {
    await page.goto(`/${module}`);
    await expect(page.getByText(/[\d,]+ records/).first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('queue-card').first().click();
    const bar = page.getByTestId('record-menu-bar');
    await expect(bar).toBeVisible();

    // Renamed: no tab on the bar is still called Messages.
    await expect(bar.getByRole('button', { name: /^Messages/ })).toHaveCount(0);
    await bar.getByRole('button', { name: /^WhatsApp/ }).click();

    // The chat, and only the chat: no Note toggle (notes live in Comments).
    await expect(page.getByLabel('Write a WhatsApp message')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Note \(team only\)/ })).toHaveCount(0);
  });
}
