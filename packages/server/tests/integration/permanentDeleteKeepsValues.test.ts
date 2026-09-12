/**
 * A permanent delete archives the values; re-creating the field returns them.
 *
 * On 10 September the Demand field was permanently deleted on production, and
 * with it `ipy_e_properties.base_price` — every asking price on the books. The
 * code counted the values into `had_values` and then dropped them, so what
 * survived was a tally of how many had been lost.
 *
 * The confirmation dialog is not the safeguard. An admin is allowed to delete
 * a field permanently; they are not choosing to make the business's numbers
 * unrecoverable, and nothing on that screen says they are.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
const NAME = `qa_archive_${Date.now().toString(36)}`;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await signIn(app, admin!.email);
});
afterAll(async () => {
  await db.query(`DELETE FROM ipy_dropped_column WHERE column_name = $1`, [NAME]);
  await db.query(`DELETE FROM ipy_field f USING ipy_module m
                   WHERE m.id = f.module_id AND m.name = 'properties' AND f.name = $1`, [NAME]);
});

describe('permanently deleting a field with values in it', () => {
  it('archives every value, and re-creating the field pours them back', async () => {
    const module = await request(app).get('/api/meta/modules/properties?includeInactive=true')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const blockId = module.body.blocks[0]?.id as string;

    const created = await request(app).post('/api/meta/modules/properties/fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: NAME, label: 'QA archived field', uitype: 'string', blockId, config: {} })
      .expect(201);
    const fieldId = created.body.id as string;

    // Put a value on three real properties, through the API, like a person would.
    const list = await request(app).get('/api/records/properties?pageSize=3')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const ids: string[] = list.body.rows.map((r: { id: string }) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const [i, id] of ids.entries()) {
      await request(app).patch(`/api/records/properties/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ [NAME]: `kept-${i}` })
        .expect(200);
    }

    // Sanity: the values are really there before anything is deleted.
    const before = await request(app).get(`/api/records/properties/${ids[0]}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(before.body.values[NAME]).toBe('kept-0');

    await request(app).delete(`/api/meta/fields/${fieldId}?permanent=true&confirm=true`)
      .set('Authorization', `Bearer ${token}`).expect(200);

    const archived = await db.query<{ record_id: string; value: string }>(
      `SELECT record_id, value FROM ipy_dropped_column
        WHERE table_name = 'ipy_e_properties' AND column_name = $1 ORDER BY value`, [NAME],
    );
    expect(archived.rows.map((r) => r.value)).toEqual(ids.map((_, i) => `kept-${i}`));

    // Put the field back under the same name.
    await request(app).post('/api/meta/modules/properties/fields')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: NAME, label: 'QA archived field', uitype: 'string', blockId, config: {} })
      .expect(201);

    for (const [i, id] of ids.entries()) {
      const rec = await request(app).get(`/api/records/properties/${id}`)
        .set('Authorization', `Bearer ${token}`).expect(200);
      expect(rec.body.values[NAME]).toBe(`kept-${i}`);
    }

    // The archive is consumed, so a later delete cannot resurrect stale values.
    const left = await db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ipy_dropped_column WHERE column_name = $1`, [NAME],
    );
    expect(Number(left?.count)).toBe(0);
  });
});
