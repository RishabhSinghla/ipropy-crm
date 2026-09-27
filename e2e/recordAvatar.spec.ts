/**
 * A record's photo: add it, see it, take it away.
 *
 * **27 September 2026, the owner:** *"In the avtar we can add, Edit remove
 * avtar Picture."*
 *
 * The photo is an ordinary attachment under `category = 'avatar'`, which is
 * why there is no migration behind this — but that also means three separate
 * things have to line up before a face appears, and only a browser can see all
 * three at once: the upload, the category that makes it the record's face, and
 * an address the permission-checked file route will actually serve.
 *
 * The listing endpoint hands back **no URL** on purpose — every byte comes
 * through `/api/files/:id` — so the first build showed a toast saying the
 * photo had been updated and went on drawing initials. Nothing else could have
 * caught that.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

/** A real 1×1 PNG, so the image pipeline gets something it can decode. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

for (const path of ['/leads', '/properties']) {
  test(`a photo goes on and comes off a record — ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 40_000 });

    const open = page.getByRole('button', { name: /Add a photo|Change or remove the photo/ });
    await expect(open).toBeVisible({ timeout: 20_000 });
    await open.click();

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText(/^(Upload|Replace) photo$/).first().click(),
    ]);
    await chooser.setFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByText('Photo updated')).toBeVisible({ timeout: 20_000 });

    /*
      The face itself, not the toast. An `<img>` served from the CRM's own
      permission-checked route is the only thing that says all three steps
      lined up.
    */
    const photo = page.getByTestId('ipropy-workspace').locator('img[alt]').first();
    await expect(photo).toBeVisible({ timeout: 20_000 });
    await expect(photo).toHaveAttribute('src', /\/api\/files\/[0-9a-f-]{36}/);

    // And off again, so the next run starts where this one did.
    await page.getByRole('button', { name: 'Change or remove the photo' }).click();
    await page.getByText('Remove photo').click();
    await expect(page.getByText('Photo removed')).toBeVisible({ timeout: 20_000 });
  });
}
