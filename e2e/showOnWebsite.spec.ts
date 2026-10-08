/**
 * "Show on website" — the tick that puts an inventory on the property portal.
 *
 * **1 October 2026, the owner:** only the properties staff tick go public, and
 * the seller never appears there. The tick is the `publish_to_web` field, which
 * production keeps hidden from forms, so this menu item is the only way to set
 * it. The spec proves the whole round trip a person makes: tick it in the CRM,
 * the portal's feed has it; untick it, the portal answers 404.
 */
import { expect, test } from '@playwright/test';
import { openDetailsPane, unique } from './helpers';

test.use({ viewport: { width: 1600, height: 900 } });

/** A fresh property with a seller's name only this run has; returns its id. */
async function newProperty(page: import('@playwright/test').Page, seller: string): Promise<string> {
  await page.goto('/properties');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 40_000 });
  const created = await page.evaluate(async (name) => {
    const token = localStorage.getItem('ipropy.token');
    const res = await fetch('/api/records/properties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ full_name: name, mobile: `9${String(Date.now()).slice(-9)}`, status: 'Available' }),
    });
    return { status: res.status, id: ((await res.json()) as { id: string }).id };
  }, seller);
  expect(created.status).toBeLessThan(300);
  return created.id;
}

/** Open the right-hand details pane once it exists — unfolding before it has drawn is a no-op. */
async function showDetails(page: import('@playwright/test').Page): Promise<void> {
  const pane = page.getByTestId('activity-pane');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  await openDetailsPane(page);
  await expect(pane).not.toHaveAttribute('data-folded', 'true');
}

/** What the portal's feed says about one property right now. */
function portal(page: import('@playwright/test').Page, id: string) {
  return page.evaluate(async (rid) => {
    // no-store: the feed is cached for a minute on purpose, and this asks what is true now.
    const res = await fetch(`/api/public/listings/${rid}`, { cache: 'no-store' });
    return { status: res.status, body: await res.text() };
  }, id);
}

test('the switch in the right details pane puts a property on the website and takes it off', async ({ page }) => {
  const seller = unique('Seller');
  const id = await newProperty(page, seller);
  await page.goto(`/properties/${id}`);
  await expect(page.getByRole('heading', { name: seller })).toBeVisible({ timeout: 30_000 });
  await showDetails(page);

  const row = page.getByTestId('website-switch');
  await expect(row).toBeVisible({ timeout: 15_000 });
  const toggle = row.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect((await portal(page, id)).status).toBe(404);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
  await expect(row.getByText('Live')).toBeVisible();
  await expect(row.getByRole('link', { name: /View/ })).toHaveAttribute('href', new RegExp(`/properties/${id}$`));
  const live = await portal(page, id);
  expect(live.status).toBe(200);
  expect(live.body).not.toContain(seller);
  await page.screenshot({ path: 'test-results/website-switch-on.png' });

  // It survives a reload: the state comes from the server, not from the click.
  await page.reload();
  await showDetails(page);
  await expect(page.getByTestId('website-switch').getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });

  await page.getByTestId('website-switch').getByRole('switch').click();
  await expect(page.getByTestId('website-switch').getByRole('switch')).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  expect((await portal(page, id)).status).toBe(404);
});

test('a property goes on the website and comes off again from its menu', async ({ page }) => {
  await page.goto('/properties');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 40_000 });

  const seller = unique('Seller');
  const created = await page.evaluate(async (name) => {
    const token = localStorage.getItem('ipropy.token');
    const res = await fetch('/api/records/properties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ full_name: name, mobile: `9${String(Date.now()).slice(-9)}`, status: 'Available' }),
    });
    return { status: res.status, id: ((await res.json()) as { id: string }).id };
  }, seller);
  expect(created.status).toBeLessThan(300);
  const id = created.id;

  await page.goto(`/properties/${id}`);
  await expect(page.getByRole('heading', { name: seller })).toBeVisible({ timeout: 30_000 });
  const portal = () => page.evaluate(async (rid) => {
    // no-store: the feed is cached for a minute on purpose, and this asks what is true now.
    const res = await fetch(`/api/public/listings/${rid}`, { cache: 'no-store' });
    return { status: res.status, body: await res.text() };
  }, id);

  expect((await portal()).status).toBe(404);

  await page.getByRole('button', { name: /^More( —|) .*record actions/ }).click();
  await page.getByText('Show on website', { exact: true }).click();
  await expect(page.getByText('Shown on the website')).toBeVisible({ timeout: 15_000 });

  const live = await portal();
  expect(live.status).toBe(200);
  // The seller's name is the record's own name in the CRM, and never the portal's.
  expect(live.body).not.toContain(seller);

  await page.getByRole('button', { name: /^More( —|) .*record actions/ }).click();
  await page.getByText('Hide from website', { exact: true }).click();
  await expect(page.getByText('Taken off the website')).toBeVisible({ timeout: 15_000 });
  expect((await portal()).status).toBe(404);
});
