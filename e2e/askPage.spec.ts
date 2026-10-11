import { test, expect } from '@playwright/test';

// chat.ipropy.com is /ask on the chat host: the assistant as a whole screen.
test('the assistant opens as a full page and answers a question', async ({ page }) => {
  await page.goto('/ask');
  const panel = page.getByRole('main', { name: 'Ask iPropy' });
  await expect(panel).toBeVisible();
  const width = await panel.evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(900); // the whole window, not the side drawer
  await page.screenshot({ path: 'test-results/ask-page-empty.png' });
  const box = page.getByPlaceholder('Ask or tell iPropy what to do…');
  await box.fill('3 BHK under 1.5 crore in Greenfield');
  await box.press('Enter');
  await expect(page.getByText('3 BHK under 1.5 crore in Greenfield')).toBeVisible();
  await expect(page.getByText('Thinking from your CRM…')).toBeHidden({ timeout: 45_000 });
  await page.screenshot({ path: 'test-results/ask-page-answer.png' });
});
