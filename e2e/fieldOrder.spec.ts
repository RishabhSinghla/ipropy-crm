/**
 * Moving a field, from the row it is on.
 *
 * `POST /api/meta/fields/reorder` has existed since the layout designer was
 * written and had never been called by anything: the designer edits a *layout*,
 * which is a different object, and leaves `ipy_field.sequence` alone. So the
 * order shown on Modules & Fields could not be changed from Modules & Fields.
 *
 * Buttons rather than drag, because this list runs to thirty-odd rows on Leads,
 * dragging one to the far end of a scrolling page is miserable, and a drag
 * handle cannot be used from a keyboard at all.
 */
import { test, expect } from '@playwright/test';

/**
 * Every field's API name, in the order the page draws them.
 *
 * Read straight off the page in document order rather than scoped to a section:
 * the section heading is a sibling of the rows, not a wrapper around them, so
 * there is no element to scope to. A move within a section is a swap of two
 * neighbours in this list either way.
 */
async function order(page: import('@playwright/test').Page): Promise<string[]> {
  const names = await page.locator('p.font-mono').allTextContents();
  return names.map((t) => t.split(' ·')[0]!.trim());
}

test.beforeEach(async ({ page }) => {
  await page.goto('/admin/fields?module=leads');
  await expect(page.getByRole('heading', { name: 'Modules & Fields' })).toBeVisible();
  await expect(page.locator('p.font-mono').first()).toBeVisible();
});

test('moves a field down and the new order survives a reload', async ({ page }) => {
  const before = await order(page);
  expect(before.length).toBeGreaterThan(2);

  // The second field: it has somewhere to go in both directions, and its
  // neighbour is in the same section.
  const moving = before[1]!;
  const displaced = before[2]!;
  await page.getByRole('button', { name: /Move .* down/ }).nth(1).click();

  await expect.poll(async () => (await order(page))[1]).toBe(displaced);
  expect((await order(page))[2]).toBe(moving);

  await page.reload();
  await expect(page.locator('p.font-mono').first()).toBeVisible();
  expect((await order(page))[2], 'the new order must survive a reload').toBe(moving);

  // Put it back, so the next run starts where this one did.
  await page.getByRole('button', { name: /Move .* up/ }).nth(2).click();
  await expect.poll(async () => (await order(page))[1]).toBe(moving);
});

test('cannot move the first field up or the last one down', async ({ page }) => {
  // Disabled rather than hidden, so the column does not jump about as you move
  // a field down a list.
  await expect(page.getByRole('button', { name: /Move .* up/ }).first()).toBeDisabled();
  await expect(page.getByRole('button', { name: /Move .* down/ }).last()).toBeDisabled();
});

/**
 * Moving a field between sections is checked on a field this test creates.
 *
 * The earlier version did it to whichever field happened to be first, and put it
 * back by selecting the old section again — which appends to the end rather than
 * restoring the position. Run against a developer's own database, as this suite
 * is by design, that left Record # and Full Name at the bottom of Leads, and the
 * repair was by hand. A test that has to mutate something should bring its own.
 */
test('a field can be moved into another section', async ({ page }) => {
  // The app keeps its token in localStorage, not a cookie, so an API call from
  // the test has to carry it the same way the app does.
  const token = await page.evaluate(() => localStorage.getItem('ipropy.token'));
  expect(token, 'no signed-in token to call the API with').toBeTruthy();
  const auth = { Authorization: `Bearer ${token}` };

  const name = `e2e_move_${Date.now().toString(36)}`;
  // The control is labelled with the field's Label, not its API name.
  const label = 'E2E Move Me';
  const created = await page.request.post('/api/meta/modules/leads/fields', {
    headers: auth,
    data: { name, label, uitype: 'string' },
  });
  expect(created.ok(), 'could not create the throwaway field').toBe(true);
  const { id } = await created.json() as { id: string };

  try {
    await page.reload();
    const select = page.getByRole('combobox', { name: `Section for ${label}` });
    await expect(select).toBeVisible();

    const options = await select.locator('option').all();
    expect(options.length, 'needs a second section to move into').toBeGreaterThan(1);

    const current = await select.inputValue();
    const target = (await Promise.all(options.map((o) => o.getAttribute('value'))))
      .find((v) => v && v !== current);
    expect(target, 'no other section to move into').toBeTruthy();

    await select.selectOption(target!);

    await page.reload();
    await expect(page.getByRole('combobox', { name: `Section for ${label}` }))
      .toHaveValue(target!, { timeout: 15_000 });
  } finally {
    // Its own field, so removing it restores the page exactly.
    await page.request.delete(`/api/meta/fields/${id}?permanent=true`, { headers: auth });
  }
});
