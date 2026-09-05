import { expect, test } from '@playwright/test';
import { unique } from './helpers';

/**
 * Dragging photos into order, through the screen rather than under it.
 *
 * The reordering API has been tested from the start. What had never been tested
 * is the part a person touches, and that is the half that broke: the drag is
 * HTML5 drag-and-drop, `dragFrom` is React state, and a dispatch that fires
 * dragstart and drop in the same tick finds `dragFrom` still null. Nothing
 * throws. The photos simply do not move, which reads as a broken feature and
 * leaves no trace anywhere a test was looking.
 *
 * So this drives a real mouse. Playwright's press, move, release over a
 * draggable element is what Chromium turns into genuine drag events, with real
 * time passing in between, which is the one condition the old synthetic
 * approach could not reproduce.
 *
 * The cover photo is not a cosmetic detail: it leads the share link a buyer
 * opens, the download, and the public website.
 */

test('drags a photo to the front and the new cover survives a reload', async ({ page }) => {
  const name = unique('Drag Order');

  await page.goto('/properties');

  // The record and its photos are made through the API, on purpose. The thing
  // under test is the drag, and driving a create form and an upload widget to
  // reach it would mean this test fails whenever either of those changes,
  // reporting a reordering bug that is not there. Setup through the API, the
  // behaviour under test through the screen.
  const recordId = await page.evaluate(async (propertyName) => {
    const token = localStorage.getItem('ipropy.token');
    const headers = { Authorization: `Bearer ${token}` };

    const created = await fetch('/api/records/properties', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: propertyName }),
    }).then((r) => r.json());

    // A one-pixel PNG in two different colours. Two distinct files rather than
    // one uploaded twice, so a deduplicating upload cannot collapse them into a
    // single attachment and let this pass while proving nothing.
    const pngs = [
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    ];
    for (let i = 0; i < pngs.length; i += 1) {
      const bytes = Uint8Array.from(atob(pngs[i]), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append('file', new File([bytes], `photo-${i}.png`, { type: 'image/png' }), `photo-${i}.png`);
      form.append('recordId', created.id);
      form.append('module', 'properties');
      // Sequential rather than in parallel: the order they arrive in is the
      // order under test, and two concurrent uploads have no defined one.
       
      await fetch('/api/files', { method: 'POST', headers, body: form });
    }
    return created.id as string;
  }, name);

  expect(recordId, 'the property was not created').toBeTruthy();

  await page.goto(`/properties/${recordId}`);

  const thumbs = page.getByRole('button', { name: /^Show photo \d+$/ });
  await expect(thumbs).toHaveCount(2, { timeout: 30_000 });

  const before = await thumbs.nth(0).locator('img').getAttribute('src');
  const second = await thumbs.nth(1).locator('img').getAttribute('src');
  expect(before).not.toBe(second);

  // The drag. Real mouse, real time passing: press, move in steps so Chromium
  // starts a drag rather than reading it as a click, then release on the first
  // thumbnail.
  const from = await thumbs.nth(1).boundingBox();
  const to = await thumbs.nth(0).boundingBox();
  expect(from && to).toBeTruthy();

  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  await page.mouse.up();

  // The toast is the app saying it saved, not the UI reordering optimistically.
  await expect(page.getByText(/cover photo set|photos rearranged/i)).toBeVisible({ timeout: 15_000 });

  // The real assertion: after a reload, the photo that was second is first.
  // Anything short of a reload would pass on a purely local state change.
  await page.reload();
  await expect(thumbs).toHaveCount(2, { timeout: 30_000 });
  await expect(thumbs.nth(0).locator('img')).toHaveAttribute('src', second!);

  // Tidy up after itself. This suite runs against the developer's own database
  // rather than a throwaway one, and a test that leaves a record behind on every
  // run is how the dashboard ends up greeting him by the name of a fixture.
  await page.evaluate(async (id) => {
    await fetch(`/api/records/properties/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${localStorage.getItem('ipropy.token')}` },
    });
  }, recordId);
});
