/**
 * The buyer's path: a rep sends a property, a stranger opens it.
 *
 * This is the one screen a customer ever sees, and they arrive at it the way
 * nothing else in the CRM is used — no account, no session, one link, and an
 * expectation that it just opens. So it is walked that way here.
 *
 * The other half is the contract CLAUDE.md is firm about: **every** share-link
 * failure resolves to the same 404. Unknown token, revoked link, expired link,
 * deleted property — one answer. A "this link was revoked" message tells a
 * stranger that the token they guessed was real, which is the one thing the
 * page must never confirm.
 */
import { expect, test } from '@playwright/test';

const API = 'http://localhost:4000';

test.describe.configure({ mode: 'serial' });

let adminToken = '';
let propertyId = '';
let liveToken = '';
let revokedToken = '';

async function api(method: string, path: string, body?: unknown) {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test.beforeAll(async () => {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin@ipropy.com', password: 'Admin@123' }),
  });
  adminToken = ((await res.json()) as { token: string }).token;
  expect(adminToken, 'could not sign in to set the journey up').toBeTruthy();
});

test.afterAll(async () => {
  if (propertyId) await api('DELETE', `/api/records/properties/${propertyId}`).catch(() => undefined);
});

test('a rep puts a property on the system and mints a link for a buyer', async () => {
  const res = await api('POST', '/api/records/properties', {
    // A unique mobile is the Property identity, while Unit Number may repeat.
    full_name: `Journey Heights ${Date.now()}`,
    mobile: `98${String(Date.now()).slice(-8)}`,
    locality: 'Powai',
    floor: 7,
    property_type: 'Builder Floor',
    status: 'Available',
    base_price: 14500000,
  });
  if (!res.ok) console.log('property create failed:', res.status, await res.text());
  expect(res.ok, 'the rep could not create a property at all').toBe(true);
  propertyId = ((await res.json()) as { id: string }).id;

  const link = await api('POST', `/api/records/properties/${propertyId}/share-links`, {
    label: 'For a buyer',
  });
  expect(link.ok, 'minting a share link failed').toBe(true);
  liveToken = ((await link.json()) as { token: string }).token;
  expect(liveToken?.length, 'no token came back').toBeGreaterThan(10);
});

test('the buyer opens it with no account and sees the property', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text().slice(0, 200)); });

  await page.goto(`/s/${liveToken}`);

  // Something about the property has to be on screen. Asserting on the price
  // rather than the shell, because a shell that renders with no data is exactly
  // the failure a buyer would report as "your link is broken".
  await expect(page.getByText(/1\.45\s*Cr|1,45,00,000|Price on request/i).first())
    .toBeVisible({ timeout: 15_000 });

  expect(problems, 'the buyer page logged errors').toEqual([]);
});

test('it never asks the buyer to sign in', async ({ page }) => {
  // The whole point of a share link. A redirect to /login here means a rep's
  // customer is being asked for a password they will never have.
  await page.goto(`/s/${liveToken}`);
  await page.waitForLoadState('networkidle');
  expect(page.url()).toContain(`/s/${liveToken}`);
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
});

test('a made-up token is refused', async () => {
  const res = await fetch(`${API}/api/public/share/not-a-real-token-at-all`);
  expect(res.status).toBe(404);
});

test('a revoked link is refused the same way, and says nothing more', async () => {
  /*
    The contract worth protecting. If a revoked link answered 410, or said
    "this link was revoked", it would confirm to a stranger that the token they
    tried was a real one. Every failure has to be indistinguishable.
  */
  const mint = await api('POST', `/api/records/properties/${propertyId}/share-links`, {
    label: 'To be revoked',
  });
  revokedToken = ((await mint.json()) as { token: string }).token;

  const before = await fetch(`${API}/api/public/share/${revokedToken}`);
  expect(before.status, 'the link should work before it is revoked').toBe(200);

  const links = (await (await api('GET', `/api/records/properties/${propertyId}/share-links`)).json()) as { id: string; token: string }[];
  const row = links.find((l) => l.token === revokedToken);
  expect(row, 'could not find the link to revoke').toBeTruthy();
  await api('DELETE', `/api/records/properties/${propertyId}/share-links/${row!.id}`);

  const after = await fetch(`${API}/api/public/share/${revokedToken}`);
  expect(after.status, 'a revoked link must 404, not 410 or 403').toBe(404);

  const unknown = await fetch(`${API}/api/public/share/not-a-real-token-at-all`);
  expect(
    await after.text(),
    'a revoked link and an unknown one must be indistinguishable',
  ).toBe(await unknown.text());
});

test('a deleted property takes its links with it', async ({ page }) => {
  /*
    A rep deletes a listing that sold. Every link already sent for it has to
    stop working — otherwise the CRM is still advertising a sold floor to
    whoever holds the link, which is the exact fault fixed for the public
    catalogue in `deletedPropertyLeavesWebsite`.
  */
  await api('DELETE', `/api/records/properties/${propertyId}`);

  const res = await fetch(`${API}/api/public/share/${liveToken}`);
  expect(res.status, 'a link for a deleted property still served it').toBe(404);

  await page.goto(`/s/${liveToken}`);
  await expect(page.getByText(/1\.45\s*Cr|1,45,00,000/i)).toHaveCount(0);

  propertyId = '';
});
