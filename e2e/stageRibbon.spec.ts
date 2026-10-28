/**
 * The stage ribbon above the panes, which replaced the stage section of the
 * Quick & Live Filters overlay (removed 26 October 2026, #158) and the list
 * picker beside it. Same promises, asked of the screen that carries them now:
 * one click narrows the list on the server, and "All" puts every record back.
 */
import { expect, test, type Request } from '@playwright/test';
import { waitForRecords } from './helpers';

test.use({ viewport: { width: 1600, height: 950 } });

// `columns` is what only the table asks for; the other searches on the page
// (counts, facets) share the URL.
function isListSearch(r: Request): boolean {
  return r.url().includes('/api/records/leads/search') && r.method() === 'POST' && Array.isArray(r.postDataJSON()?.columns);
}

test('one stage is one click, it reaches the list as an `in`, and All takes it off', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  const ribbon = page.getByTestId('pipeline-stage-ribbon');
  const stages = ribbon.getByRole('group', { name: 'Filter by stage options' }).getByRole('button');
  expect(await stages.count(), 'the ribbon should offer All and the stages').toBeGreaterThan(1);

  const search = page.waitForRequest((r) => isListSearch(r) && JSON.stringify(r.postDataJSON()?.filter ?? '').includes('"in"'));
  await stages.nth(1).click();
  const conditions = (await search).postDataJSON().filter?.conditions ?? [];
  const stage = conditions.find((c: { operator?: string }) => c.operator === 'in');
  expect(stage, JSON.stringify(conditions)).toBeTruthy();
  expect(stage.value).toHaveLength(1);
  await expect(stages.nth(1)).toHaveAttribute('aria-pressed', 'true');

  await stages.first().click();
  await expect(stages.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(stages.nth(1)).toHaveAttribute('aria-pressed', 'false');
});

test('the counts on the stages add up to the whole list or less, never more', async ({ page }) => {
  await page.goto('/leads');
  await waitForRecords(page);
  const ribbon = page.getByTestId('pipeline-stage-ribbon');
  const buttons = ribbon.getByRole('group', { name: 'Filter by stage options' }).getByRole('button');
  const all = Number((await buttons.first().innerText()).replace(/[^\d]/g, ''));
  let sum = 0;
  for (let i = 1; i < await buttons.count(); i++) {
    const title = (await buttons.nth(i).getAttribute('title')) ?? '';
    sum += Number((/: ([\d,]+) records/.exec(title)?.[1] ?? '0').replace(/,/g, ''));
  }
  expect(sum).toBeLessThanOrEqual(all);
});
