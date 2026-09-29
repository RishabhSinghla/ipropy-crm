/**
 * Save & next moves to the next record — it does not reload the whole CRM.
 *
 * **28 September 2026, the owner:** *"When we Click Save and Next from the
 * Call deck, then the new window open in same window of entire CRM instead of
 * Next record."* It used `window.location.assign`, so between one call and the
 * next a rep watched the app boot: sign-in, metadata, every chunk.
 *
 * **Only a browser can settle this**, and only by measuring the one thing that
 * tells a reload from a navigation: a value written into the page's own
 * `window` survives a React Router move and cannot survive a reload. A unit
 * test would be asserting that a line of code was written.
 */
import { test, expect, type Page } from '@playwright/test';

async function openQueue(page: Page): Promise<void> {
  await page.goto('/leads');
  await expect(page.getByText(/^[\d,]+(–[\d,]+)? of [\d,]+ records$/)).toBeVisible({ timeout: 30_000 });
}

/** A call on whichever record the queue opened, as the deck's own specs stage one. */
async function stageCall(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const fetched = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /\/api\/records\/leads\/[0-9a-f-]{36}$/.test(url));
    const recordId = fetched[0]?.split('/').pop();
    if (!recordId) throw new Error('no record was open to put a call on');
    const me = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${localStorage.getItem('ipropy.token')}` },
    }).then((res) => res.json() as Promise<{ user?: { id: string }; id?: string }>);
    localStorage.setItem('ipropy.liveCall', JSON.stringify({
      number: '+919999999999', module: 'leads', recordId,
      userId: me.user?.id ?? me.id,
      followUpField: 'next_followup_at',
      pressedAt: Date.now() - 95_000, placing: false, outcome: null,
      /*
        The queue the rep pressed Call from. **Without it there is no next
        record at all**, so Save & next saves and stays put — and a spec that
        leaves it out passes against the very bug it is here to catch, because
        the URL still changes when the workspace writes `open=`.
      */
      queueUrl: '/leads', queuePosition: 1,
    }));
  });
  await page.reload();
  await page.getByTestId('call-deck-panel').waitFor({ timeout: 30_000 });
}

test.afterEach(async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem('ipropy.liveCall')).catch(() => {});
});

test('Save & next keeps the app running and lands on another record', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openQueue(page);
  await stageCall(page);

  const before = page.url();
  // A mark only this page can carry. A reload wipes it; a navigation does not.
  await page.evaluate(() => { (window as unknown as { __stillHere?: number }).__stillHere = 1; });

  const next = page.getByRole('button', { name: /Save\s*&\s*(dial\s*)?next/i });
  await expect(next).toBeVisible();
  await next.click();

  // It handed over to another record, and the queue is on screen again.
  await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/[?&]open=[0-9a-f-]{36}/);
  await expect(page.getByTestId('ipropy-workspace')).toBeVisible({ timeout: 30_000 });
  expect(page.url()).not.toBe(before);

  // And the app never restarted.
  expect(
    await page.evaluate(() => (window as unknown as { __stillHere?: number }).__stillHere ?? 0),
    'Save & next reloaded the whole CRM instead of moving to the next record',
  ).toBe(1);
});
