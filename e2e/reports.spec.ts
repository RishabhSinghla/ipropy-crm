/**
 * Reports: a question, an answer, and a name to keep it under.
 *
 * The things only a browser proves: that the screen answers *without* being
 * configured first (a report page that opens empty and asks for four choices
 * is a report page nobody uses), that saving puts it in the list and reloading
 * brings it back, and that Reports is reachable at all — its header entry is
 * appended to an arrangement saved before the page existed, which is exactly
 * the bug that hid Chats on production and nowhere else.
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1500, height: 950 } });

test('it answers a question before anybody configures one', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 30_000 });

  // The sentence above the answer says what is being counted, in words.
  await expect(page.getByText(/How many · .+ · by /)).toBeVisible({ timeout: 20_000 });
  // And an answer, not an empty frame: the shipped default groups contacts by
  // their pipeline stage, and this database always has some.
  await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 20_000 });
});

test('a saved report comes back after a reload, and can be deleted', async ({ page }) => {
  const name = `E2E report ${Date.now()}`;
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder('Contacts by status this month').fill(name);
  await page.getByRole('button', { name: /^Save report$/ }).click();
  await expect(page.getByRole('button', { name })).toBeVisible({ timeout: 15_000 });

  // Saved on the server, not in this tab: a reload is the only proof of that.
  await page.reload();
  await page.getByRole('button', { name }).click();
  await expect(page.getByPlaceholder('Contacts by status this month')).toHaveValue(name);

  await page.getByRole('button', { name: /^Delete/ }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(page.getByRole('button', { name })).toHaveCount(0, { timeout: 15_000 });
});

test('the WhatsApp half counts what the number did', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'WhatsApp' }).click();
  // Either real numbers or an honest empty state — both are correct answers,
  // and which one depends on the database this is run against.
  await expect(
    page.getByText(/sent · .* received/).or(page.getByText('No messages yet')),
  ).toBeVisible({ timeout: 20_000 });
});

/*
  Reports moved inside the WhatsApp page on 20 September 2026, on the owner's
  instruction, so it is no longer in the module switcher. The promise this
  spec exists for is unchanged and is the one that matters: **a screen you can
  only reach by typing a URL is a screen nobody uses.** So it now walks the
  route a person actually takes — the green WhatsApp button on the header,
  then the Reports tab.
*/
test('Reports is reachable from the navigation, not only by URL', async ({ page }) => {
  await page.goto('/dashboard');
  /*
    By href, not by name: a dashboard row carrying a phone number has its own
    "WhatsApp" link on it, and a locator that matches both fails on how the
    database happens to look rather than on anything about this navigation.
  */
  await page.locator('a[href="/whatsapp"]').first().click();
  await expect(page).toHaveURL(/\/whatsapp\//);
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/whatsapp\/reports$/);
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 30_000 });
});
