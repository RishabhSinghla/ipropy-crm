import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Where auth.setup.ts stashes the signed-in session for the other specs.
 * A plain relative path, not import.meta: Playwright compiles config and
 * specs to CJS, where import.meta is unavailable.
 */
export const STORAGE_STATE = 'e2e/.auth/user.json';

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
  // The field accepts an email *or* a mobile number since sign-in by phone
  // shipped, and its label says so — an exact match on 'Email' silently stopped
  // matching anything and took the whole suite down with it.
  await page.getByLabel('Email or mobile number', { exact: true }).fill(ADMIN_EMAIL);
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
  // Waits for a record, not for an edit affordance. It used to wait for an
  // inline-edit trigger, which meant every test using it started failing the day
  // inline editing was switched off by default — reported as "the list view has
  // accessibility violations", which it did not. Wait for the thing the name
  // says.
  const row = page.locator('tbody tr:visible, [data-record-card]:visible').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
}

/**
 * Is editing straight from a list switched on?
 *
 * It ships off — too easy to change a live record with a stray click — so the
 * tests that exercise it have to ask rather than assume. Read from the same
 * place the app reads it.
 */
export async function inlineEditOn(page: Page): Promise<boolean> {
  const res = await page.request.get('/api/auth/me');
  if (!res.ok()) return false;
  const me = await res.json() as { ui?: { inlineEdit?: boolean } };
  return me.ui?.inlineEdit === true;
}

/**
 * Which column is this, by its header?
 *
 * List columns are metadata an administrator can reorder or remove, so a
 * hardcoded `td.nth(6)` asserts on a layout decision rather than on behaviour —
 * and fails as a mystery the day someone rearranges a view.
 */
export async function columnIndex(page: Page, header: string): Promise<number> {
  const headers = page.locator('thead th');
  await expect(headers.first()).toBeVisible({ timeout: 30_000 });
  const labels = await headers.allTextContents();
  const index = labels.findIndex((t) => t.trim().toLowerCase() === header.toLowerCase());
  expect(index, `no "${header}" column — found: ${labels.map((l) => l.trim()).join(', ')}`)
    .toBeGreaterThan(-1);
  return index;
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

/**
 * Fill every field the form says is required, whatever they turn out to be.
 *
 * The same reasoning as `columnIndex` above, applied to forms. Which fields are
 * mandatory is metadata an administrator changes from the admin panel, and this
 * one changes more often than most: it is the first thing anybody tightens once
 * real leads start arriving. A test that fills the three fields that were
 * required the day it was written starts failing the day somebody adds a
 * fourth, and reports it as "creating a lead is broken" when creating a lead is
 * working exactly as configured.
 *
 * Required controls are found by the asterisk the form puts on their label, and
 * filled by what kind of control they are. Anything already holding a value is
 * left alone, so a caller can set the fields it cares about first and hand the
 * rest to this.
 */
export async function fillRequiredFields(scope: Locator | Page): Promise<void> {
  // By accessible role and name, not by an `aria-label` attribute. The form
  // labels its controls with real <label> elements, so the name a person (and
  // Playwright) sees is computed from the label, and an attribute selector
  // matches none of them.
  for (const role of ['combobox', 'textbox'] as const) {
    const controls = scope.getByRole(role, { name: /\*$/ });
    const count = await controls.count();

    for (let i = 0; i < count; i += 1) {
      const control = controls.nth(i);
      // eslint-disable-next-line no-await-in-loop
      const [name, value] = await Promise.all([
        control.getAttribute('aria-label').then((a) => a ?? ''),
        control.inputValue().catch(() => ''),
      ]);
      if (value) continue;

      // eslint-disable-next-line no-await-in-loop
      const label = (name || (await control.evaluate((el) => {
        const id = el.getAttribute('id');
        const byFor = id ? document.querySelector(`label[for="${id}"]`) : null;
        return (byFor ?? el.closest('label'))?.textContent ?? '';
      }))).toLowerCase();

      if (role === 'combobox') {
        // Index 1: index 0 is the empty "choose one" option.
        // eslint-disable-next-line no-await-in-loop
        await control.selectOption({ index: 1 }).catch(() => undefined);
        continue;
      }

      // Text inputs need something the field will accept. Mobile is the one
      // that bites: ten digits, no country code, and a repeated value trips the
      // duplicate check on the second run rather than the first.
      let filler = unique('E2E');
      if (/mobile|phone/.test(label)) filler = `9${String(Date.now()).slice(-9)}`;
      else if (/email/.test(label)) filler = `${unique('e2e').toLowerCase()}@example.com`;
      else if (/amount|budget|price|area|score/.test(label)) filler = '100';
      // eslint-disable-next-line no-await-in-loop
      await control.fill(filler).catch(() => undefined);
    }
  }
}

/**
 * Open a tab on a record by name.
 *
 * Which tab a record opens on is a Layout Designer setting, so landing on the
 * one a test wants is luck rather than behaviour. Asking for it by name is the
 * same reasoning as `columnIndex` and `fillRequiredFields`: assert on what the
 * app does, never on how this particular database happens to be configured.
 */
export async function openRecordTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('button', { name, exact: true }).first();
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
}
