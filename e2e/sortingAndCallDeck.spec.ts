/**
 * The toolbar, the sort menu and the call deck, in a real browser.
 *
 * **27 September 2026, the owner**, six things in one message and *"Keep in
 * Mind All Following or below work for Both Module Leads & Inventory Module"*.
 * So every promise here is checked on Contacts **and** on Inventories: the
 * screens share their components, and "it works on leads" is exactly how a
 * module gets left behind.
 *
 * What a browser is the only place to prove: that the buttons are on the row
 * at all, that the sort menu is the eight he named and not the module's fields,
 * that choosing one reaches the server, and that the deck's follow-up control
 * can be read rather than clipped at the panel's edge — which is what he sent a
 * screenshot of.
 */
import { expect, test, type Page } from '@playwright/test';

const MODULES = [
  { path: '/leads', label: 'Contacts' },
  { path: '/properties', label: 'Inventories' },
] as const;

/** Open a module on the split view, which is where all of this lives. */
async function openQueue(page: Page, path: string): Promise<void> {
  await page.addInitScript(() => {
    for (const module of ['leads', 'properties']) {
      localStorage.setItem(`ipropy.listmode.${module}`, 'ipropy');
    }
  });
  await page.goto(path);
  await page.getByTestId('ipropy-workspace').waitFor({ timeout: 40_000 });
  await expect(page.locator('text=/of [\\d,]+ records/').first()).toBeVisible();
}

