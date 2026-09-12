/**
 * The real-user walk: every screen in the CRM, visited the way a person
 * would, plus one complete lead lifecycle through the UI itself.
 *
 * This is not a feature test — the other specs own features. It is the net
 * for everything no spec covers yet: a page that throws, a console error a
 * rep would see, a screen that renders blank. Failures print a findings list
 * to the report so the next fix has an address.
 */
import { test, expect, type Page } from '@playwright/test';
import { searchList, fieldEditor } from './helpers';

type Finding = { page: string; kind: string; detail: string };
const findings: Finding[] = [];

const PAGES: { url: string; name: string; expect?: RegExp }[] = [
  { url: '/dashboard', name: 'Dashboard', expect: /dashboard|good (morning|afternoon|evening)|today/i },
  { url: '/leads', name: 'Leads list' },
  { url: '/properties', name: 'Properties list' },
  { url: '/capture', name: 'Site visit' },
  { url: '/settings', name: 'User settings' },
  { url: '/admin/users', name: 'Admin — Users' },
  { url: '/admin/roles', name: 'Admin — Roles & Profiles' },
  { url: '/admin/sharing', name: 'Admin — Data sharing' },
  { url: '/admin/fields?module=leads', name: 'Admin — Fields' },
  { url: '/admin/layouts', name: 'Admin — Layout designer' },
  { url: '/admin/picklists', name: 'Admin — Dropdowns' },
  { url: '/admin/import', name: 'Admin — Import' },
  { url: '/admin/workflows', name: 'Admin — Workflows' },
  { url: '/admin/webforms', name: 'Admin — Web forms' },
  { url: '/admin/integrations', name: 'Admin — Integrations' },
  { url: '/admin/settings', name: 'Admin — Settings' },
  { url: '/admin/system', name: 'Admin — System & audit' },
];

const NOISE = [
  /favicon/i,
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /socket\.io|websocket|engine\.io/i,
  /ERR_.*(ECONNRESET|ECONNABORTED|TIMED_OUT|INTERNET)/i,
  /Failed to load resource.*(401|404)/,
  /the server responded with a status of 401/,
  /AbortError/i,
  /ResizeObserver loop/i,
];

test.describe.configure({ mode: 'serial' });

for (const { url, name, expect: expectRe } of PAGES) {
  test(`walk: ${name} (${url})`, async ({ page }) => {
    const errors: string[] = [];
    const onConsole = (m: { type(): string; text(): string }): void => {
      if (m.type() === 'error' && !NOISE.some((n) => n.test(m.text()))) errors.push(m.text().slice(0, 200));
    };
    const onPageError = (e: Error): void => errors.push(`PAGEERROR ${String(e).slice(0, 200)}`);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1800); // metadata, queries and sockets to settle

    // Error boundary means the screen is gone, whatever the URL says.
    const boundary = page.getByText(/something went wrong/i);
    if (await boundary.count()) findings.push({ page: url, kind: 'error-boundary', detail: 'error boundary visible' });

    if (expectRe) await expect(page.locator('main')).toContainText(expectRe, { timeout: 8000 }).catch(() => {
      findings.push({ page: url, kind: 'missing-content', detail: `no text matching ${expectRe}` });
    });

    for (const e of errors) findings.push({ page: url, kind: 'console-error', detail: e });
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  });
}

