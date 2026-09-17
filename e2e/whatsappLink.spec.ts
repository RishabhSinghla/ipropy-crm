/**
 * Linking a WhatsApp number, and the screen that does it.
 *
 * Deliberately stops short of scanning: a real link opens a socket to WhatsApp
 * from wherever this runs, and a test suite must not be doing that on somebody's
 * account. What is asserted is everything around it — the states, the wording,
 * and that Chats says what to do rather than showing an empty room.
 */
import { test, expect } from '@playwright/test';
import { waitForShell } from './helpers';

test('My Profile offers linking, and says when nothing is linked', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'WhatsApp' }).click();

  await expect(page.getByText('My WhatsApp')).toBeVisible();
  await expect(page.getByText(/Not linked|Connected|reconnect required/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Link WhatsApp|Reconnect WhatsApp/ })).toBeVisible();

  // The promise that matters to somebody deciding whether to link at all.
  await expect(page.getByText(/only you can use this link/i)).toBeVisible();
});

test('Chats sends you to link first, instead of showing an empty room', async ({ page }) => {
  await page.goto('/chats');
  const linked = await page.getByText('Pick a conversation').count();
  if (linked) test.skip(true, 'this account already has WhatsApp linked');

  await expect(page.getByText('Link your WhatsApp first')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: 'Open My Profile' }).click();
  await expect(page).toHaveURL(/\/settings/);
});

test('Chats is reachable from the header', async ({ page }) => {
  await page.goto('/dashboard');
  await waitForShell(page);
  await page.getByRole('button', { name: 'Switch module' }).click();
  await page.getByRole('link', { name: /Chats/ }).click();
  await expect(page).toHaveURL(/\/chats/);
});
