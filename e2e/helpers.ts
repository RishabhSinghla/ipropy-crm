import { expect, type Page } from '@playwright/test';

/**
 * Credentials come from the environment so this works against a deployed
 * instance too, falling back to the seeded dev defaults locally.
 */
export const ADMIN_EMAIL = process.env.E2E_EMAIL ?? 'admin@ipropy.com';
export const ADMIN_PASSWORD = process.env.E2E_PASSWORD ?? 'Admin@123';

/**
 * Log in through the real form rather than injecting a token: the login screen
 * is itself a critical path, and a token shortcut would skip the bootstrap
 * that populates modules and permissions in the client store.
 */
export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(ADMIN_EMAIL);
  // Exact, because the show/hide toggle carries aria-label="Show password" and
  // a loose /password/i matches both, which Playwright rejects as ambiguous.
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The dashboard is the post-login landing route; waiting for the URL rather
  // than a spinner keeps this robust to loading-state changes.
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

/** A value unique to this run, so specs never collide with each other or with seed data. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

/**
 * Wait for the record list to have finished loading. The table and the mobile
 * card list both render rows only once the query resolves, so this is the
 * shared "page is ready" signal.
 */
export async function waitForRecords(page: Page): Promise<void> {
  await expect(editableCells(page).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Inline-edit triggers, located by their title attribute rather than by
 * accessible name: the button's name is its *value* ("New", "Aisha Khan"),
 * because it wraps the rendered field. The title is the stable part.
 */
export function editableCells(page: Page) {
  // `:visible` matters: ListView renders BOTH a mobile card list (md:hidden)
  // and a desktop table (hidden md:table), so the DOM always contains two sets
  // of triggers and only one is displayed at any viewport. Without this the
  // first match is a display:none card button that can never be clicked.
  return page.locator('button[title="Click to edit"]:visible');
}
