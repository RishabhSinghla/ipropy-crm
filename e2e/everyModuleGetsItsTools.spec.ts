/**
 * A module's toolbar is decided by its metadata, not by its name.
 *
 * **28 September 2026, the owner:** *"Check the Toolbar in Associate module,
 * there are Followup Filter Button are missing."* Associates carries
 * `next_followup_at` exactly as Contacts does — it was cloned from it — and
 * still had no way to work its chase list, because the button was gated on
 * `moduleName === 'leads' || moduleName === 'properties'`. A third module
 * arrived and nothing told that line about it.
 *
 * This walks every module the switcher offers rather than naming any, so the
 * next module added is covered the day it exists: if the CRM says a module has
 * somewhere to put a chase date, the toolbar has to offer the chase list.
 */
import { test, expect } from '@playwright/test';

test('every module with a chase date offers its follow-up queue', async ({ page }) => {
  await page.goto('/');

  const modules = await page.evaluate(async () => {
    const token = localStorage.getItem('ipropy.token');
    const head = { Authorization: `Bearer ${token}` };
    const list = await fetch('/api/meta/modules', { headers: head })
      .then((r) => r.json()) as { name: string; label: string }[];

    const withChaseDate: string[] = [];
    for (const module of list) {
      const described = await fetch(`/api/meta/modules/${module.name}`, { headers: head })
        .then((r) => r.json()) as { fields?: { name: string; columnName?: string; isActive?: boolean }[] };
      const has = described.fields?.some((f) =>
        f.isActive !== false && (f.columnName === 'next_followup_at' || f.name === 'next_follow_up'));
      if (has) withChaseDate.push(module.name);
    }
    return withChaseDate;
  });

  expect(modules.length, 'no module has a chase date at all — nothing to check').toBeGreaterThan(0);

  for (const name of modules) {
    await page.goto(`/${name}`);
    await expect(page.locator('text=/of [\\d,]+ records/').first()).toBeVisible({ timeout: 40_000 });
    await expect(
      page.getByRole('button', { name: /^Follow-ups/ }),
      `${name} has a chase date and no Follow-ups button`,
    ).toHaveCount(1);
  }
});
