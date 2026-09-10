/**
 * The public catalogue on a model an administrator has pruned.
 *
 * `/api/public/properties` answered `unknown_field` for every request on
 * production: the default sort is `price_asc`, which names `u.total_price`, and
 * that column had been deleted. The website showed no properties at all, which
 * reads as a business with no stock rather than as a field that moved.
 *
 * The SELECT list was already guarded this way — `propertyFields()` drops any
 * column the model has lost. The ORDER BY and the price filters were not, so
 * the guard covered the part that degrades gracefully and missed the part that
 * fails the request.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';

let app: ReturnType<typeof createApp>;
const DROPPED = ['total_price', 'possession_date'];
const restored: { column: string; type: string; field: Record<string, unknown> | null }[] = [];
let published: string | null = null;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  for (const column of DROPPED) {
    const existing = await db.queryOne<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'ipy_e_properties' AND column_name = $1`, [column]);
    if (!existing) continue;
    const field = await db.queryOne<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(f) AS row FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'properties' AND f.column_name = $1`, [column]);
    restored.push({ column, type: existing.data_type, field: field?.row ?? null });
    await db.query(`DELETE FROM ipy_field f USING ipy_module m
                     WHERE m.id = f.module_id AND m.name = 'properties' AND f.column_name = $1`, [column]);
    await db.query(`ALTER TABLE ipy_e_properties DROP COLUMN ${column}`);
  }

  const unit = await db.queryOne<{ record_id: string }>(
    `SELECT p.record_id FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
      WHERE r.is_deleted = false AND to_jsonb(p)->>'status' = 'Available'
      ORDER BY p.record_id LIMIT 1`);
  published = unit?.record_id ?? null;
  if (published) {
    await db.query(
      `UPDATE ipy_e_properties SET custom_fields = COALESCE(custom_fields,'{}'::jsonb)
         || '{"publish_to_web":"true"}'::jsonb WHERE record_id = $1`, [published]);
  }
  registry.invalidate();
});

afterAll(async () => {
  const SQL: Record<string, string> = { numeric: 'NUMERIC', date: 'DATE', text: 'TEXT' };
  for (const { column, type, field } of restored.reverse()) {
    await db.query(`ALTER TABLE ipy_e_properties ADD COLUMN IF NOT EXISTS ${column} ${SQL[type] ?? 'TEXT'}`);
    if (field) {
      await db.query(`INSERT INTO ipy_field SELECT * FROM jsonb_populate_record(NULL::ipy_field, $1::jsonb)
                      ON CONFLICT (module_id, name) DO NOTHING`, [JSON.stringify(field)]);
    }
  }
  if (published) {
    await db.query(`UPDATE ipy_e_properties SET custom_fields = custom_fields - 'publish_to_web'
                     WHERE record_id = $1`, [published]);
  }
  registry.invalidate();
});

describe('the public property catalogue with price and possession deleted', () => {
  it('still lists the published units on the default sort', async () => {
    const res = await request(app).get('/api/public/properties?limit=5').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    if (published) expect(res.body.total).toBeGreaterThan(0);
  });

  it('falls back rather than failing when the requested sort is impossible', async () => {
    for (const sort of ['price_asc', 'price_desc', 'possession', 'area_desc', 'nonsense']) {
      const res = await request(app).get(`/api/public/properties?sort=${sort}&limit=3`);
      expect(res.status, `sort=${sort} answered ${res.status}`).toBe(200);
    }
  });

  it('ignores a price filter the model can no longer apply', async () => {
    const res = await request(app).get('/api/public/properties?maxPrice=30000000&limit=3').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('answers an empty shelf for projects rather than an error', async () => {
    const res = await request(app).get('/api/public/projects?limit=3').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
