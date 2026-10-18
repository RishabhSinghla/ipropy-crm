import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

/*
  The Archive is the module's own split view, showing archived records only —
  the owner, 10 October 2026: *"treated archived Folder as a archived module
  with full functioned module"*. A record is archived by the scheduler 12 hours
  after it goes Lost, which a browser test cannot wait for, so this pins the
  screen and its boundaries rather than a particular archived person.
*/
test('the archive opens as a split view per module, apart from the live list', async ({ page }) => {
  await page.goto('/leads');
  const card = page.getByTestId('queue-card').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const live = (await card.innerText()).split('\n')[0]!;

  await page.goto('/archive');
  await expect(page).toHaveURL(/\/archive\/leads/);
  await expect(page.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Archived modules' });
  await expect(tabs.getByRole('link', { name: 'Leads' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Change the status away from Lost to bring a record back to its module.')).toBeVisible();
  // The module list has either a numeric count or its explicit empty state.
  await expect(page.getByText(/^\d[\d,]*(?:–\d[\d,]*)? of \d[\d,]* records$/).or(page.getByRole('heading', { name: 'No matching records', exact: true })).first()).toBeVisible({ timeout: 30_000 });
  // A live record is never in the archive.
  await expect(page.getByTestId('queue-card').filter({ hasText: live })).toHaveCount(0);

  await tabs.getByRole('link', { name: 'Inventories' }).click();
  await expect(page).toHaveURL(/\/archive\/properties/);
  await expect(page.getByText(/^\d[\d,]*(?:–\d[\d,]*)? of \d[\d,]* records$/).or(page.getByRole('heading', { name: 'No matching records', exact: true })).first()).toBeVisible({ timeout: 30_000 });
});
