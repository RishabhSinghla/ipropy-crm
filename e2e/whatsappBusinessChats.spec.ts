/**
 * The Chats screen with no provider connected, which is what everybody sees
 * until an admin pastes credentials.
 *
 * Worth a browser because the honest empty state is the feature: a screen that
 * renders an empty inbox when WhatsApp is not connected teaches people the CRM
 * is broken. It has to say what is missing and who fixes it.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1512, height: 900 } });

test('Chats says what is missing rather than showing an empty inbox', async ({ page }) => {
  await page.goto('/chats');
  // Either route may answer: with no official provider and no linked phone,
  // both say the same kind of thing — what to do next, and where.
  await expect(
    page.getByText(/WhatsApp Business is not connected yet|Link your WhatsApp first/),
  ).toBeVisible({ timeout: 30_000 });
});

test('the contact keeps its WhatsApp tab, connected or not', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });

  const opened = page.context().waitForEvent('page').catch(() => null);
  await page.locator('tbody tr').first().locator('td').nth(1).click();
  const detail = (await opened) ?? page;
  await detail.waitForLoadState('domcontentloaded');

  /*
    The record's tabs are buttons, not ARIA tabs — `getByRole('tab')` finds
    nothing here and the failure reads as "the tab is gone" rather than "the
    locator was wrong". Named exactly, so a second WhatsApp control on the page
    (the header button) cannot be the thing that gets clicked.
  */
  await detail.getByRole('button', { name: 'WhatsApp', exact: true }).last().click();

  // A real panel either way: a thread when there is one, and a sentence naming
  // the way to send when there is not.
  await expect(detail.getByText(/No WhatsApp yet|business number|My Profile/i).first())
    .toBeVisible({ timeout: 20_000 });
});
