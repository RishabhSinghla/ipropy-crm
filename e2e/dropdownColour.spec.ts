/**
 * Giving a dropdown option a colour: one square and the code beside it.
 *
 * **28 September 2026, the owner:** *"In the dropdown, we don't need too much
 * colour button, just want to easy colour picker else circle or square box
 * with colour code."* Every option row carried ten preset dots and a small
 * picker at the end of them — a wall of colour to read past before reaching
 * the option's own name.
 *
 * Only a browser proves the two things that matter here: that the code box
 * really writes the colour the option is saved with, and that an unfinished
 * code leaves the option with no colour rather than with half a one. A unit
 * test can check `tidyHexInput`; it cannot check that the value reaches the
 * server.
 */
import { test, expect, type Page } from '@playwright/test';

/** The one picker on each option row — a real colour input, stretched
 *  invisibly over the square so the square is the whole click target. */
const swatches = (page: Page) => page.locator('input[type="color"]');

async function openCallDisposition(page: Page) {
  await page.goto('/admin/picklists');
  await page.getByRole('button', { name: /^Call Disposition/ }).click();
  await expect(page.getByRole('button', { name: 'Add option' })).toBeVisible({ timeout: 30_000 });
}

test('one swatch and one code box per option, and no preset palette', async ({ page }) => {
  await openCallDisposition(page);

  const codes = page.getByRole('textbox', { name: 'Colour code' });
  const count = await codes.count();
  expect(count).toBeGreaterThan(0);
  // One picker per option, never a row of them.
  await expect(swatches(page)).toHaveCount(count);

  // The ten preset dots are gone. They were the only other control that set a
  // colour, and each carried its own hex as its accessible name.
  await expect(page.getByRole('button', { name: /^Use #[0-9a-fA-F]{6}$/ })).toHaveCount(0);
});

test('a code typed in is the colour the option is saved with', async ({ page }) => {
  await openCallDisposition(page);

  const code = page.getByRole('textbox', { name: 'Colour code' }).first();
  // This runs against the developer's own database and Call Disposition is a
  // real list somebody may have coloured, so whatever is there goes back
  // afterwards. A spec that leaves a business list repainted is a spec that
  // reports the machine it ran on.
  const before = await code.inputValue();

  // A colour this option is not already wearing. Typing in the value that is
  // already there changes nothing, so Save stays disabled and the spec hangs
  // on a button that is correct to be dead — which is how this one failed
  // the first time it ran twice in a row.
  const target = before.toUpperCase() === '#123ABC' ? '#4455EE' : '#123ABC';

  await code.fill(target);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Dropdown saved')).toBeVisible({ timeout: 15_000 });

  // Read it back off the server rather than off the box that was just typed in.
  await page.reload();
  await page.getByRole('button', { name: /^Call Disposition/ }).click();
  const after = page.getByRole('textbox', { name: 'Colour code' }).first();
  await expect(after).toHaveValue(target);

  await after.fill(before);
  await after.blur();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Dropdown saved')).toBeVisible({ timeout: 15_000 });
});

test('an unfinished code is no colour, not half a colour', async ({ page }) => {
  await openCallDisposition(page);

  const code = page.getByRole('textbox', { name: 'Colour code' }).first();
  await code.fill('#12');
  await code.blur();
  await expect(code).toHaveValue('');
});
