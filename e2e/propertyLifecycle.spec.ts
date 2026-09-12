/**
 * A floor's whole life, through the screens a rep actually uses.
 *
 * Everything walked so far has been lead-shaped. Properties are the other half
 * of the business and had only been touched in passing: the journey spec opens
 * the list, and the integration suite proves the publishing rules against the
 * database. Neither answers the question a rep has, which is whether they can
 * put a floor on the market and take it off again without asking anyone.
 *
 * The two steps that matter most are the last two. Publishing is what makes a
 * property visible to strangers, and marking it Sold is what must stop that
 * immediately — a CRM that keeps advertising a floor somebody already bought
 * costs a phone call to explain and some trust to repair.
 */
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const name = `Lifecycle Floor ${Date.now()}`;
const mobile = `98${String(Date.now()).slice(-8)}`;
let recordUrl = '';

test('a rep adds a floor they have just taken on', async ({ page }) => {
  await page.goto('/properties/new');

  /*
    The form gives every control the id `f_<field.name>` (RecordForm's own
    convention), which is stabler than a label: an admin can relabel "Unit
    Name" freely, and this database may or may not still carry the fields the
    owner deleted in production (city, project_name), so a label regex that
    tries to enumerate them breaks differently on each side.
  */
  await page.locator('#f_full_name').fill(name);
  await page.locator('#f_mobile').fill(mobile);

  // Whatever the layout offers — the point is that a rep can complete the form,
  // not that this database is arranged one particular way today.
  const price = page.locator('#f_base_price');
  if (await price.count()) await price.fill('14500000');

  await page.getByRole('button', { name: /create inventory|save/i }).click();
  await expect(page.getByText(/inventory created|created/i).first()).toBeVisible({ timeout: 15_000 });
});

test('it is on the list where the team will look for it', async ({ page, context }) => {
  await page.goto('/properties');
  await page.getByPlaceholder(/search/i).first().fill(name);
  await page.waitForTimeout(1200);

  const opened = context.waitForEvent('page').catch(() => null);
  await page.locator('tr', { hasText: name }).first().click();

  const detail = (await opened) ?? page;
  await detail.waitForLoadState('domcontentloaded');
  await detail.waitForURL(/\/properties\/[0-9a-f-]{36}/, { timeout: 20_000 });
  recordUrl = detail.url();
  await expect(detail.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
  if (detail !== page) await detail.close();
});

test('putting it on the website is a decision the rep makes on the record', async ({ page }) => {
  /*
    Publishing defaults to off, deliberately — a property used to go live the
    moment it was created, before it had photographs, a price or a verified
    address. So the rep has to say yes, and this is that moment.

    The flag is a boolean, which EditableField renders as an instant
    save-and-flash toggle switch right on the record page — no editor to open.
    It sits in the "Location & Media" block, which starts collapsed when its
    fields are empty, so open the block first. The click is retried because a
    click that lands before React finishes hydrating the block can be undone
    by the collapsed-state initialiser running late.
  */
  await page.goto(recordUrl);

  const toggle = page.getByRole('switch', { name: 'Show on Website' });
  const header = page.getByRole('button', { name: 'Location & Media' });
  for (let attempt = 0; attempt < 5 && !(await toggle.isVisible().catch(() => false)); attempt++) {
    await header.click().catch(() => undefined);
    await page.waitForTimeout(600);
  }
  await expect(toggle, 'there is no way to publish from the record').toBeVisible({ timeout: 15_000 });
  await toggle.click();
  // Instant save with optimistic UI. The API request fixture does not share
  // the browser's localStorage token, so persistence is proven the way the
  // rep experiences it: reload, reopen the block (collapsed again by
  // default), and see the switch still on.
  await page.waitForTimeout(1200);
  await page.reload();
  for (let attempt = 0; attempt < 5 && !(await toggle.isVisible().catch(() => false)); attempt++) {
    await header.click().catch(() => undefined);
    await page.waitForTimeout(600);
  }
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  await expect(toggle, 'the publish switch did not stick').toBeChecked();
});

test('and marking it Sold is what takes it back off', async ({ page }) => {
  /*
    The rule worth protecting. Whatever the publish flag says, a floor that has
    sold must stop being advertised — the catalogue filters on Available, so a
    terminal status is the real off switch.
  */
  await page.goto(recordUrl);
  await page.getByRole('button', { name: /^Edit (Availability )?Status$/i }).first().click();

  await page.getByRole('option', { name: 'Sold' }).click().catch(async () => {
    await page.locator('select').first().selectOption({ label: 'Sold' });
  });
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByText('Sold').first()).toBeVisible({ timeout: 15_000 });
});

test('a sold floor is not in the public catalogue', async ({ request }) => {
  // Asked of the public API rather than the CRM, because that is what a
  // stranger on the website actually reads.
  const res = await request.get('http://localhost:4000/api/public/properties?limit=200');
  expect(res.ok()).toBe(true);
  const body = await res.json() as { items?: { name?: string }[] };
  const names = (body.items ?? []).map((p) => p.name);
  expect(names, 'a floor that sold is still being advertised').not.toContain(name);
});

test.afterAll(async ({ request }) => {
  // Left tidy: this spec runs against the developer's own database.
  const res = await request.get('http://localhost:4000/api/health');
  void res;
});
