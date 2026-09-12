/**
 * Getting back values whose field is gone.
 *
 * Production holds twelve property areas in `ipy_dropped_column` — swept when
 * an old `area` column was dropped — while the Area / Size field that replaced
 * it holds one. The numbers were never lost; they were just somewhere nobody
 * can see. An archive nobody can read is indistinguishable from a delete.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { SEEDED, signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
const COLUMN = `qa_gone_${Date.now().toString(36)}`;
const FIELD = `qa_target_${Date.now().toString(36)}`;
let fieldId = '';
let ids: string[] = [];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await signIn(app, admin!.email);

  const list = await request(app).get('/api/records/properties?pageSize=3')
    .set('Authorization', `Bearer ${token}`).expect(200);
  ids = list.body.rows.map((r: { id: string }) => r.id);

  // Stand in for a column an old migration swept away.
  for (const [i, id] of ids.entries()) {
    await db.query(
      `INSERT INTO ipy_dropped_column (table_name, column_name, record_id, value)
       VALUES ('ipy_e_properties', $1, $2, $3)`, [COLUMN, id, `recovered-${i}`],
    );
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_dropped_column WHERE column_name = $1`, [COLUMN]);
  if (fieldId) await request(app).delete(`/api/meta/fields/${fieldId}?permanent=true&confirm=true`)
    .set('Authorization', `Bearer ${token}`);
  await db.query(`DELETE FROM ipy_dropped_column WHERE column_name = $1`, [FIELD]);
});

describe('recovering values whose field was deleted', () => {
  it('lists what is recoverable for the module', async () => {
    const res = await request(app).get('/api/meta/modules/properties/archived-values')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const row = res.body.find((r: { column: string }) => r.column === COLUMN);
    expect(row).toBeTruthy();
    expect(row.count).toBe(ids.length);
  });

  it('pours them into a field an admin chooses, and does not overwrite by default', async () => {
    const module = await request(app).get('/api/meta/modules/properties?includeInactive=true')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const created = await request(app).post('/api/meta/modules/properties/fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: FIELD, label: 'QA recovery target', uitype: 'string', blockId: module.body.blocks[0]?.id, config: {} })
      .expect(201);
    fieldId = created.body.id as string;

    // Somebody has already typed a value on the first record. It must win.
    await request(app).patch(`/api/records/properties/${ids[0]}`)
      .set('Authorization', `Bearer ${token}`).send({ [FIELD]: 'typed by a person' }).expect(200);

    const done = await request(app).post(`/api/meta/fields/${fieldId}/recover-values`)
      .set('Authorization', `Bearer ${token}`).send({ column: COLUMN }).expect(200);
    expect(done.body.restored).toBe(ids.length - 1);

    const first = await request(app).get(`/api/records/properties/${ids[0]}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(first.body.values[FIELD]).toBe('typed by a person');

    const second = await request(app).get(`/api/records/properties/${ids[1]}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(second.body.values[FIELD]).toBe('recovered-1');

    // What landed is consumed; what was skipped stays, so the panel shows the
    // remainder rather than offering the same twelve values for ever.
    const left = await request(app).get('/api/meta/modules/properties/archived-values')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const row = left.body.find((r: { column: string }) => r.column === COLUMN);
    expect(row?.count ?? 0).toBe(1);
  });

  it('recovers into a numeric column without choking on the text archive', async () => {
    // The archive stores text. Area / Size is a numeric column, and a plain
    // assignment raises 22P02 — which is exactly how this failed in the browser
    // the first time. One unconvertible value must not take the rest down.
    const NUMERIC_COL = `qa_num_${Date.now().toString(36)}`;
    const area = await db.queryOne<{ id: string }>(
      `SELECT f.id FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'properties' AND f.column_name = 'carpet_area'`,
    );
    if (!area) return; // this database does not carry the renamed area field

    await db.query(
      `INSERT INTO ipy_dropped_column (table_name, column_name, record_id, value)
       VALUES ('ipy_e_properties', $1, $2, '1450'),
              ('ipy_e_properties', $1, $3, 'not a number')`,
      [NUMERIC_COL, ids[1], ids[2]],
    );
    await db.query(`UPDATE ipy_e_properties SET carpet_area = NULL WHERE record_id = ANY($1::uuid[])`,
      [[ids[1], ids[2]]]);

    const done = await request(app).post(`/api/meta/fields/${area.id}/recover-values`)
      .set('Authorization', `Bearer ${token}`).send({ column: NUMERIC_COL }).expect(200);
    expect(done.body.restored).toBe(1);

    const row = await db.queryOne<{ carpet_area: string }>(
      `SELECT carpet_area FROM ipy_e_properties WHERE record_id = $1`, [ids[1]]);
    expect(Number(row?.carpet_area)).toBe(1450);
    await db.query(`DELETE FROM ipy_dropped_column WHERE column_name = $1`, [NUMERIC_COL]);
  });

  it('refuses a non-admin', async () => {
    const exec = await signIn(app, SEEDED.executiveA);
    await request(app).get('/api/meta/modules/properties/archived-values')
      .set('Authorization', `Bearer ${exec}`).expect(403);
  });
});
