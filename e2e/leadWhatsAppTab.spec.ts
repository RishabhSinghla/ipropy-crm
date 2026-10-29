/**
 * The record's "WhatsApp" tab (it was "Messages"): a real chat with the contact, with a Note toggle so writing a
 * note for the team is one tap away. No message is sent here — a development database has no WhatsApp provider, and
 * the point is that the tab is the chat, says so, and keeps notes reachable.
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

    // The two modes: the chat (default) and a team-only note.
    const modes = page.getByRole('tablist', { name: /Write to the customer, or a note for the team/ });
    await expect(modes.getByRole('tab', { name: 'WhatsApp message' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Write a WhatsApp message')).toBeVisible();

    await modes.getByRole('tab', { name: /Note \(team only\)/ }).click();
    await expect(page.getByTestId('activity-feed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Write a note…', exact: true })).toBeVisible();

    // And back: nothing was lost by looking at the note.
    await modes.getByRole('tab', { name: 'WhatsApp message' }).click();
    await expect(page.getByLabel('Write a WhatsApp message')).toBeVisible();
  });
}