for (const module of MODULES) {
  test.describe(module.label, () => {
    test('the filter buttons are on the row, call disposition after follow-ups', async ({ page }) => {
      await openQueue(page, module.path);

      const disposition = page.getByTestId('call-disposition-filter');
      await expect(disposition).toBeVisible();

      /*
        **Light at rest, filled and reversed to white once it is narrowing the
        list** — the owner, 29 September 2026. This used to assert white text
        at rest, which was his instruction of the 27th; the later one stands.

        Measured as *different*, not as two exact colours: the brand is an
        admin's to change, so pinning `rgb(76, 29, 149)` would make this a test
        of one theme rather than of the rule.
      */
      const rest = await disposition.evaluate((el) => {
        const style = getComputedStyle(el);
        return { fill: style.backgroundColor, text: style.color };
      });
      expect(rest.fill, 'a resting pill should still carry a light fill').not.toBe('rgba(0, 0, 0, 0)');
      expect(rest.text, 'a resting pill should not be reversed out to white').not.toBe('rgb(255, 255, 255)');

      // Turn it on: pick "never called", which every module can answer.
      await disposition.click();
      await page.getByText(/Never called/i).first().click();
      await expect.poll(
        async () => disposition.evaluate((el) => getComputedStyle(el).color),
        { timeout: 15_000, message: 'an active filter should reverse to white' },
      ).toBe('rgb(255, 255, 255)');
      const on = await disposition.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(on, 'an active filter should change fill, not just text').not.toBe(rest.fill);
    });

    test('the sort menu is the eight he named, and nothing is chosen to begin with', async ({ page }) => {
      await openQueue(page, module.path);

      const trigger = page.getByRole('button', { name: 'Sort this list' });
      // "The filter data are static records, these are not Dynamically sorting
      // Changes" — a list nobody has sorted must say so.
      await expect(trigger).toContainText('No sorting');

      await trigger.click();
      const menu = page.getByTestId('queue-sort-menu');
      await expect(menu).toContainText('Recently updated');
      await expect(menu).toContainText('Agent wise');
      await expect(menu).toContainText('Last call wise');
      await expect(menu).toContainText('Profile strength wise');
      // The field-based rows he asked to be deleted. Locality is a field on
      // both modules, so a menu built out of fields would still offer it.
      await expect(menu).not.toContainText('Locality');
    });

    test('choosing an order reaches the server, both ways round', async ({ page }) => {
      await openQueue(page, module.path);

      // The list goes out as a POST to /search — a filter is too big for a
      // query string — so what it asks for is in the body, not the address.
      const asked: string[] = [];
      await page.route('**/api/records/**', async (route) => {
        const body = route.request().postData();
        if (body?.includes('sortBy')) asked.push(body);
        await route.continue();
      });

      await page.getByRole('button', { name: 'Sort this list' }).click();
      await page.getByTestId('queue-sort-menu').getByText('Last call wise', { exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sort this list' })).toContainText('Last call wise');
      await expect.poll(() => asked.some((body) => body.includes('"sortBy":"last_call_at"'))).toBe(true);

      // A–Z and Z–A on the same order, which is the whole of what he asked for.
      await page.getByRole('button', { name: 'Sort this list' }).click();
      await page.getByRole('button', { name: 'A–Z', exact: true }).click();
      await expect.poll(() => asked.some((body) => body.includes('"sortDir":"asc"'))).toBe(true);
    });

    test('the call disposition filter sends what it says it does', async ({ page }) => {
      await openQueue(page, module.path);

      /*
        The *effect* is pinned against a real database in
        `tests/integration/lastCallSortAndFilter.test.ts`, which makes its own
        calls to filter on. What only a browser can say is that the button on
        this row asks the question at all — a disposition is not a field on
        either module, so nothing else would have noticed it going nowhere.
      */
      let sentFilter = false;
      await page.route('**/api/records/**', async (route) => {
        const body = route.request().postData() ?? route.request().url();
        if (body.includes('last_call_disposition')) sentFilter = true;
        await route.continue();
      });

      await page.getByTestId('call-disposition-filter').click();
      await page.getByRole('button', { name: 'Never called' }).click();
      await page.keyboard.press('Escape');
      await expect.poll(() => sentFilter, { timeout: 15_000 }).toBe(true);
      await expect(page.getByTestId('call-disposition-filter')).toContainText('Never called');
    });
  });
}

test.describe('the call deck', () => {
  /**
   * Put a call on the record the pane has open, the way a refresh mid-call does.
   *
   * The call carries the signed-in user's id because a live call belongs to one
   * person — another rep's call must never appear on this screen — so a staged
   * one without it is correctly ignored.
   */
  async function stageCall(page: Page, module: string): Promise<void> {
    await page.evaluate(async (name) => {
      const fetched = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => new RegExp(`/api/records/${name}/[0-9a-f-]{36}$`).test(url));
      const recordId = fetched[0]?.split('/').pop();
      if (!recordId) throw new Error('no record was open to put a call on');
      const me = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${localStorage.getItem('ipropy.token')}` },
      }).then((res) => res.json() as Promise<{ user?: { id: string }; id?: string }>);
      localStorage.setItem('ipropy.liveCall', JSON.stringify({
        number: '+919999999999', module: name, recordId,
        userId: me.user?.id ?? me.id,
        followUpField: 'next_followup_at',
        pressedAt: Date.now() - 95_000, placing: false, outcome: null,
      }));
    }, module);
    await page.reload();
    await page.getByTestId('call-deck-panel').waitFor({ timeout: 30_000 });
  }

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => localStorage.removeItem('ipropy.liveCall'));
  });

  test('shows a bar and a clock instead of "Calling on your phone"', async ({ page }) => {
    await openQueue(page, '/leads');
    await stageCall(page, 'leads');

    const bar = page.getByTestId('call-panel-status');
    // The sentence that was on screen for the whole of every call, because
    // every installed handset predates the plugin that reports a call's state.
    await expect(bar).not.toContainText('Calling on your phone');
    // The clock counts from when Call was pressed, which is the one thing this
    // computer knows for certain.
    await expect(bar).toContainText(/\d{2}:\d{2}/);
    await expect(bar.locator('.animate-call-sweep')).toBeVisible();
  });

  test('the follow-up control can be read, whole, at the panel’s own width', async ({ page }) => {
    await openQueue(page, '/leads');
    await stageCall(page, 'leads');

    /*
      It was a four-column grid of buttons at the very bottom of a panel that
      is `overflow-hidden`, so the last two were cut through the middle of a
      word — the screenshot he sent. A native select is drawn by the browser
      outside the panel entirely, so nothing this card does to its overflow can
      clip its list again.
    */
    const followUp = page.getByTestId('call-deck-followup');
    await followUp.scrollIntoViewIfNeeded();
    await expect(followUp).toBeVisible();

    const fits = await followUp.evaluate((el) => {
      const panel = el.closest('[data-testid="call-deck-panel"]')!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return box.left >= panel.left - 1 && box.right <= panel.right + 1 && box.width > 120;
    });
    expect(fits, 'the follow-up control is cut off by the panel').toBe(true);

    // Three states, and "let the outcome decide" is the one that was unsayable.
    await expect(followUp).toHaveValue('auto');
    await followUp.selectOption({ label: 'No follow-up' });
    await expect(followUp).toHaveValue('none');
    await followUp.selectOption({ index: 3 });
    await expect(followUp).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  });
});
