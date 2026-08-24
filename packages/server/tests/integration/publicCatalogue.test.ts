/**
 * The catalogue the public website reads.
 *
 * Everything here is about one class of failure: the endpoint answers 200 with
 * an empty list, which is indistinguishable from genuinely having no stock. No
 * error is logged, nothing turns red, and the website simply shows nothing.
 *
 * That is not hypothetical. The properties list compared the status column to
 * the *array* of published statuses with `=` instead of `= ANY`, so it matched
 * nothing at all and had been returning zero for as long as it had existed,
 * while every other query in the same file used `= ANY`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext } from './fixtures.js';
import type { ServiceContext } from '../../src/core/entity/recordService.js';

let app: Express;
let ctx: ServiceContext;
const made: string[] = [];

async function publish(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const rec = await recordService.createRecord(ctx, 'properties', {
    name,
    status: 'Available',
    project_name: 'Catalogue Test Project',
    city: 'Faridabad',
    ...extra,
  });
  made.push(rec.id);
  return rec.id;
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  ctx = await adminContext();
});

afterAll(async () => {
  if (made.length) {
    await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
  }
});

describe('the public property list', () => {
  it('returns a property whose status is published', async () => {
    const name = `Catalogue ${Date.now()}`;
    await publish(name);

    const res = await request(app).get('/api/public/properties?limit=50');
    expect(res.status).toBe(200);

    // The assertion that would have caught the `=` vs `= ANY` bug: the list is
    // not merely well-formed, it actually contains the thing we just published.
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).toContain(name);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('hides a property whose status is not published', async () => {
    const name = `Hidden ${Date.now()}`;
    const id = await publish(name);
    await db.query(`UPDATE ipy_e_properties SET status = 'Booked' WHERE record_id = $1`, [id]);

    const res = await request(app).get('/api/public/properties?limit=50');
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).not.toContain(name);
  });

  it('hides a property the admin has switched off for the website', async () => {
    const name = `Unpublished ${Date.now()}`;
    const id = await publish(name);
    await db.query(
      `UPDATE ipy_e_properties
          SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || '{"publish_to_web":"false"}'::jsonb
        WHERE record_id = $1`,
      [id],
    );

    const res = await request(app).get('/api/public/properties?limit=50');
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).not.toContain(name);
  });

  it('still filters by city without losing everything', async () => {
    // A filter that silently matched nothing would look the same as "no stock
    // in that city", which is the whole failure mode this file is about.
    const name = `City Filter ${Date.now()}`;
    await publish(name);

    const res = await request(app).get('/api/public/properties?city=Faridabad&limit=50');
    expect(res.status).toBe(200);
    const names = (res.body.items as { name: string }[]).map((i) => i.name);
    expect(names).toContain(name);
  });
});
