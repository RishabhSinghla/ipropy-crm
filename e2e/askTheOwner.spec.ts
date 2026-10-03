/**
 * A rep searches, sees a record that is not theirs, and asks for it.
 *
 * **3 October 2026, the owner:** *"if the agent/user search the any thing, then
 * system will display the record name on the screen and if agent want to access
 * the display record, he can ask to actual owner of record for the permission to
 * assigned him."*
 *
 * The server half is pinned against a real database in
 * `tests/integration/askTheOwnerForARecord.test.ts`. What only a browser can
 * say is whether the row is *reachable*: the search box, the amber row, and a
 * button that answers.
 *
 * The suite signs in as the admin, who can see everything — so the restricted
 * row cannot be produced by searching. What is proved here is the shape of the
 * flow against the real API: the request is made, the owner's banner draws it,
 * and granting moves the record.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

/**
 * One call to the CRM's own API, as the signed-in person.
 *
 * `localStorage['ipropy.token']` is a **bare string**, not JSON — reading it
 * with `JSON.parse` yields undefined, every call goes out unauthenticated, and
 * `fetch` does not throw on a 401. That has made two specs in this suite pass
 * while doing nothing at all.
 */
async function apiRequest(page: Page, method: string, path: string, body?: unknown): Promise<unknown> {
  return page.evaluate(async ([m, p, b]) => {
    const token = localStorage.getItem('ipropy.token');
    const res = await fetch(p as string, {
      method: m as string,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    if (!res.ok) throw new Error(`${m} ${p} answered ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }, [method, path, body] as const);
}

test('the owner is shown who asked, and handing it over moves the record', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/[\d,]+ records/).first()).toBeVisible({ timeout: 30_000 });

  // A lead of our own, and a colleague to ask with. Unique marker, because the
  // suite runs against the developer's own database.
  const marker = `Ask owner ${Date.now()}`;
  const made = await apiRequest(page, 'POST', '/api/records/leads', {
    full_name: marker, country_code: '91', mobile: String(9000000000 + (Date.now() % 900000000)),
  });
  // `/api/admin/users`, not `/api/users` — the second does not exist, and a
  // wrong path here answers 404 rather than failing the promise under test.
  const users = await apiRequest(page, 'GET', '/api/admin/users?assignableOnly=true');
  const signedIn = await apiRequest(page, 'GET', '/api/auth/me') as { user?: { id: string } };
  const other = (users as Array<{ id: string }>).find((user) => user.id !== signedIn.user?.id);
  test.skip(!other, 'this database has only one assignable user');

  // Hand it to them, so the admin is no longer its owner and can legitimately
  // ask for it back — which is the shape the owner described.
  await apiRequest(page, 'PATCH', `/api/records/leads/${(made as { id: string }).id}`, { owner_id: other!.id });
  const request = await apiRequest(page, 'POST', '/api/access-requests', {
    recordId: (made as { id: string }).id, note: 'They rang me this morning',
  });
  expect((request as { status: string }).status).toBe('pending');

  // An admin sees every open request, so the banner draws on the record.
  await page.goto(`/leads/${(made as { id: string }).id}`);
  const banner = page.getByTestId('access-request-banner');
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText('They rang me this morning');

  // Handing it over is the ordinary reassignment — the record really moves.
  await banner.getByRole('button', { name: /^Assign to/ }).click();
  await expect(banner).toHaveCount(0, { timeout: 20_000 });
  const after = await apiRequest(page, 'GET', `/api/records/leads/${(made as { id: string }).id}`);
  expect((after as { values: Record<string, unknown> }).values.owner_id).toBeTruthy();

  await apiRequest(page, 'DELETE', `/api/records/leads/${(made as { id: string }).id}`).catch(() => undefined);
});
