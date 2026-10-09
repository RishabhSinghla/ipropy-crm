import { beforeAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, leadInput, propertyInput } from './fixtures.js';

let ctx: Awaited<ReturnType<typeof adminContext>>;
beforeAll(async () => { await registry.warmup(); ctx = await adminContext(); });

it('includes mobile and property facts on authorised search hits', async () => {
  const name = `SearchDetails${Date.now()}`;
  const record = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: name, budget: 12500000 }));
  const hit = (await recordService.globalSearch(ctx, name)).find((item) => item.id === record.id);
  expect(hit).toBeDefined();
  expect(hit?.mobile).toBeTruthy();
  expect(hit?.details).toContain('1.25');
  expect(await recordService.countRecords(ctx, 'leads', { search: name })).toBe(1);
  const listed = await recordService.listRecords(ctx, 'leads', { search: name });
  expect(listed.rows[0]?.display?.owner_id).toBeTruthy();
});

it('finds a partial house number in universal search', async () => {
  const house = `A-${Date.now()}-7`;
  const record = await recordService.createRecord(ctx, 'properties', propertyInput({ unit_number: house }));
  expect((await recordService.globalSearch(ctx, house.slice(2, -2))).some(hit => hit.id === record.id)).toBe(true);
});

it('indexes house numbers on existing records without changing their values', async () => {
  const house = `MigrationHouse${Date.now()}`;
  const record = await recordService.createRecord(ctx, 'properties', propertyInput({ unit_number: house }));
  await db.query('UPDATE ipy_record SET search_text = $1 WHERE id = $2', ['Existing contact', record.id]);
  await db.query("UPDATE ipy_field SET searchable = false WHERE name = 'unit_number'");
  const migration = await readFile(new URL('../../src/db/migrations/199_house_numbers_in_universal_search.sql', import.meta.url), 'utf8');
  await db.query(migration);
  const indexed = await db.queryOne<{ search_text: string }>('SELECT search_text FROM ipy_record WHERE id = $1', [record.id]);
  expect(indexed?.search_text).toContain(house);
  const metadata = await db.queryOne<{ searchable: boolean }>("SELECT searchable FROM ipy_field WHERE name = 'unit_number' LIMIT 1");
  expect(metadata?.searchable).toBe(true);
  expect((await recordService.globalSearch(ctx, house)).some(hit => hit.id === record.id)).toBe(true);
  expect((await recordService.getRecord(ctx, 'properties', record.id)).values.unit_number).toBe(house);
  await db.query(migration);
  expect((await db.queryOne<{ search_text: string }>('SELECT search_text FROM ipy_record WHERE id = $1', [record.id]))?.search_text).toBe(indexed?.search_text);
});

it('defaults new areas to square yards without changing an existing square-foot area', async () => {
  const fresh = await recordService.createRecord(ctx, 'leads', leadInput({ area: 200 }));
  expect(fresh.values.area_unit).toBe('sqyd');
  const old = await recordService.createRecord(ctx, 'leads', leadInput({ area: 1800, area_unit: 'sqft' }));
  const updated = await recordService.updateRecord(ctx, 'leads', old.id, { budget: 10000000 });
  expect(updated.values.area).toBe(1800);
  expect(updated.values.area_unit).toBe('sqft');
});
