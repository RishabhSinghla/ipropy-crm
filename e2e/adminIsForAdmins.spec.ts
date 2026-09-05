/**
 * The admin area, seen by somebody who does not administer anything.
 *
 * The sidebar link was hidden from non-admins and the route behind it was not.
 * So a Sales Executive who typed `/admin/users`, or followed a link a colleague
 * pasted, was handed the whole control panel: Modules & Fields, Layout Designer,
 * Dropdowns, Roles & Profiles, Data Sharing, Workflows, Integrations, Settings,
 * and a "New user" button. Every one of those controls answers 403 when pressed.
 *
 * The server was never fooled and no data leaked. The person was fooled, which
 * in a CRM their team has to trust is its own kind of damage: a screen full of
 * things that break is indistinguishable from a broken product.
 *
 * Gated per section on the capability that opens it, not on `isAdmin`, because
 * the answer is not binary — a Sales Manager holds `records.import` and no admin
 * capability at all, and Import Data lives in here.
 */
import { expect, test } from '@playwright/test';

// A fresh context each time: the stored admin session must not leak in.
test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/');
  await page.getByRole('textbox', { name: /you@ipropy|email or mobile/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).fill('Admin@123');
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.getByRole('link', { name: /dashboard/i }).first()).toBeVisible({ timeout: 20_000 });
}

test('a rep who types the admin address is told plainly there is nothing there', async ({ page }) => {
  await signIn(page, 'aisha.khan@ipropy.com');
  await page.goto('/admin/users');

  await expect(page.getByText(/this is the admin area/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: /back to the dashboard/i })).toBeVisible();
});

test('and is not handed controls that would refuse them', async ({ page }) => {
  await signIn(page, 'aisha.khan@ipropy.com');
  await page.goto('/admin/users');

  // The specific things that used to be on screen.
  for (const label of ['New user', 'Modules & Fields', 'Roles & Profiles', 'Integrations', 'Dropdowns']) {
    await expect(
      page.getByRole('button', { name: label }).or(page.getByRole('link', { name: label })),
      `a rep should not be offered "${label}"`,
    ).toHaveCount(0);
  }
});

test('the sidebar still does not offer them Admin at all', async ({ page }) => {
  await signIn(page, 'aisha.khan@ipropy.com');
  await expect(page.getByRole('link', { name: /^admin$/i })).toHaveCount(0);
});

test('an admin still gets the whole panel', async ({ page }) => {
  /*
    The half that matters most. Gating this too hard would take the CRM's
    settings away from the only person who is supposed to have them, and that
    failure would be far worse than the one being fixed.
  */
  await signIn(page, 'admin@ipropy.com');
  await page.goto('/admin/users');

  await expect(page.getByRole('heading', { name: /^users$/i })).toBeVisible({ timeout: 15_000 });
  for (const label of ['Modules & Fields', 'Roles & Profiles', 'Integrations', 'Dropdowns', 'Workflows']) {
    await expect(
      page.getByRole('link', { name: label }),
      `an admin must still reach ${label}`,
    ).toHaveCount(1);
  }
});
