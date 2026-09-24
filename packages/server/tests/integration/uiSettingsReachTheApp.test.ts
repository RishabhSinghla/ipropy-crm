/**
 * A setting saved in the admin panel reaches the app.
 *
 * This suite exists because of one bug, and the bug is the kind only a real
 * database can show. `uiSettings()` used to fetch a hand-written list of keys
 * and hand each one to its reader. A new setting — `ui.list_views` — got a
 * reader and was never added to that list, so it was read as absent every
 * time: Admin → List Views saved successfully, said so, and changed nothing.
 *
 * Nothing could see it. The reader's own unit tests passed (they call it
 * directly), typecheck passed (the key list is an array of strings), and the
 * admin screen passed (the row really was written). Only the round trip —
 * write the row, ask for the settings, look at the answer — fails.
 *
 * So the assertion is deliberately dumb: save it, read it back, expect it.
 * Any `ui.*` setting that stops reaching the app fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { invalidateUiSettings, uiSettings } from '../../src/core/settings/ui.js';

let before: unknown = null;

async function save(value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO ipy_setting (key, value, category) VALUES ('ui.list_views', $1::jsonb, 'ui')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
  // The app caches these in memory; the admin route clears it on every save.
  invalidateUiSettings();
}

beforeAll(async () => {
  const row = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'ui.list_views'`,
  );
  before = row?.value ?? null;
});

afterAll(async () => {
  await save(before ?? { table: true, kanban: true, ipropy: true });
});

describe('a list view switched off in the admin panel', () => {
  it('reaches the app', async () => {
    await save({ table: true, kanban: false, ipropy: true });
    expect((await uiSettings()).listViews).toEqual({ table: true, kanban: false, ipropy: true });
  });

  it('comes back on when it is switched back on', async () => {
    await save({ table: true, kanban: true, ipropy: true });
    expect((await uiSettings()).listViews).toEqual({ table: true, kanban: true, ipropy: true });
  });

  it('is ignored when it would leave a list with no view at all', async () => {
    await save({ table: false, kanban: false, ipropy: false });
    expect((await uiSettings()).listViews).toBeNull();
  });

  it('does not disturb the settings beside it', async () => {
    await save({ table: false, kanban: true, ipropy: true });
    const ui = await uiSettings();
    // The two that share this row's prefix and were working before the bug.
    expect(ui).toHaveProperty('splitView');
    expect(ui).toHaveProperty('listColumns');
    expect(typeof ui.openInNewTab).toBe('boolean');
  });
});
