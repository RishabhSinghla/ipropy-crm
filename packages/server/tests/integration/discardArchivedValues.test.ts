/**
 * Throwing away the values of a field that no longer exists.
 *
 * **27 September 2026, the owner**, with three screenshots of amber panels:
 * *"they warn me with multiple warning and errors, please fix it."* One of
 * them was Modules & Fields telling him about six archives — `carpet_area`,
 * `name`, `bathrooms` — kept from fields deleted long ago. Recovering them
 * into a live field was the **only** thing that could ever empty that panel,
 * so it warned him for ever about something he was never going to do.
 *
 * This is a real delete and the screen asks first, so the two things worth
 * pinning are that it removes exactly the one column asked for and leaves
 * every other archive alone, and that it leaves a trail — "where did those
 * four values go" has to have an answer somewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { adminToken } from './fixtures.js';

const KEPT = `zz_kept_${Date.now()}`;
const DISCARDED = `zz_discarded_${Date.now()}`;

let app: ReturnType<typeof createApp>;
let token: string;
let table: string;

beforeAll(async () => {
  app = createApp();
  token = await adminToken(app);
  const module = await db.queryOne<{ table_name: string }>(
    `SELECT table_name FROM ipy_module WHERE name = 'leads'`,
  );
  table = module!.table_name;

  /*
    Two archives on the same table, so "only the one asked for" is testable.

    The record ids are invented rather than borrowed from the seed. Nothing
    here reads a record — these rows are the archive of a column no field
    owns, and `ipy_dropped_column` has no foreign key precisely because the
    record it belonged to may be long gone. Taking "whichever lead comes
    first" would have made this test depend on what ran before it for no
    benefit at all.
  */
  for (const column of [KEPT, DISCARDED]) {
    for (let i = 0; i < 3; i += 1) {
      await db.query(
        `INSERT INTO ipy_dropped_column (table_name, column_name, record_id, value)
         VALUES ($1, $2, gen_random_uuid(), '1')`,
        [table, column],
      );
    }
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_dropped_column WHERE column_name = ANY($1::text[])`, [[KEPT, DISCARDED]]);
  await db.query(`DELETE FROM ipy_field_change WHERE field_internal_id = ANY($1::text[])`, [[KEPT, DISCARDED]]);
});

describe('discarding archived values', () => {
  it('removes the one column asked for and leaves the others standing', async () => {
    const before = await db.query(
      `SELECT 1 FROM ipy_dropped_column WHERE table_name = $1 AND column_name = $2`, [table, DISCARDED],
    );
    expect(before.rowCount, 'the fixture did not land').toBeGreaterThan(0);

    const res = await request(app)
      .delete(`/api/meta/modules/leads/archived-values/${DISCARDED}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status, `it answered ${res.status}: ${res.text}`).toBe(200);
    expect(res.body.discarded).toBe(before.rowCount);

    const gone = await db.query(
      `SELECT 1 FROM ipy_dropped_column WHERE table_name = $1 AND column_name = $2`, [table, DISCARDED],
    );
    expect(gone.rowCount).toBe(0);

    // The neighbour is somebody else's decision and must not go with it.
    const kept = await db.query(
      `SELECT 1 FROM ipy_dropped_column WHERE table_name = $1 AND column_name = $2`, [table, KEPT],
    );
    expect(kept.rowCount, 'it took the other archive too').toBeGreaterThan(0);
  });

  it('leaves a trail, because nothing else can say where those values went', async () => {
    const logged = await db.queryOne<{ before_value: { rows: number; discardedArchive: string } }>(
      `SELECT before_value FROM ipy_field_change
        WHERE field_internal_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [DISCARDED],
    );
    expect(logged?.before_value?.discardedArchive).toBe(DISCARDED);
    expect(logged?.before_value?.rows).toBeGreaterThan(0);
  });

  /*
    A column nobody archived is not an error — the panel may have been cleared
    in another tab, and a 500 there would read as the button being broken.
  */
  it('says nothing was there rather than failing', async () => {
    const res = await request(app)
      .delete('/api/meta/modules/leads/archived-values/zz_never_existed')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.discarded).toBe(0);
  });

  it('refuses without a token', async () => {
    const res = await request(app).delete(`/api/meta/modules/leads/archived-values/${KEPT}`);
    expect(res.status).toBe(401);
  });
});
