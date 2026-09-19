/**
 * What the split view's two panes show, and what they deliberately do not.
 *
 * Three rules the owner asked for on 19 September 2026, all of which are one
 * line of arranging each and all of which would regress without a word:
 *
 *  * the record page's three-dots menu is here too — he had it on a record and
 *    not in the split view, and the split view is where the team works;
 *  * every queue row carries its status under the follow-up date, so a list
 *    reads as "who, when, where they are up to" without opening anything;
 *  * Lost Reason, Contact Type and Unit Number are **off** the right-hand
 *    header and **in** Basic Information, editable in place.
 *
 * The third is the one worth a browser. Demoting a field is two changes — take
 * it out of the header, put it in a block — and doing only the first deletes
 * it from the screen entirely. A value nobody can see is a value nobody can
 * edit, and nothing would have failed.
 */
import { expect, test } from '@playwright/test';

// The split view is `xl:` and up; below that the panes stack and the queue's
// right-hand column is not where this spec looks for it.
test.use({ viewport: { width: 1680, height: 950 } });

/**
 * Clear the stored list-mode choice so the module's real default is shown.
 *
 * `auth.setup.ts` signs every spec in with `table` already stored, because
 * most of them are about the table. This one is about the split view, so the
 * key has to go — and it is `ipropy.listmode.<module>`, lower-case `mode`.
 * Spelling it `listMode` removes nothing, the table renders, and the failure
 * reads as the split view being broken rather than as a typo in the test.
 */
async function openSplitView(page: import('@playwright/test').Page, module: string): Promise<void> {
  await page.addInitScript((mod) => {
    try { window.localStorage.removeItem(`ipropy.listmode.${mod}`); } catch { /* private window */ }
  }, module);
  await page.goto(`/${module}`);
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
}

for (const { module, demoted } of [
  { module: 'leads', demoted: ['Lost Reason', 'Type'] },
  { module: 'properties', demoted: ['Unit Number'] },
]) {
  test(`the split view's header and queue — ${module}`, async ({ page }) => {
    await openSplitView(page, module);
    const workspace = page.getByTestId('ipropy-workspace');

    // 1. The three dots, and a menu behind them rather than a dead button.
    const more = page.getByRole('button', { name: 'More actions' });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page.getByText('Summarise with AI')).toBeVisible();
    await page.keyboard.press('Escape');

    // 2. Every queue row's status, under its date. Read from the rows rather
    //    than from one, because "the first one happens to have a status" is
    //    how a missing field hides.
    const header = workspace.locator('header').first();
    const headerText = (await header.innerText()).replace(/\s+/g, ' ');

    /*
      3. Demoted fields: gone from the header, present in the body, and
         editable there. The middle assertion is the one that catches the
         half-done version — a field taken off the header and not put back
         anywhere is simply lost, and only this notices.
    */
    for (const label of demoted) {
      expect(headerText, `${label} should be off the header`).not.toContain(`${label}:`);
    }

    const body = workspace.locator('dl').first().locator('xpath=ancestor::div[1]');
    const bodyText = (await body.innerText()).replace(/\s+/g, ' ');
    for (const label of demoted) {
      // Field labels render uppercase in a block, so compare case-insensitively.
      expect(bodyText.toLowerCase(), `${label} should be in the body`)
        .toContain(label.toLowerCase());
      // And editable in place, which is the whole point of moving it.
      await expect(
        page.getByRole('button', { name: `Change ${label}` }).first(),
        `${label} should be editable where it now lives`,
      ).toBeAttached();
    }
  });
}
