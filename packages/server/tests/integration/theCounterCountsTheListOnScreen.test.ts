/**
 * The "2 / 25,458" on the record header must count the list on screen.
 *
 * The owner, 1 October 2026, on the first record of his list: *"I am on first
 * record … and I am seeing 2"*. The counter defaulted to a different order
 * from the list, and its
 * cursor read timestamps through JavaScript, which drops the microseconds —
 * so records imported in the same instant could not be told apart.
 *
 * Every assertion here compares the counter against `listRecords` itself:
 * the promise is that the two agree, whatever else is in the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { createApp } from '../../src/app.js';
import { adminContext, signIn } from './fixtures.js';

let app: Express;
let token = '';
const marker = `Counter ${Date.now()}`;
const made: string[] = [];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  token = await signIn(app, (await adminContext()).user.email);
  for (let i = 0; i < 4; i++) {
    const lead = await recordService.createRecord(await adminContext(), 'leads', {
      full_name: `${marker} ${i}`,
      mobile: `96${String(Date.now() + i).slice(-8)}`,
    });
    made.push(lead.id);
  }
  // An import: three of them added in the very same instant, to the microsecond.
  await db.query(
    `UPDATE ipy_record SET created_at = '2026-09-01 10:00:00.123456+00', updated_at = '2026-09-01 10:00:00.123456+00' WHERE id = ANY($1::uuid[])`,
    [made.slice(0, 3)],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

const onlyOurs = { logic: 'AND' as const, conditions: [{ field: 'full_name', operator: 'contains' as const, value: marker }] };

async function placeOf(id: string, query = ''): Promise<{ position: number | null; total: number; prevId: string | null; nextId: string | null }> {
  const res = await request(app)
    .get(`/api/records/leads/${id}/neighbours?filter=${encodeURIComponent(JSON.stringify(onlyOurs))}${query}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return res.body;
}

describe('the record counter', () => {
  it('counts the list in the order the list shows, ties and all', async () => {
    const list = await recordService.listRecords(await adminContext(), 'leads', { filter: onlyOurs });
    const order = list.rows.map((row) => row.id);
    expect(order).toHaveLength(4);
    for (let at = 0; at < order.length; at++) {
      const place = await placeOf(order[at]);
      expect(place.position, `row ${at + 1} of the list`).toBe(at + 1);
      expect(place.total).toBe(4);
      expect(place.prevId).toBe(order[at - 1] ?? null);
      expect(place.nextId).toBe(order[at + 1] ?? null);
    }
  });

  it('the first record of the list says 1', async () => {
    const list = await recordService.listRecords(await adminContext(), 'leads', { filter: onlyOurs, pageSize: 1 });
    expect((await placeOf(list.rows[0].id)).position).toBe(1);
  });

  it('follows a chosen sort the same way', async () => {
    const list = await recordService.listRecords(await adminContext(), 'leads', { filter: onlyOurs, sortBy: 'full_name', sortDir: 'asc' });
    const order = list.rows.map((row) => row.id);
    for (let at = 0; at < order.length; at++) {
      expect((await placeOf(order[at], '&sort=full_name&dir=asc')).position).toBe(at + 1);
    }
  });

  it('says plainly when the record has left the list', async () => {
    const other = { logic: 'AND' as const, conditions: [{ field: 'full_name', operator: 'equals' as const, value: `${marker} 0` }] };
    const res = await request(app)
      .get(`/api/records/leads/${made[1]}/neighbours?filter=${encodeURIComponent(JSON.stringify(other))}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ position: null, total: 1, prevId: null, nextId: null });
  });
});
