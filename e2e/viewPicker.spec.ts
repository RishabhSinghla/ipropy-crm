/**
 * Finding a saved view when there are more than a handful.
 *
 * The picker listed every view in creation order, so on a team that has built
 * up a dozen the one you want is a scroll and a read away — and that list is
 * the control somebody opens most often, since it answers "which list am I on".
 *
 * The search box appears only once there are enough views to hunt through;
 * over three of them it is a box asking a question nobody had. So this spec
 * asserts the picker works either way rather than assuming the seeded data has
 * enough views to show it.
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
});

test('the view picker opens and lists views', async ({ page }) => {
  await page.getByRole('button', { name: 'Choose or manage list views' }).click();
  await expect(page.getByText('List views')).toBeVisible();
  // Every module ships at least one view, so an empty menu is a real failure.
  await expect(page.getByRole('menuitem').or(page.locator('[role="menuitem"]')).first()
    .or(page.getByText(/Current/))).toBeVisible();
});

test('choosing a view still applies it', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Choose or manage list views' });
  await trigger.click();
  /*
    The menu is built from plain buttons — `DropdownItem` renders a <button>
    with no menu role — so it is found by what it says, not by a role a
    screen-reader menu would have. Worth knowing before writing `menuitem`
    here again and watching it match nothing.
  */
  const panel = page.locator('div').filter({ hasText: /^List views/ }).last();
  const options = panel.getByRole('button');
  test.skip((await options.count()) < 2, 'needs a second view to switch to');

  const label = (await options.first().innerText()).split('\n')[0].trim();
  await options.first().click();
  // The trigger names the view you are on — that is what makes the switch visible.
  await expect(trigger).toContainText(label.slice(0, 10), { timeout: 15_000 });
});

test('the search box narrows the list once there are enough views', async ({ page, request }) => {
  /*
    Made, not hoped for. A seeded module ships two or three views, which is
    below the point the search box appears at — so a spec that only looks at
    what happens to be there skips silently and proves nothing. These carry a
    unique marker so they cannot collide with a real view or with another run.
  */
  // The session is a bearer token in localStorage, not a cookie — the app is
  // wrapped in a webview where a third-party cookie is dropped — so the API
  // fixture has to be handed it or every call is a 401.
  const token = await page.evaluate(() => localStorage.getItem('ipropy.token'));
  expect(token, 'signed-in session should carry a token').toBeTruthy();
  const auth = { Authorization: `Bearer ${token}` };

  const marker = `zqa${Date.now().toString(36)}`;
  const created: string[] = [];
  for (let i = 0; i < 6; i++) {
    const made = await request.post('/api/views/leads', {
      headers: auth,
      data: { name: `${marker} view ${i}`, filter: { logic: 'AND', conditions: [] }, columns: ['full_name', 'mobile'] },
    });
    expect(made.ok(), `could not create a view: ${made.status()} ${await made.text()}`).toBeTruthy();
    created.push((await made.json()).id as string);
  }
  await page.reload();
  await expect(page.getByText(/^[\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Choose or manage list views' }).click();
  const search = page.getByLabel('Search list views');
  await expect(search, 'six views is past the point the box should appear').toBeVisible();

  /*
    Anchored to the start of the name. Every row carries two buttons whose
    accessible name contains the view's — the row itself, and its edit pencil,
    which reads "Edit <name>" — so an unanchored match counts each view twice.
  */
  const marked = page.getByRole('button', { name: new RegExp(`^${marker}`) });

  // Narrows to the marked ones…
  await search.fill(marker);
  await expect(marked).toHaveCount(6);

  // …says so plainly when nothing matches…
  await search.fill('zzzz-no-such-view');
  await expect(page.getByText(/No view matches/)).toBeVisible();
  await expect(marked).toHaveCount(0);

  // …and clearing it brings them back.
  await search.fill('');
  await expect(marked).toHaveCount(6);

  /*
    Taken away again, and deliberately so. This suite runs against a real
    developer database rather than a throwaway one, so anything a spec leaves
    behind is there for every later run — and a view is not inert: the list
    remembers the one you chose. Six strays and a remembered selection are how
    a later spec ends up asserting against a list nobody configured.
  */
  await page.keyboard.press('Escape');
  for (const id of created) {
    await request.delete(`/api/views/${id}`, { headers: auth });
  }
});
