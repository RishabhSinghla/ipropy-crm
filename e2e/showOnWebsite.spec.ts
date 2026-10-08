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
import { unique } from './helpers';

test.use({ viewport: { width: 1600, height: 900 } });

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
