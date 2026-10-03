/**
 * Nine changes to the split view, 28 September 2026, and the four only a
 * browser can settle.
 *
 * Each is a promise a screenshot was the report for, so each is measured on
 * the element itself rather than read off a class name — a class that is
 * present while the thing still looks wrong is exactly the bug.
 */
import { test, expect, type Page } from '@playwright/test';

/** A lead of this spec's own, with an email, so nothing depends on what is
 *  already in the database. */
async function makeLead(page: Page): Promise<{ id: string; name: string; email: string; why: string }> {
  await page.goto('/leads');
  const made = await page.evaluate(async () => {
    const token = localStorage.getItem('ipropy.token');
    const stamp = Date.now();
    const res = await fetch('/api/records/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        full_name: `Header Keys ${stamp}`,
        email: `header.keys.${stamp}@example.com`,
        mobile: `95${String(stamp).slice(-8)}`,
        country_code: '91',
        contact_type: 'Buyer',
      }),
    });
    const body = await res.json() as { id?: string; message?: string };
    return {
      id: body.id ?? '', name: `Header Keys ${stamp}`,
      email: `header.keys.${stamp}@example.com`,
      why: body.message ?? JSON.stringify(body),
    };
  });
  expect(made.id, `could not create the lead this spec needs: ${made.why}`).not.toBe('');
  return made;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
});

test('the toolbar is the list and Task, and Status and Call Log are in the panel', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

  /*
    **This spec was behind the screen and is caught up here.** It asked for a
    Status button on this row, which the owner had already taken off on
    3 October — *"Please remove the status chip/button from left record pane,
    bcoz it is already in the Quick Filter"* — and for a Call Log button, which
    went the same way. The row is two pills now, and both say their own name
    again (3 October, evening).
  */
  const tools = page.getByTestId('queue-tools');
  await expect(tools.getByRole('button', { name: /Choose or manage list views/ })).toContainText(/All Leads/i);
  await expect(tools.getByRole('button', { name: 'Task' })).toContainText('Task');

  // His own words for them, wherever they are drawn: never "Lead Status" here
  // and "Associate Status" there, and never a chevron on a pill.
  await expect(page.getByRole('button', { name: /^Lead Status/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Follow-ups/ })).toHaveCount(0);
  await expect(tools.locator('button[title^="Filter by "]')).toHaveCount(0);

  // And both questions are still askable, in the panel he said they were in.
  await page.getByTestId('quick-filter-button').click();
  const panel = page.getByTestId('quick-filter-overlay');
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/Call Log|Status/i).first()).toBeVisible();
});

test('each pinned fact is introduced by its own field name', async ({ page }) => {
  const made = await makeLead(page);
  await page.goto(`/leads?open=${made.id}`);
  // A regex, not the bare name: the heading now holds the inline editor, so
  // its accessible name carries that control's label too.
  await expect(page.getByRole('heading', { name: new RegExp(made.name) })).toBeVisible({ timeout: 30_000 });

  /*
    Since 30 September 2026 the facts a call changes are pinned rows at the
    top of the right pane, not chips in the header. The labels are the
    *fields'* own, read from metadata, so this asserts the stage's label
    rather than the word "status" written into a component. Case-insensitive:
    the capitals are `text-transform`.
  */
  const inspector = page.getByTestId('record-inspector');
  await expect(inspector.getByText(/^Pipeline Status\*?$/i).first()).toBeVisible();
  await expect(inspector.getByText(/^Call Log$/i)).toBeVisible();

  // The name sits to the left of its value, on one row.
  const row = inspector.getByText(/^Call Log$/i).locator('xpath=..');
  const [label, value] = await row.evaluate((el) => [...el.children].map((c) => c.getBoundingClientRect().toJSON() as DOMRect));
  expect(value!.x, 'the value should sit to the right of its field name').toBeGreaterThan(label!.x + label!.width - 1);
  expect(Math.abs(value!.y + value!.height / 2 - (label!.y + label!.height / 2)), 'the two should share a row').toBeLessThan(12);
});

test('writing to them is in More, only when there is an address', async ({ page }) => {
  const made = await makeLead(page);
  await page.goto(`/leads?open=${made.id}`);
  // A regex, not the bare name: the heading now holds the inline editor, so
  // its accessible name carries that control's label too.
  await expect(page.getByRole('heading', { name: new RegExp(made.name) })).toBeVisible({ timeout: 30_000 });

  /*
    **It left the header strip on 3 October 2026** — *"Move email icons from
    Middle heade pane to Menu bar more tab"* — so the circle is gone and the row
    is behind the menu bar's *More*. Asserting it is absent from the strip as
    well, because a control that moved while the old one stayed is the bug this
    kind of change produces.
  */
  await expect(page.getByTestId('split-hero-actions-status')
    .getByRole('button', { name: `Email ${made.email}` })).toHaveCount(0);
  await page.getByTestId('record-menu-more').click();

  const write = page.getByRole('button', { name: `Email ${made.email}` });
  await expect(write).toBeVisible();
  await write.click();
  // It opens the CRM's own composer, not the operating system's mail client.
  await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 15_000 });
});

test('double-clicking a name in the queue opens an editor with the cursor in it', async ({ page }) => {
  const made = await makeLead(page);
  await page.goto(`/leads?open=${made.id}`);
  // A regex, not the bare name: the heading now holds the inline editor, so
  // its accessible name carries that control's label too.
  await expect(page.getByRole('heading', { name: new RegExp(made.name) })).toBeVisible({ timeout: 30_000 });

  const card = page.locator('[data-testid="queue-card"]').filter({ hasText: made.name }).first();
  await card.getByText(made.name).first().dblclick();

  /*
    Found by what it holds, not by where it sits. **The inline editor floats in
    a portal on `body`**, so a locator rooted in the queue card finds nothing
    at all — a trap this repo has already paid for once and which reads exactly
    like the feature not working.

    Holding the name is also the whole promise: the owner asked for the cursor
    to be in it, not for a second click to put it there.
  */
  await expect.poll(
    async () => page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | null;
      return el && el.tagName === 'INPUT' ? el.value : null;
    }),
    { timeout: 10_000, message: 'the editor should open focused, with the name already in it' },
  ).toBe(made.name);
});
