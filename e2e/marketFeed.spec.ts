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

  // The call sheet leads; the full list is one tab over.
  await page.getByRole('tab', { name: 'All deals' }).click();

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

// The call sheet: a buyer in one group and a seller in another, who only we can introduce.
// Two groups, unique marker and unique numbers per run. The sector is part of the
// marker, because a match needs the same area and a fixed one would pair with
// whatever earlier runs left in the database.
test('a buyer and a seller in different groups appear as a call, and what was done is kept', async ({ page }) => {
  const stamp = Date.now();
  const sector = `${stamp % 900 + 100}`;
  const buyerPhone = `98${String(stamp).slice(-8)}`;
  const sellerPhone = `97${String(stamp).slice(-8)}`;
  const now = new Date();
  const day = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
  const buyers = `${day}, 9:05 am - E2E Buyer ${stamp}: Required 250 gaj plot sector ${sector} budget 4 cr call ${buyerPhone}`;
  const sellers = `${day}, 10:20 am - E2E Seller ${stamp}: 260 sq yd residential plot for sale sector ${sector} demand 3.5 cr call ${sellerPhone}`;

  await page.goto('/market');
  for (const [group, text] of [[`E2E Buyers ${stamp}`, buyers], [`E2E Sellers ${stamp}`, sellers]] as const) {
    await page.getByPlaceholder('Group name, e.g. Greenfields Dealers').fill(group);
    await page.getByLabel('Exported chat file').setInputFiles({ name: 'chat.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
    await page.getByRole('button', { name: 'Read the deals' }).click();
    await expect(page.getByText(new RegExp(`1 new deal from ${group}`))).toBeVisible();
  }

  // Calls today is the tab the page opens on.
  await expect(page.getByRole('tab', { name: 'Calls today', selected: true })).toBeVisible();
  const call = page.locator('li', { hasText: `E2E Buyer ${stamp}` });
  await expect(call).toContainText(`E2E Seller ${stamp}`);
  await expect(call).toContainText(`sector ${sector}`);
  await expect(call.getByRole('link', { name: buyerPhone })).toBeVisible();
  await expect(call.getByRole('link', { name: sellerPhone })).toBeVisible();

  // Marking it is kept on the server: a reload is the only proof of that.
  await call.getByRole('button', { name: 'Called', exact: true }).click();
  await expect(call.getByText('Called').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('li', { hasText: `E2E Buyer ${stamp}` }).getByText('Called').first()).toBeVisible();

  // Not for us takes it off the list.
  await page.locator('li', { hasText: `E2E Buyer ${stamp}` }).getByRole('button', { name: 'Not for us' }).click();
  await expect(page.locator('li', { hasText: `E2E Buyer ${stamp}` })).toHaveCount(0);

  // Both dealers are listed on the Dealers tab.
  await page.getByRole('tab', { name: 'Dealers' }).click();
  await expect(page.getByText(`E2E Seller ${stamp}`)).toBeVisible();
  await page.screenshot({ path: 'test-results/market-introductions.png', fullPage: true });
});
