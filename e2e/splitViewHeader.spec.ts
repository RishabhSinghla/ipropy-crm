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

/**
 * The middle pane — the record itself.
 *
 * A `<section>` since the three-pane rebuild of 27 September 2026, and
 * `page.locator('main')` also matches the app shell's own `<main>`. Named by
 * the tab strip it contains, which only this pane has.
 */
function recordPane(page: import('@playwright/test').Page) {
  return page.getByTestId('ipropy-workspace')
    .locator('section')
    .filter({ has: page.getByRole('navigation', { name: 'Record workspace sections' }) })
    .first();
}

async function splitView(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('ipropy.listmode.leads', 'ipropy'); } catch { /* see listMode.ts */ }
  });
  await page.goto('/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
}

/*
  Two specs stood here and have been removed rather than left failing.

  They measured `data-testid="header-fields"` in the record pane — that every
  field sat on one line, and that a narrow pane hid one whole rather than
  cutting a word in half. **28 September 2026 took that strip off this screen
  entirely**: the owner asked for the hero compact, and what survived of it is
  three small chips beside the face (`the three chips read as one row` in
  `compactHero.spec.ts`).

  `HeaderFieldStrip` and its count-what-fits rule are still real, and still
  right — the **Chats** header draws them. But that screen only renders when a
  WhatsApp provider is connected, and none is on a developer's database, so
  there is nowhere left to drive it from. **That rule is untested today.** It
  is written down here rather than quietly lost; the way to close it is to pull
  the "how many fit" arithmetic out of the component and test it as a function,
  which would prove more than either of these did.
*/

/*
  "The chips beside the face are one look" stood here. **30 September 2026
  took the chips out of the header** — the owner's four-pane prototype keeps
  only the face, the name, "Updated" and the actions there — and the same
  facts are now pinned rows at the top of the right pane (\`RecordInspector\`),
  proved in \`compactHero.spec.ts\` and \`splitViewHeaderKeys.spec.ts\`.
*/

/** Both places use the same compact avatar size in the current split view. */
test('the record avatar is the same size in the queue and middle header', async ({ page }) => {
  await splitView(page);
  const queueAvatar = page.getByTestId('queue-record-avatar').first();
  const headerAvatar = recordPane(page).getByTestId('split-hero-avatar').getByRole('button', { name: /^Photo of / });
  await expect(queueAvatar).toBeVisible();
  await expect(headerAvatar).toBeVisible();
  const [queueBox, headerBox] = await Promise.all([queueAvatar.boundingBox(), headerAvatar.boundingBox()]);
  expect(queueBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(Math.abs(queueBox!.width - headerBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(queueBox!.height - headerBox!.height)).toBeLessThanOrEqual(1);
});

test('selecting a queue record uses its avatar and does not open photo actions', async ({ page }) => {
  await splitView(page);
  const card = page.getByTestId('queue-card').first();
  const select = card.getByRole('button', { name: /^Select / });
  await expect(card.getByTestId('queue-record-avatar')).toBeVisible();
  await select.click();
  await expect(card.getByRole('button', { name: /^Unselect / })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /Upload photo|Replace photo/ })).toHaveCount(0);
});
