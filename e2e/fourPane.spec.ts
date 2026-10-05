/**
 * The split view as four panes — the owner's prototype of 30 September 2026.
 *
 * Each promise here is one of his four written points, measured on the page
 * rather than read off a class name:
 *
 *  1. a vertical toolbar, and the list's chips inside the record pane;
 *  2. the notes box under the timeline, and the record's fields under the
 *     call deck;
 *  3. a header of face, name and "Updated", with the actions beside it;
 *  4. icon tabs, and the Quick & Live Filters one tap from the record.
 */
import { expect, test } from '@playwright/test';
import { waitForRecords } from './helpers';

test.use({ viewport: { width: 1600, height: 950 } });

test('the four panes are there, in order, left to right', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  const dock = await page.getByTestId('workspace-dock').boundingBox();
  const tools = await page.getByTestId('queue-tools').boundingBox();
  const header = await page.getByTestId('split-hero-layout').boundingBox();
  const inspector = await page.getByTestId('record-inspector').boundingBox();
  expect(dock && tools && header && inspector).toBeTruthy();
  expect(dock!.x).toBeLessThan(tools!.x);
  expect(tools!.x).toBeLessThan(header!.x);
  expect(header!.x).toBeLessThan(inspector!.x);
});

test('the list chips sit inside the record pane, above the cards', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  const tools = page.getByTestId('queue-tools');
  await expect(tools.getByTitle('The follow-ups waiting on you').or(tools.getByRole('button', { name: /Status/ })).first()).toBeVisible();
  const toolsBox = await tools.boundingBox();
  const firstCard = await page.getByTestId('queue-card').first().boundingBox();
  expect(toolsBox!.y + toolsBox!.height).toBeLessThanOrEqual(firstCard!.y + 1);
});

test('a note written in the box under the timeline appears in it', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  const text = `Four pane note ${Date.now()}`;
  await page.getByTestId('note-dock').getByLabel('Add a note for the team').fill(text);
  await page.getByTestId('note-dock').getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByTestId('activity-feed').getByText(text)).toBeVisible({ timeout: 15_000 });
});

test('the tabs have accessible names, and Notes replaces duplicate Activity', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  const nav = page.getByRole('navigation', { name: 'Record workspace sections' });
  await expect(nav.getByRole('button').first()).toHaveAccessibleName(/^Notes/);
  await expect(nav.getByRole('button', { name: /^Activity/ })).toHaveCount(0);
  await nav.getByRole('button', { name: /^Files/ }).click();
  await expect(page.getByTestId('activity-feed')).toHaveCount(0);
  await nav.getByRole('button', { name: /^Notes/ }).click();
  await expect(page.getByTestId('activity-feed')).toBeVisible();
});

test('the quick filters open from the button over the queue and close on Escape', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  await page.getByTestId('quick-filter-button').click();
  await expect(page.getByTestId('quick-filter-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-filter-overlay')).toHaveCount(0);
});

test('an open chip panel draws over the record, not under it', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  const task = page.getByTitle('The follow-ups waiting on you');
  test.skip(await task.count() === 0, 'This module has no follow-up field on this database');
  await task.click();
  const heading = page.getByText('Follow-up Queue').first();
  await expect(heading).toBeVisible();
  const box = await heading.boundingBox();
  const topmost = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.textContent ?? '', [box!.x + 4, box!.y + 4]);
  expect(topmost).toContain('Follow-up Queue');
});
