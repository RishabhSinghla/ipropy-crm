/**
 * Deleting a property takes it off the website.
 *
 * It did not. Not one of the ten public property queries excluded deleted
 * records, so a rep deleting a sold unit removed it from the CRM and left it
 * advertised to buyers — the catalogue, the detail page, the project pages and
 * the city counts all kept serving it. There is no purge, so it stayed there.
 *
 * The worst version of this is the one that actually happens: a unit sells, the
 * rep tidies up, and the website keeps taking enquiries for it.
 *
 * The check lives in `publishClause`, which is the one thing every public
 * property read already goes through — the alternative was restructuring ten
 * statements to join `ipy_record`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, propertyInput } from './fixtures.js';

let app: Express;
let propertyId: string;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();

  const ctx = await adminContext();
  const statuses = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'public.property_statuses'`,
  );
  const publicStatus = Array.isArray(statuses?.value) ? String(statuses!.value[0]) : 'Available';

  const property = await recordService.createRecord(ctx, 'properties', propertyInput({
    full_name: `Delete Probe ${Date.now()}`,
    status: publicStatus,
    base_price: 9500000,
    publish_to_web: true,
  }));
  propertyId = property.id;
});

afterAll(async () => {
  if (propertyId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [propertyId]);
});

const listed = async (): Promise<boolean> => {
  const res = await request(app).get('/api/public/properties');
  return (res.body.items ?? []).some((i: { id: string }) => i.id === propertyId);
};

describe('a property that has been deleted', () => {
  it('is on the website while it exists', async () => {
    // The test is worthless if the property was never public to begin with.
    expect(await listed(), 'setup failed — it should be published before deleting').toBe(true);
  });

  it('leaves the catalogue when deleted', async () => {
    const ctx = await adminContext();
    await recordService.deleteRecord(ctx, 'properties', propertyId);

    expect(await listed(), 'a deleted unit is still being advertised to buyers').toBe(false);
  });

  it('stops serving its own detail page', async () => {
    // A buyer with the link in their browser history must not still see it.
    const res = await request(app).get(`/api/public/properties/${propertyId}`);
    expect(res.status).toBe(404);
  });

  it('stops counting towards the city and project summaries', async () => {
    /*
      The derived pages were the easiest half to miss: even once a unit is off
      the list, a stale count still tells a visitor there is more stock than
      there is.
    */
    const cities = await request(app).get('/api/public/cities');
    const units = (cities.body.items ?? []).reduce(
      (sum: number, c: { unit_count: number }) => sum + Number(c.unit_count ?? 0), 0,
    );

    const catalogue = await request(app).get('/api/public/properties');
    expect(units, 'the city totals must agree with the catalogue')
      .toBeLessThanOrEqual(Number(catalogue.body.total ?? 0));
  });

  it('comes back if the deletion is undone', async () => {
    // Deletion is soft, so restoring is a real path and must work both ways.
    await db.query(
      `UPDATE ipy_record SET is_deleted = false, deleted_at = NULL WHERE id = $1`, [propertyId],
    );
    expect(await listed()).toBe(true);
  });
});
