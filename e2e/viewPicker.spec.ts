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
  await expect(page.getByText(/^[\d,]+ of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
});

test('the view picker opens and lists views', async ({ page }) => {
  await page.getByRole('button', { name: 'Choose or manage list views' }).click();
  await expect(page.getByText('Select list or tag')).toBeVisible();
  // Every module ships at least one view, so an empty picker is a real failure.
  await expect(page.getByRole('button', { name: /^All Leads/ })).toBeVisible();
});

test('choosing a view still applies it', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Choose or manage list views' });
  await trigger.click();
  /*
    The picker's rows are plain buttons — there is no menu role to ask for — so
    they are addressed through the landmark around them. Matching "every button
    inside the panel" instead catches the create button and each row's action
    menu, which is how this spec silently skipped itself.
  */
  const options = page.getByRole('navigation', { name: 'Lists and tags' })
    .getByRole('button', { name: /\S/ })
    .filter({ hasNotText: /^Actions for/ });
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
  await expect(page.getByText(/^[\d,]+ of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Choose or manage list views' }).click();
  const search = page.getByLabel('Search lists and tags');
  await expect(search).toBeVisible();

  /*
    Anchored to the start of the name. Every row carries two buttons whose
    accessible name contains the view's — the row itself, and its action menu,
    which reads "Actions for <name>" — so an unanchored match counts twice.
  */
  const marked = page.getByRole('button', { name: new RegExp(`^${marker}`) });

  // Narrows to the marked ones…
  await search.fill(marker);
  await expect(marked).toHaveCount(6);

  // …says so plainly when nothing matches…
  await search.fill('zzzz-no-such-view');
  await expect(page.getByText(/Nothing matches/)).toBeVisible();
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
    /*
      The module is part of the path. Without it this is a 404 that the loop
      never looks at, so the six views stayed — thirty of them had built up in
      the developer database before anybody noticed the picker was full of
      "zqa… view 3".
    */
    const gone = await request.delete(`/api/views/leads/${id}`, { headers: auth });
    expect(gone.ok(), `could not remove a view this spec made: ${gone.status()}`).toBeTruthy();
  }
});
