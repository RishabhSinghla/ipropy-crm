import pg from 'pg';
import { expect, test } from '@playwright/test';

/*
  24 October 2026: global search finds archived records too. A record is archived by the scheduler 12 hours after it goes
  Lost, which a browser test cannot wait for, so the spec stamps `archived_at` on its own record directly — the same
  column the scheduler writes. It runs against the developer's own database like every other spec here, with a unique name.
*/
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ipropy:ipropy@localhost:5432/ipropy';

test('an archived record is found, badged Archived, and listed after the live one', async ({ page }) => {
  const token = `Archsearch${Date.now().toString(36)}`;
  await page.goto('/dashboard');
  const make = (name: string, mobile: string) => page.evaluate(async ([full_name, mobileNumber]) => {
    const res = await fetch('/api/records/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('ipropy.token')}` },
      body: JSON.stringify({ full_name, country_code: '91', mobile: mobileNumber }),
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { id: string };
  }, [name, mobile] as const);
  const stamp = String(Date.now());
  const archived = await make(`${token} Old`, `98${stamp.slice(-8)}`);
  const live = await make(`${token} Live`, `97${stamp.slice(-8)}`);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // The archived one was touched last, so a plain recency sort would put it first.
    await client.query(`UPDATE ipy_record SET archived_at = now(), updated_at = now() + interval '1 minute' WHERE id = $1`, [archived.id]);

    const box = page.getByPlaceholder('Search everything…');
    await box.click();
    await box.fill(token);
    const panel = page.locator('#global-search-results');
    await expect(panel.getByText(`${token} Live`)).toBeVisible();
    await expect(panel.getByText(`${token} Old`)).toBeVisible();

    // The badge says it in words, not only in colour.
    const badges = panel.getByTestId('archived-badge');
    await expect(badges).toHaveCount(1);
    await expect(badges).toHaveText('Archived');

    // Live first, archived after.
    const order = await panel.locator('a, [role="option"]').evaluateAll((rows, names) => rows
      .map((row) => (row.textContent ?? ''))
      .map((text) => names.findIndex((name) => text.includes(name)))
      .filter((index) => index >= 0), [`${token} Live`, `${token} Old`]);
    expect(order[0]).toBe(0);
    expect(order[order.length - 1]).toBe(1);

    // And it still opens.
    await panel.getByText(`${token} Old`).first().click();
    // Opens in the Archive's own list, beside the rows, not on a page of its own.
    await expect(page).toHaveURL(new RegExp(`/archive/leads\\?open=${archived.id}`));
  } finally {
    await client.query(`UPDATE ipy_record SET is_deleted = true WHERE id = ANY($1::uuid[])`, [[archived.id, live.id]]);
    await client.end();
  }
});
