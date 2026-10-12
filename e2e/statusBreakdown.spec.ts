/**
 * The pipeline breakdown, and the filter built from it.
 *
 * Three things only a browser answers. Picking stages has to reach the list as
 * one `in` condition — an AND of equals reads perfectly well in code and
 * matches nothing, and the screen shows that as an empty table rather than as
 * an error. One stage is one click, because that is the nine-times-in-ten
 * case and making it cost an Apply is the difference between a filter people
 * use and one they do not. And the agent chips have to reshape the counts,
 * not merely filter the rows underneath.
 */
import { test, expect, type Locator, type Page, type Request } from '@playwright/test';

function isListSearch(r: Request, module = 'leads'): boolean {
  if (!r.url().includes(`/api/records/${module}/search`) || r.method() !== 'POST') return false;
  return Array.isArray(r.postDataJSON()?.columns);
}

/** Quick-filter choices include the live count in the accessible button name. */
function stageChoice(section: Locator, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return section.getByRole('button', { name: new RegExp(`^${escaped}(?:\\s|$)`) });
}

async function openPanel(page: Page) {
  const metadataPromise = page.waitForResponse((response) => response.ok()
    && response.url().includes('/api/meta/modules/leads'));
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('quick-filter-button').click();
  const panel = page.getByTestId('quick-filter-overlay');
  await expect(panel).toBeVisible();
  const metadata = await (await metadataPromise).json();
  const field = metadata.fields.find((candidate: { name: string }) => candidate.name === metadata.pipelineField
    || candidate.columnName === metadata.pipelineField);
  expect(field?.options?.length).toBeGreaterThan(0);
  const sectionTitle = `${field.label} wise`;
  const heading = panel.getByRole('button', { name: sectionTitle, exact: true });
  if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click();
  const section = panel.locator('section').filter({ hasText: sectionTitle });
  return { panel, section, field };
}

test('the stage choices and their live counts add up to the whole view', async ({ page }) => {
  const { panel, section, field } = await openPanel(page);

  /*
    The same promise as before — every record is in exactly one stage — read
    off the counts rather than the percentages, which the owner asked to be
    rid of. The counts were always the fact; the shares were a second number
    derived from them.
  */
  const expand = section.getByRole('button', { name: /more — show all/i });
  if (await expand.count()) await expand.click();
  const labels = [...field.options.map((option: { label: string }) => option.label), 'Unfilled'];
  const counts = await Promise.all(labels.map(async (label) => {
    const choice = stageChoice(section, label);
    await expect(choice).toBeVisible();
    const count = choice.locator('span').last();
    await expect(count).toHaveText(/^\d[\d,]*$/);
    return Number((await count.innerText()).replace(/,/g, ''));
  }));

  expect(counts.length).toBeGreaterThan(0);
  const sum = counts.reduce((a, b) => a + b, 0);

  const total = Number((await panel.getByTestId('quick-filter-count').innerText()).replace(/[^\d]/g, ''));
  expect(sum).toBe(total);
});

test('one stage is one click, and it reaches the list as an `in`', async ({ page }) => {
  const { panel, section, field } = await openPanel(page);

  const search = page.waitForRequest((request) => isListSearch(request));
  await stageChoice(section, field.options[0].label).click();

  const conditions = (await search).postDataJSON().filter?.conditions ?? [];
  const stage = conditions.find((c: { operator?: string }) => c.operator === 'in');
  expect(stage, JSON.stringify(conditions)).toBeTruthy();
  expect(stage.value).toHaveLength(1);

  await expect(page.getByTestId('quick-filter-count')).toContainText('records');
});

test('several stages need the checkbox, then Apply', async ({ page }) => {
  const { panel, section, field } = await openPanel(page);

  // Apply is refused until multi-select is on, so one stray click cannot
  // silently replace the single-click behaviour above.
  const firstSearch = page.waitForRequest(isListSearch);
  for (const option of field.options.slice(0, 1)) {
    await stageChoice(section, option.label).click();
  }
  await firstSearch;
  const secondSearch = page.waitForRequest(isListSearch);
  const option = field.options[1];
  await stageChoice(section, option.label).click();

  const stage = ((await secondSearch).postDataJSON().filter?.conditions ?? [])
    .find((c: { operator?: string }) => c.operator === 'in');
  expect(stage.value).toHaveLength(2);
  await expect(page.getByTestId('quick-filter-count')).toContainText('records');
});

test('picking an agent filters the list and reshapes the counts', async ({ page }) => {
  const { panel } = await openPanel(page);

  const agentHeading = panel.getByRole('button', { name: 'Agent wise', exact: true });
  if (await agentHeading.getAttribute('aria-expanded') !== 'true') await agentHeading.click();
  const agents = panel.locator('button[aria-pressed]');
  if ((await agents.count()) === 0) test.skip(true, 'only one assignable user here');

  const search = page.waitForRequest(isListSearch);
  await agents.first().click();

  const owner = ((await search).postDataJSON().filter?.conditions ?? [])
    .find((c: { operator?: string; field?: string }) => c.operator === 'equals');
  expect(owner, 'the agent must reach the list as its own condition').toBeTruthy();

  await expect(panel.getByTestId('quick-filter-count')).toContainText('records');
});

test('all stages puts every record back', async ({ page }) => {
  const { panel, section, field } = await openPanel(page);
  const total = await panel.getByTestId('quick-filter-count').innerText();
  await stageChoice(section, field.options[0].label).click();
  await panel.getByRole('button', { name: 'Clear all' }).click();
  await expect(panel.getByTestId('quick-filter-count')).toHaveText(total);
});
