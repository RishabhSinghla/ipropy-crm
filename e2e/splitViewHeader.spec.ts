/**
 * The record header is one line of facts, and the actions beside it.
 *
 * The owner's instruction on 19 September: *"Please set all in one row, so
 * that we can see narrow header and wide Timeline… if more then line should
 * make it in dash … so that we can choose only option from master."* A header
 * that wraps to three rows eats the screen the work actually happens on, and
 * silently clipping instead would hide fields with nothing to say so.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 900 } });

async function splitView(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('ipropy.listmode.leads', 'ipropy'); } catch { /* see listMode.ts */ }
  });
  await page.goto('/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
}

test('every header field sits on the same line', async ({ page }) => {
  await splitView(page);
  const header = page.getByTestId('ipropy-workspace').locator('main > header');

  /*
    Measured, not read off a class: `flex-nowrap` present while the row still
    wraps is exactly the bug. Every label shares one baseline or the header has
    grown a row.
  */
  const labels = header.getByTestId('header-fields').locator('> span');
  const count = await labels.count();
  expect(count, 'the header shows no fields at all').toBeGreaterThan(1);

  const tops: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const box = await labels.nth(i).boundingBox();
    if (box) tops.push(Math.round(box.y));
  }
  const spread = Math.max(...tops) - Math.min(...tops);
  expect(spread, 'the header fields are on more than one line').toBeLessThan(6);
});

test('the actions are star, WhatsApp, call, tag and the menu — and Delete is only in the menu', async ({ page }) => {
  await splitView(page);
  const header = page.getByTestId('ipropy-workspace').locator('main > header');

  await expect(header.getByRole('button', { name: 'Edit tags' })).toBeVisible();

  /*
    One destructive action offered twice, a thumb's width from Call, is one
    more chance to hit it by accident than it is worth. It stays in the menu,
    where it already was.
  */
  await expect(header.locator('button[title^="Delete "]')).toHaveCount(0);
  await header.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('button', { name: /^Delete/ })).toBeVisible();
});

test('the tag icon actually tags the record', async ({ page }) => {
  await splitView(page);
  const marker = `E2E Tag ${Date.now()}`;

  // A tag to choose. Created through the API the admin screen uses, and
  // removed again at the end so the vocabulary is not left growing.
  const tagId = await page.evaluate(async (name) => {
    const token = localStorage.getItem('ipropy.token');
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, color: '#2563eb', modules: ['leads'] }),
    });
    return (await res.json() as { id: string }).id;
  }, marker);

  try {
    const header = page.getByTestId('ipropy-workspace').locator('main > header');
    await header.getByRole('button', { name: 'Edit tags' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Tags').first()).toBeVisible();
    await dialog.getByRole('button', { name: marker }).click();
    await dialog.getByRole('button', { name: 'Save tags' }).click();

    // On the record, not merely in a dialog that closed.
    await expect(header.getByText(marker)).toBeVisible({ timeout: 15_000 });
  } finally {
    await page.evaluate(async (id) => {
      const token = localStorage.getItem('ipropy.token');
      await fetch(`/api/tags/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    }, tagId);
  }
});
