import { test, expect } from '@playwright/test';

// Dealer groups: a WhatsApp export goes in through the page, and the deals it
// held come out as cards a rep can filter. Unique marker per run, so the spec
// never depends on what is already in the database.
test('a group export becomes searchable deals', async ({ page }) => {
  const marker = `e2emkt${Date.now()}`;
  // Today's date: the page shows the last 90 days, so a fixed old date would fade out.
  const now = new Date();
  const day = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
  const exportText = [
    `${day}, 10:16 am - Ramesh Dealer: 3 BHK available ${marker} Greenfields, 1.45 Cr, call 9811012345`,
    `${day}, 10:17 am - Sita Realty: ok`,
    `${day}, 11:02 am - Sita Realty: Required 2 bhk ${marker} budget 70-80 lac`,
  ].join('\n');

  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Dealer groups' })).toBeVisible();
  await page.getByPlaceholder('Group name, e.g. Greenfields Dealers').fill('E2E Dealers');
  await page.getByLabel('Exported chat file').setInputFiles({ name: 'chat.txt', mimeType: 'text/plain', buffer: Buffer.from(exportText) });
  await page.getByRole('button', { name: 'Read the deals' }).click();
  await expect(page.getByText(/2 new deals from E2E Dealers/)).toBeVisible();

  await page.getByPlaceholder('Any word in the post').fill(marker);
  await expect(page.getByText(/^2 deals/)).toBeVisible();
  await page.getByLabel('Has or wants').selectOption('have');
  await expect(page.getByText(/^1 deal/)).toBeVisible();
  await expect(page.getByRole('link', { name: '9811012345' })).toBeVisible();
  // The deal names no locality this database knows, so it fits nothing — and says why.
  await page.getByRole('button', { name: 'Which of our contacts want this?' }).click();
  await expect(page.getByText(/Matching needs a locality from your list/)).toBeVisible();
  await page.screenshot({ path: 'test-results/market-feed.png', fullPage: true });
});
