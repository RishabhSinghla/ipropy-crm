/**
 * Lost needs a reason — 1 October 2026, the owner: *"when … status field's
 * value is Lost then there'd be Lost Reason field to actually highlight and be
 * populated meaning be getting mandatory."*
 *
 * Driven the way a rep does it: change the stage where it stands on the open
 * record, pick Lost, and the CRM asks why before it saves — both in one save.
 */
import { test, expect, type Page } from '@playwright/test';
import { unique, openDetailsPane } from './helpers';

test.use({ viewport: { width: 1600, height: 950 } });

async function api<T>(page: Page, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(async ({ path, init }) => {
    const res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${localStorage.getItem('ipropy.token')}`, 'Content-Type': 'application/json' },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    return res.json();
  }, { path, init }) as Promise<T>;
}

test('picking Lost asks why, and saves the stage and the reason together', async ({ page }) => {
  await page.goto('/leads');
  const meta = await api<{ fields: { name: string; label: string; columnName: string; config: { picklist?: string }; options?: { value: string }[] }[] }>(page, '/api/meta/modules/leads');
  const status = meta.fields.find((f) => f.columnName === 'status')!;
  const reason = meta.fields.find((f) => f.config.picklist === 'lost_reason');
  test.skip(!reason, 'this database has no Lost Reason field on Contacts');
  const lostValue = status.options!.map((o) => o.value).find((v) => /\blost\b/i.test(v));
  test.skip(!lostValue, 'this database has no Lost stage');

  const name = unique('Lost Reason');
  const created = await api<{ id: string }>(page, '/api/records/leads', {
    method: 'POST', body: { full_name: name, mobile: `98${String(Date.now()).slice(-8)}` },
  });

  // The server refuses Lost on its own.
  const refused = await page.evaluate(async ({ id, field, value }) => {
    const res = await fetch(`/api/records/leads/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${localStorage.getItem('ipropy.token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    return res.status;
  }, { id: created.id, field: status.name, value: lostValue });
  expect(refused, 'Lost with no reason should be refused').toBe(422);

  await page.goto(`/leads?open=${created.id}`);
  // The details pane is folded on arrival since 3 October 2026, and a folded
  // pane is `inert` — the field is attached and cannot be reached.
  await openDetailsPane(page);
  const pane = page.getByTestId('activity-pane');
  const change = pane.getByRole('button', { name: `Change ${status.label}` }).first();
  await expect(change).toBeAttached({ timeout: 30_000 });
  await change.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: new RegExp(lostValue!.replace(/^Lead /, ''), 'i') }).first()
    .or(page.getByRole('button', { name: new RegExp(`^${lostValue!.replace(/^Lead /, '')}$`, 'i') }).first())
    .click();

  const choices = page.getByTestId('lost-reason-choices');
  await expect(choices).toBeVisible();
  const picked = (await choices.getByRole('button').first().textContent())!.trim();
  await choices.getByRole('button').first().click();

  await expect.poll(async () => {
    const record = await api<{ values: Record<string, unknown> }>(page, `/api/records/leads/${created.id}`);
    return [record.values[status.name], record.values[reason!.name]];
  }, { timeout: 15_000 }).toEqual([lostValue, expect.anything()]);
  expect(picked.length).toBeGreaterThan(0);
});
