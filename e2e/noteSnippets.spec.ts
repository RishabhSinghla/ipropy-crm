/**
 * The note chips come from the admin's dropdown, and tapping one writes.
 *
 * **27 September 2026, the owner:** *"yes make those chips editable from a
 * dropdown."* His prototype drew three phrases under the notes box and the
 * first build left them out, because three business phrases written into a
 * component are three phrases no admin can change.
 *
 * Two halves need a browser: that the chips on the record really are the
 * `note_snippet` picklist — an option Settings can add and the record does not
 * offer is Settings editing a list nobody can use — and that tapping one puts
 * the words in the box. What the note reads *afterwards* is pinned in
 * `tests/noteSnippets.test.ts`, which needs no browser at all.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

test("the chips are the admin's list, and one writes into the note", async ({ page }) => {
  const phrase = `E2E phrase ${Date.now()}`;
  await page.goto('/leads');
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 40_000 });

  const added = await page.evaluate(async (newValue) => {
    const token = localStorage.getItem('ipropy.token');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const current = await (await fetch('/api/meta/picklists/note_snippet', { headers })).json();
    const values = [...current, { value: newValue, label: newValue, isActive: true }]
      .map((v: { value: string; label: string; color?: string | null; isActive?: boolean }) => ({
        value: v.value, label: v.label, color: v.color ?? null, isActive: v.isActive ?? true,
      }));
    const res = await fetch('/api/meta/picklists/note_snippet/values', {
      method: 'PUT', headers, body: JSON.stringify({ values }),
    });
    return res.ok;
  }, phrase);
  expect(added, 'could not add the phrase as an admin').toBe(true);

  try {
    await page.reload();
    // The notes box sits at the foot of the timeline since 30 September 2026.
    const notes = page.getByTestId('note-dock');
    await expect(notes).toBeVisible({ timeout: 40_000 });

    const chip = notes.getByRole('button', { name: `+ ${phrase}` });
    await expect(chip, 'a phrase added in the dropdown is not offered on the record').toBeVisible();

    const box = notes.getByRole('textbox', { name: /Add a note/ });
    await chip.click();
    await expect(box).toHaveValue(phrase);

    /*
      Twice is once. The chips exist to write faster, and a note repeating
      itself is a note somebody has to go back and edit — which is slower than
      not using them at all.
    */
    await chip.click();
    await expect(box).toHaveValue(phrase);
  } finally {
    await page.evaluate(async (gone) => {
      const token = localStorage.getItem('ipropy.token');
      await fetch(`/api/meta/picklists/note_snippet/values?value=${encodeURIComponent(gone)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
    }, phrase);
  }
});
