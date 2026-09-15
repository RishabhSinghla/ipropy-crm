/**
 * Correcting the area unit across a whole inventory at once.
 *
 * `area` carries the number and `area_unit` carries "square feet or gaj" — one
 * fact in two columns, with the unit rendered inside the area control rather
 * than as a row of its own. So `area_unit` is `displayType: 'hidden'`, which
 * keeps it out of the describe response and therefore out of the list screen's
 * bulk editor. Correcting an inventory opened on the `sqft` default means
 * unhiding the field, bulk editing, and hiding it again.
 *
 * What that procedure rests on is pinned here: the write is accepted, lands on
 * every record, and leaves the numbers exactly where they were. A unit change
 * is a relabel — 250 gaj is still 250 — and the day it starts converting is the
 * day an inventory quietly becomes nine times its real size.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let ids: string[] = [];

/** The areas these records are created with, and must still hold afterwards. */
const AREAS = [250, 187.5, 1000];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = await signIn(app, admin!.email);

  // Created rather than borrowed: this asserts on the number inside the record,
  // so it cannot be reading whatever a previous suite happened to leave behind.
  for (const area of AREAS) {
    const made = await request(app).post('/api/records/properties')
      .set('Authorization', `Bearer ${token}`)
      .send({
        full_name: `QA area unit ${randomUUID()}`,
        mobile: String(9_000_000_000 + Math.floor(Math.random() * 999_999_999)),
        area,
        area_unit: 'sqft',
      });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    ids.push(made.body.id as string);
  }
});

afterAll(async () => {
  for (const id of ids) {
    await request(app).delete(`/api/records/properties/${id}`).set('Authorization', `Bearer ${token}`);
  }
  await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [ids]);
});

describe('changing the area unit across the inventory', () => {
  it('is hidden from the ordinary describe, and visible to an admin who asks', async () => {
    const plain = await request(app).get('/api/meta/modules/properties')
      .set('Authorization', `Bearer ${token}`);
    expect(plain.status).toBe(200);
    const plainFields = plain.body.fields as { name: string; config?: Record<string, unknown> }[];
    expect(plainFields.find((f) => f.name === 'area')?.config?.unitField,
      'area should name its unit field').toBe('area_unit');
    expect(plainFields.find((f) => f.name === 'area_unit'),
      'the unit is drawn inside the area control, so it stays out of the ordinary describe').toBeUndefined();

    // What the field admin sees, and the route by which the unit is unhidden
    // for a bulk edit and hidden again afterwards.
    const asAdmin = await request(app).get('/api/meta/modules/properties?includeInactive=true')
      .set('Authorization', `Bearer ${token}`);
    expect(asAdmin.status).toBe(200);
    const unit = (asAdmin.body.fields as { name: string; massEditable: boolean }[])
      .find((f) => f.name === 'area_unit');
    expect(unit, 'an admin must be able to reach the field to unhide it').toBeDefined();
    expect(unit!.massEditable, 'once visible it has to be mass editable or the bulk edit cannot offer it').toBe(true);
  });

  it('writes the new unit and leaves every number untouched', async () => {
    expect(ids).toHaveLength(AREAS.length);

    const res = await request(app).post('/api/records/properties/mass-update')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids, values: { area_unit: 'sqyd' } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.updated, `not every record took the change: ${JSON.stringify(res.body.reasons)}`)
      .toBe(ids.length);

    const after = await db.query<{ record_id: string; area: string | null; area_unit: string | null }>(
      `SELECT record_id, area, area_unit FROM ipy_e_properties WHERE record_id = ANY($1::uuid[])`, [ids]);
    expect(after.rows).toHaveLength(AREAS.length);

    for (const row of after.rows) {
      const expected = AREAS[ids.indexOf(row.record_id)];
      expect(row.area_unit, 'the unit should now read sqyd').toBe('sqyd');
      expect(Number(row.area), 'the number must not move — this is a relabel, not a conversion')
        .toBe(expected);
    }
  });
});
