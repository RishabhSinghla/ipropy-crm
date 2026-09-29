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

test('the toolbar says Status, Task and Call Log, with no arrows', async ({ page }) => {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });

  // The owner's own words for these buttons, 28 September 2026 — one set of
  // words on every module rather than "Lead Status" here and "Associate
  // Status" there.
  for (const label of ['Status', 'Task', 'Call Log']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /^Lead Status/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Follow-ups/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Call Disposition/ })).toHaveCount(0);
});

test('each header chip is introduced by its own field name', async ({ page }) => {
  const made = await makeLead(page);
  await page.goto(`/leads?open=${made.id}`);
  // A regex, not the bare name: the heading now holds the inline editor, so
  // its accessible name carries that control's label too.
  await expect(page.getByRole('heading', { name: new RegExp(made.name) })).toBeVisible({ timeout: 30_000 });

  const header = page.locator('section header').first();
  // The labels are the *fields'* own, read from metadata, so this asserts the
  // stage's label rather than the word "status" written into a component.
  const chipGroup = header.locator('[data-testid="hero-chips"]');
  // Case-insensitive: the capitals are `text-transform`, so the DOM still
  // carries the field's own label as an admin typed it.
  await expect(chipGroup.getByText(/^Pipeline Status$/i)).toBeVisible();
  await expect(chipGroup.getByText(/^Call Log$/i)).toBeVisible();

  /*
    **The name sits above the value, not beside it** — the owner's own samples,
    29 September 2026: *"Next Follow Up / Overdue (11D)"*. Measured as two
    boxes rather than read off a `flex-col`, because a class that is present
    while the pair still reads side by side is exactly the bug.
  */
  const stacked = await chipGroup.evaluate((group) => {
    const pair = group.children[group.children.length - 1] as HTMLElement;
    const [label, value] = [...pair.children].map((c) => c.getBoundingClientRect());
    return { labelBottom: label.bottom, valueTop: value.top, labelLeft: label.left, valueLeft: value.left };
  });
  expect(stacked.valueTop, 'the value should sit below its field name').toBeGreaterThanOrEqual(stacked.labelBottom - 1);
  expect(Math.abs(stacked.valueLeft - stacked.labelLeft), 'the two should share a left edge').toBeLessThan(6);

  // And they may never run under the face. Measured rather than assumed,
  // because the hero has been rearranged twice and an overlap is the failure
  // mode each time.
  const chipBox = await chipGroup.boundingBox();
  const faceBox = await page.locator('[data-testid="split-hero-avatar"]').boundingBox();
  expect(chipBox, 'the chip group should be on screen').not.toBeNull();
  if (chipBox && faceBox) expect(chipBox.x).toBeGreaterThanOrEqual(faceBox.x + faceBox.width - 1);
});

test('no hairline sits between the icons and the three call chips', async ({ page }) => {
  const made = await makeLead(page);
  await page.goto(`/leads?open=${made.id}`);
  await expect(page.getByRole('heading', { name: new RegExp(made.name) })).toBeVisible({ timeout: 30_000 });

  /*
    *"Remove Separator Line in Middle Pane header between Icons and Button Of
    Follow-up, Status, Call Disposition from All modules"* — 28 September 2026.

    Measured off the computed style, not read off a class list: a `border-t`
    that is present while `border-top-width` is 0 would pass a class check and
    still be the thing on screen.
  */
  const row = page.locator('[data-testid="split-hero-status-row"]');
  await expect(row).toBeVisible();
  const rule = await row.evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(rule, 'the hero still draws a rule above the call chips').toBe('0px');
});

test('an email icon appears only when there is an address to write to', async ({ page }) => {
  const made = await makeLead(page);
  await page.goto(`/leads?open=${made.id}`);
  // A regex, not the bare name: the heading now holds the inline editor, so
  // its accessible name carries that control's label too.
  await expect(page.getByRole('heading', { name: new RegExp(made.name) })).toBeVisible({ timeout: 30_000 });

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
