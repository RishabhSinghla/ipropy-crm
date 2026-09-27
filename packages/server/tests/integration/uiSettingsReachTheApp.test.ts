/**
 * A setting saved in the admin panel reaches the app.
 *
 * This suite exists because of one bug, and the bug is the kind only a real
 * database can show. `uiSettings()` used to fetch a hand-written list of keys
 * and hand each one to its reader. A new setting got a reader and was never
 * added to that list, so it was read as absent every time: its admin screen
 * saved successfully, said so, and changed nothing.
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
    `INSERT INTO ipy_setting (key, value, category) VALUES ('ui.split_view', $1::jsonb, 'ui')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
  // The app caches these in memory; the admin route clears it on every save.
  invalidateUiSettings();
}

beforeAll(async () => {
  const row = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'ui.split_view'`,
  );
  before = row?.value ?? null;
});

afterAll(async () => {
  await save(before ?? {});
});

describe('the split view arranged in the admin panel', () => {
  it('reaches the app', async () => {
    await save({ leads: { queue: ['mobile'], header: [], form: [] } });
    expect((await uiSettings()).splitView).toEqual({ leads: { queue: ['mobile'], header: [], form: [] } });
  });

  it('goes back to the shipped answer when it is cleared', async () => {
    await save({});
    expect((await uiSettings()).splitView).toBeNull();
  });

  it('does not disturb the settings beside it', async () => {
    await save({ leads: { queue: ['mobile'], header: [], form: [] } });
    const ui = await uiSettings();
    expect(typeof ui.openInNewTab).toBe('boolean');
    expect(typeof ui.inlineEdit).toBe('boolean');
  });
});