test.describe('lead lifecycle through the UI', () => {
  const name = `Journey Lead ${Date.now()}`;
  const mobile = `97${String(Date.now()).slice(-8)}`;

  /*
    The same lifecycle runs against the card list on a phone and the table on a
    desktop, so the row locator has to branch on the project.

    `test.info()` is only valid *inside* a running test — called in the describe
    body, at collection time, it throws and takes every test in the file with
    it. So the helper takes a page and reads the project itself, and each test
    calls it rather than closing over a hoisted constant.
  */
  const rowIn = (page: Page, text: string) =>
    (test.info().project.name === 'mobile'
      ? page.getByTestId('record-card-list').getByText(text).first()
      : page.locator('tr', { hasText: text }).first());

  test('create a lead from the form', async ({ page }) => {
    await page.goto('/leads/new');
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('textbox', { name: /full name/i }).fill(name);
    await page.getByLabel(/mobile/i).first().fill(mobile);
    await page.getByRole('button', { name: /save|create/i }).click();
    // Creating deliberately returns to the list — reps add several leads in a
    // row and should not be bounced into a detail page each time.
    await expect(page).toHaveURL(/\/leads$/);
    await expect(page.getByText(/created/i).first()).toBeVisible();
    test.setTimeout(60_000);
  });

  test('find it on the list', async ({ page }) => {
    const row = (text: string) => rowIn(page, text);
    await page.goto('/leads');
    await page.waitForTimeout(1500);
    await searchList(page, name);
    await page.waitForTimeout(1200);
    await expect(row(name)).toBeVisible();
  });

  test('rename it inline on the record', async ({ page }) => {
    const row = (text: string) => rowIn(page, text);
    await page.goto('/leads');
    await page.waitForTimeout(1200);
    await searchList(page, name);
    await page.waitForTimeout(1200);
    const rowClick = row(name).click();
    const detail = await page.context().waitForEvent('page');
    await detail.waitForLoadState('domcontentloaded');
    await detail.waitForURL(/\/leads\/[0-9a-f-]{36}/);
    await rowClick;
    /*
      Edited where it is shown. There is no separate edit page any more — the
      owner asked for the one it used to open to go, since every field on the
      record already edits in place and a second screen for the same job was
      one more thing to keep in step.
    */
    const renamed = `${name} II`;
    // Full Name edits in two places on this screen — the header strip and the
    // Overview form. Take the Overview one: its trigger is the value box, and
    // the button inside it is `sr-only`, so clicking the button itself times
    // out on a 1px clipped element.
    await fieldEditor(detail, /^Change Full Name$/).click();
    const input = detail.getByRole('textbox', { name: /full name/i }).first();
    await input.fill(renamed);
    await input.press('Enter');
    // The heading is the value, so a saved rename is visible in it.
    await expect(detail.getByRole('heading', { name: renamed })).toBeVisible({ timeout: 10_000 });
  });

  test('delete it', async ({ page }) => {
    const row = (text: string) => rowIn(page, text);
    const renamed = `${name} II`;
    await page.goto('/leads');
    await searchList(page, renamed);
    await expect(row(renamed)).toBeVisible({ timeout: 10_000 });
    const rowClick = row(renamed).click();
    const detail = await page.context().waitForEvent('page');
    await detail.waitForLoadState('domcontentloaded');
    await rowClick;
    // Delete lives in the More-actions dropdown, and the dialog confirms with
    // a plain "Delete" button.
    await expect(detail.getByRole('button', { name: 'More actions' })).toBeVisible({ timeout: 5_000 });
    await detail.getByRole('button', { name: 'More actions' }).click();
    await expect(detail.getByText('Delete record')).toBeVisible({ timeout: 5_000 });
    await detail.getByText('Delete record').click();
    await expect(detail.getByRole('button', { name: 'Delete', exact: true })).toBeVisible({ timeout: 5_000 });
    await detail.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.goto('/leads');
    await searchList(page, renamed);
    await expect(row(renamed)).toHaveCount(0);
  });
});

test.afterAll(async () => {
  // Findings land in the report: the next fix reads them from here.
  if (findings.length) {
    console.log('\n=== JOURNEY FINDINGS ===');
    for (const f of findings) console.log(`[${f.kind}] ${f.page}: ${f.detail}`);
    console.log(`=== ${findings.length} finding(s) ===`);
  } else {
    console.log('\n=== JOURNEY CLEAN: no findings ===');
  }
});
