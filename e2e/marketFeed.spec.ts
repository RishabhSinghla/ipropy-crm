import AxeBuilder from '@axe-core/playwright';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Dealer groups: a WhatsApp export goes in through the page, and the deals it
// held come out as cards a rep can filter. Unique marker per run, so the spec
// never depends on what is already in the database.
test('a group export becomes searchable deals', async ({ page }) => {
  const marker = `e2emkt${Date.now()}`;
  // A group read before is read only from where it ended, so each run needs a group of its own.
  const group = `E2E Dealers ${marker}`;
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
  // The group is named from the file: WhatsApp calls it "WhatsApp Chat with <group>.txt".
  await page.getByLabel('Exported chat files').setInputFiles({ name: `WhatsApp Chat with ${group}.txt`, mimeType: 'text/plain', buffer: Buffer.from(exportText) });
  const row = page.getByTestId('market-imports').locator('li', { hasText: group }).first();
  await expect(row).toContainText('Done', { timeout: 30_000 });
  await expect(row).toContainText('2 new messages');
  await expect(row).toContainText('properties found');

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
  // Real sectors run 1 to 150; anything higher is not read as a sector at all.
  const sector = `${stamp % 130 + 10}`;
  const buyerPhone = `98${String(stamp).slice(-8)}`;
  const sellerPhone = `97${String(stamp).slice(-8)}`;
  const now = new Date();
  const day = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
  const buyers = `${day}, 9:05 am - E2E Buyer ${stamp}: Required 250 gaj plot sector ${sector} budget 4 cr call ${buyerPhone}`;
  const sellers = `${day}, 10:20 am - E2E Seller ${stamp}: 260 sq yd residential plot for sale sector ${sector} demand 3.5 cr call ${sellerPhone}`;

  await page.goto('/market');
  // Two groups in one drop, each named from its own file.
  await page.getByLabel('Exported chat files').setInputFiles([
    { name: `WhatsApp Chat with E2E Buyers ${stamp}.txt`, mimeType: 'text/plain', buffer: Buffer.from(buyers) },
    { name: `WhatsApp Chat with E2E Sellers ${stamp}.txt`, mimeType: 'text/plain', buffer: Buffer.from(sellers) },
  ]);
  for (const group of [`E2E Buyers ${stamp}`, `E2E Sellers ${stamp}`]) {
    await expect(page.getByTestId('market-imports').locator('li', { hasText: group })).toContainText('Done', { timeout: 30_000 });
  }

  // Calls today is the tab the page opens on.
  await expect(page.getByRole('tab', { name: 'Calls today', selected: true })).toBeVisible();
  const call = page.locator('li', { hasText: `E2E Buyer ${stamp}` });
  await expect(call).toContainText(`E2E Seller ${stamp}`);
  await expect(call).toContainText(`sector ${sector}`);
  await expect(call.getByRole('link', { name: buyerPhone })).toBeVisible();
  await expect(call.getByRole('link', { name: sellerPhone })).toBeVisible();

  // A card shows the property's own lines; the whole message opens in a popup.
  await call.getByRole('button', { name: 'Read full message' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('full-message')).toContainText(`Required 250 gaj plot sector ${sector}`);
  await expect(dialog).toContainText(`E2E Buyer ${stamp}`);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

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

// An Associate's page: the four things a dealer posts, each in a tab of its own.
// Needs the Associates module, which a brand-new database does not have (see CLAUDE.md,
// migration 175) — there the spec says so and stops rather than failing for no fault of the tabs.
test.use({ viewport: { width: 1500, height: 950 } });

/** An Associate who has posted five properties in a group: two to sell, one to let, one buyer, one tenant. */
async function dealerWithDeals(page: Page, request: APIRequestContext): Promise<{ recordId: string; place: string; auth: { Authorization: string } }> {
  await page.goto('/market');
  const token = await page.evaluate(() => localStorage.getItem('ipropy.token'));
  const auth = { Authorization: `Bearer ${token}` };

  const meta = await request.get('/api/meta/modules/associates', { headers: auth });
  test.skip(!meta.ok(), 'This database has no Associates module');
  const module = await meta.json() as { fields: Array<{ name: string; options?: Array<{ value: string }> }> };
  const place = module.fields.find((f) => f.name === 'preferred_locations')?.options?.[0]?.value;
  test.skip(!place, 'Associates has no locations to choose from');

  const stamp = Date.now();
  const phone = `97${String(stamp).slice(-8)}`;
  const dealer = `E2E Dealer ${stamp}`;
  const now = new Date();
  const day = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
  const text = [
    `${day}, 12:00 pm - ${dealer}: 150 gaj plot for sale ${place} demand 2.1 cr call ${phone}`,
    `${day}, 12:01 pm - ${dealer}: 200 gaj plot for sale ${place} demand 2.8 cr call ${phone}`,
    `${day}, 12:02 pm - ${dealer}: 2 BHK flat available on rent ${place} 22000 per month call ${phone}`,
    `${day}, 12:03 pm - ${dealer}: Tenant required 3 BHK builder floor ${place} budget 30000 call ${phone}`,
    `${day}, 12:04 pm - ${dealer}: Required 300 gaj plot ${place} budget 5 cr call ${phone}`,
  ].join('\n');

  const imported = await request.post('/api/market/import', {
    headers: auth,
    multipart: { group: `E2E Dealer Group ${stamp}`, file: { name: 'chat.txt', mimeType: 'text/plain', buffer: Buffer.from(text) } },
  });
  expect(imported.ok()).toBeTruthy();

  // The upload adds dealers on its own, in the background — wait for this one to exist.
  let recordId = '';
  await expect.poll(async () => {
    const list = await request.get(`/api/records/associates?search=${phone}&limit=5`, { headers: auth });
    const rows = (await list.json() as { rows?: Array<{ id: string }> }).rows ?? [];
    recordId = rows[0]?.id ?? '';
    return recordId;
  }, { timeout: 30_000 }).not.toBe('');
  return { recordId, place, auth };
}

test('an Associate shows what the dealer posted in two tabs', async ({ page, request }) => {
  const { recordId, place } = await dealerWithDeals(page, request);

  await page.goto(`/associates?open=${recordId}`);
  const tabs = page.getByTestId('record-menu-bar');
  // Counts sit on the tabs themselves: two to sell and one to let are three available, a buyer and a tenant are two wanted.
  await expect(tabs.getByRole('button', { name: /^Availability \(3\)$/ })).toBeVisible({ timeout: 20_000 });
  await expect(tabs.getByRole('button', { name: /^Requirement \(2\)$/ })).toBeVisible();
  await expect(tabs.getByRole('button', { name: /^For Sale/ })).toHaveCount(0);

  await tabs.getByRole('button', { name: /^Availability/ }).click();
  await expect(page.getByText(/Residential Plot · 150 yd/)).toBeVisible();
  await expect(page.getByText(/Residential Plot · 200 yd/)).toBeVisible();
  await expect(page.getByText(/2 BHK flat available on rent/)).toBeVisible();
  // View opens the whole message the property came from.
  await page.getByRole('row', { name: /150 yd/ }).getByTestId('deal-more').click();
  await page.getByTestId('deal-view').click();
  await expect(page.getByRole('dialog').getByTestId('full-message')).toContainText(`150 gaj plot for sale ${place}`);
  await page.keyboard.press('Escape');
  await tabs.getByRole('button', { name: /^Requirement/ }).click();
  await expect(page.getByText(/Tenant required 3 BHK builder floor/)).toBeVisible();
  await expect(page.getByText(/Required 300 gaj plot/)).toBeVisible();
  // The messages are in the dealer's notes too, each said to belong to the tabs it fills.
  await tabs.getByRole('button', { name: /^Notes/ }).click();
  await expect(page.getByText(/💬 WhatsApp · E2E Dealer Group/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/💬 WhatsApp · E2E Dealer Group/).first()).toContainText('For Sale');
  await page.screenshot({ path: 'test-results/associate-deal-tabs.png' });
});

test('the deal table filters by column, one line a row, and each row has its own form', async ({ page, request }) => {
  const { recordId } = await dealerWithDeals(page, request);
  await page.goto(`/associates?open=${recordId}`);
  await page.getByTestId('record-menu-bar').getByRole('button', { name: /^Availability/ }).click();
  const table = page.getByTestId('associate-deals-table');
  await expect(table.getByTestId('deal-row')).toHaveCount(3, { timeout: 20_000 });

  // Excel-style: a filter under every column heading, and a row never wraps onto a second line.
  await expect(table.getByTestId('deal-filters')).toBeVisible();
  const heights = await table.getByTestId('deal-row').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBeLessThan(48);
  await expect(table.getByText('Posted Date')).toBeVisible();

  // For Sale / For Rent is one column, and filters.
  await table.getByLabel('Filter by For Sale or For Rent').selectOption('rent');
  await expect(table.getByTestId('deal-row')).toHaveCount(1);
  await expect(table.getByTestId('deal-count')).toContainText('1 of 3');
  await table.getByRole('button', { name: /Clear 1 filter/ }).click();
  await expect(table.getByTestId('deal-row')).toHaveCount(3);

  // The row's own form: fill a box, leave it, and it is still there after a reload.
  await table.getByRole('row', { name: /150 yd/ }).getByTestId('deal-more').click();
  await page.getByTestId('deal-edit').click();
  const form = page.getByTestId('deal-form');
  await expect(form).toBeVisible();
  const houseNo = `B-${String(Date.now()).slice(-4)}`;
  await form.getByLabel('House / Unit No.').fill(houseNo);
  await form.getByLabel('Portion').fill('Ground');
  await form.getByLabel('Portion').blur();
  await expect(form.getByTestId('deal-form-state')).toHaveText('Saved', { timeout: 15_000 });
  await page.screenshot({ path: 'test-results/associate-deal-form-open.png' });

  // Readable in both themes: the table, its filter row and the form, scanned as they stand.
  const scan = async (): Promise<string[]> => {
    const { violations } = await new AxeBuilder({ page })
      .include('[data-testid="associate-deals-table"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    return violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`);
  };
  expect(await scan(), 'light theme').toEqual([]);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  expect(await scan(), 'dark theme').toEqual([]);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  // None of the dealer's own details is on a property's form.
  await expect(form.getByLabel(/^Mobile/)).toHaveCount(0);
  await expect(form.getByLabel(/Assigned To/)).toHaveCount(0);
  await expect(form.getByLabel(/Contact Type/)).toHaveCount(0);

  await page.reload();
  await page.getByTestId('record-menu-bar').getByRole('button', { name: /^Availability/ }).click();
  await expect(table.getByRole('row', { name: new RegExp(houseNo) })).toBeVisible({ timeout: 20_000 });
  await table.getByLabel('Filter by house number').fill(houseNo.toLowerCase());
  await expect(table.getByTestId('deal-row')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/associate-deal-form.png' });
});

test('rows can be ticked, compared, duplicated and removed', async ({ page, request }) => {
  const { recordId } = await dealerWithDeals(page, request);
  await page.goto(`/associates?open=${recordId}`);
  await page.getByTestId('record-menu-bar').getByRole('button', { name: /^Availability/ }).click();
  const table = page.getByTestId('associate-deals-table');
  await expect(table.getByTestId('deal-row')).toHaveCount(3, { timeout: 20_000 });

  // Matching, with its count, is in each row's three-dot menu.
  await table.getByTestId('deal-more').first().click();
  await expect(page.getByTestId('deal-matching')).toBeVisible();
  await expect(page.getByTestId('deal-match-count')).toHaveText(/^\d+$/, { timeout: 20_000 });
  await page.keyboard.press('Escape');

  // Tick two and compare.
  await table.getByTestId('deal-select').nth(0).check();
  await table.getByTestId('deal-select').nth(1).check();
  await expect(table.getByTestId('deal-bulk-bar')).toContainText('2 selected');
  await table.getByTestId('deal-bulk-bar').getByRole('button', { name: 'Compare' }).click();
  await expect(page.getByTestId('deal-compare-table')).toBeVisible();
  await page.keyboard.press('Escape');

  // Duplicate the first row: one more on the list.
  await table.getByTestId('deal-bulk-bar').getByRole('button', { name: 'Clear' }).click();
  await table.getByTestId('deal-more').first().click();
  await page.getByTestId('deal-duplicate').click();
  await expect(table.getByTestId('deal-row')).toHaveCount(4, { timeout: 15_000 });

  // Remove one: it leaves the list, and stays gone after a reload.
  await table.getByTestId('deal-more').first().click();
  await page.getByTestId('deal-delete').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(table.getByTestId('deal-row')).toHaveCount(3, { timeout: 15_000 });
  await page.reload();
  await page.getByTestId('record-menu-bar').getByRole('button', { name: /^Availability/ }).click();
  await expect(table.getByTestId('deal-row')).toHaveCount(3, { timeout: 20_000 });
});

test('Admin -> Layouts chooses the deal columns and the form fields, and a field can be added', async ({ page, request }) => {
  test.setTimeout(150_000);
  const { recordId } = await dealerWithDeals(page, request);
  const designer = async (): Promise<void> => {
    await page.goto('/admin/layouts');
    await page.locator('select').filter({ has: page.locator('option[value="associates"]') }).first().selectOption('associates');
    await expect(page.getByTestId('zone-associate-deal-columns')).toBeVisible({ timeout: 20_000 });
  };
  const save = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 15_000 });
  };

  await designer();
  try {
    const columns = page.getByTestId('zone-associate-deal-columns');
    const form = page.getByTestId('zone-associate-deal-form');
    // House number and For Sale / For Rent are columns an admin can switch off and on.
    await expect(columns.getByLabel('House / Unit No.')).toBeChecked();
    await expect(columns.getByLabel('For Sale / For Rent')).toBeChecked();
    await columns.getByLabel('Facing').uncheck();
    await form.getByLabel('Lost Reason').uncheck();
    await form.getByLabel('Name for a new deal form field').fill('Owner name');
    await form.getByRole('button', { name: 'Add field' }).click();
    await expect(form.getByLabel('Name of the field Owner name')).toBeVisible();
    await save();

    await page.goto(`/associates?open=${recordId}`);
    await page.getByTestId('record-menu-bar').getByRole('button', { name: /^Availability/ }).click();
    const table = page.getByTestId('associate-deals-table');
    await expect(table.getByTestId('deal-row')).toHaveCount(3, { timeout: 20_000 });
    await expect(table.getByRole('columnheader', { name: /^Facing/ })).toHaveCount(0);
    await expect(table.getByRole('columnheader', { name: /^House \/ Unit No\./ })).toBeVisible();

    await table.getByTestId('deal-more').first().click();
    await page.getByTestId('deal-edit').click();
    const rowForm = page.getByTestId('deal-form');
    await expect(rowForm.getByLabel('Lost Reason')).toHaveCount(0);
    await rowForm.getByLabel('Owner name').fill('Mr Sharma');
    await rowForm.getByLabel('Owner name').blur();
    await expect(rowForm.getByTestId('deal-form-state')).toHaveText('Saved', { timeout: 15_000 });
    await page.reload();
    await page.getByTestId('record-menu-bar').getByRole('button', { name: /^Availability/ }).click();
    await table.getByTestId('deal-more').first().click();
    await page.getByTestId('deal-edit').click();
    await expect(page.getByTestId('deal-form').getByLabel('Owner name')).toHaveValue('Mr Sharma', { timeout: 20_000 });
  } finally {
    // The layout is shared by everybody on this database: put it back however the test ended.
    await designer();
    for (const zone of ['zone-associate-deal-columns', 'zone-associate-deal-form']) {
      const reset = page.getByTestId(zone).getByRole('button', { name: 'Default' });
      if (await reset.count()) await reset.click();
    }
    await save().catch(() => undefined);
  }
});
