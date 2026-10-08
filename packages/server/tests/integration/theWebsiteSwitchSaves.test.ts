/**
 * The "Show on website" switch, shaped the way production has it.
 *
 * **8 October 2026, read off production:** `publish_to_web` on Inventories was
 * hidden from forms *and* switched off. A switched-off field is skipped by
 * every save, so the switch answered 200, said "Shown on the website", stored
 * nothing and snapped back — 0 of 25,132 inventories had ever been ticked.
 *
 * So this suite puts the field in production's shape (hidden) and proves the
 * whole round trip a person makes: switch on, the CRM keeps it, the portal
 * lists it; switch off, it goes. Then it switches the field off and proves the
 * switch is no longer offered, rather than offered and ignored.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry, invalidate } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, propertyInput, signIn } from './fixtures.js';

let app: Express;
let token: string;
let id = '';
let original: { is_active: boolean; display_type: string } | null = null;

const FIELD_WHERE = `name = 'publish_to_web'
  AND module_id = (SELECT id FROM ipy_module WHERE name = 'properties')`;

async function shapeTheField(isActive: boolean): Promise<void> {
  await db.query(`UPDATE ipy_field SET is_active = $1, display_type = 'hidden' WHERE ${FIELD_WHERE}`, [isActive]);
  invalidate();
}

const state = async () => (await request(app)
  .get(`/api/records/properties/${id}/website`)
  .set('Authorization', `Bearer ${token}`)).body as { offered: boolean; shown: boolean; listed: boolean };

const flip = (on: boolean) => request(app)
  .patch(`/api/records/properties/${id}`)
  .set('Authorization', `Bearer ${token}`)
  .send({ publish_to_web: on });

const listed = async () => ((await request(app).get('/api/public/listings?limit=48&sort=newest'))
  .body as { items: { id: string }[] }).items.map((item) => item.id);

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  original = await db.queryOne(`SELECT is_active, display_type FROM ipy_field WHERE ${FIELD_WHERE}`);
  await shapeTheField(true);
  const rec = await recordService.createRecord(await adminContext(), 'properties',
    propertyInput({ status: 'Available' }));
  id = rec.id;
});

afterAll(async () => {
  if (id) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [id]);
  if (original) {
    await db.query(`UPDATE ipy_field SET is_active = $1, display_type = $2 WHERE ${FIELD_WHERE}`,
      [original.is_active, original.display_type]);
    invalidate();
  }
});

describe('the Show on website switch', () => {
  it('starts hidden, and is offered', async () => {
    expect(await state()).toEqual({ offered: true, shown: false, listed: false });
    expect(await listed()).not.toContain(id);
  });

  it('switched on, the CRM keeps it and the portal lists it — though the field is hidden from forms', async () => {
    expect((await flip(true)).status).toBe(200);
    expect(await state()).toEqual({ offered: true, shown: true, listed: true });
    expect(await listed()).toContain(id);
  });

  /*
    Ticked and marked Sold: the portal drops it on purpose, so the switch must
    not read "Live" over a home no buyer can find. `listed` is the feed's own
    rule, asked of the same row.
  */
  it('says a ticked home marked Sold is not listed, and agrees with the feed', async () => {
    await db.query(`UPDATE ipy_e_properties SET status = 'Sold' WHERE record_id = $1`, [id]);
    expect(await state()).toEqual({ offered: true, shown: true, listed: false });
    expect(await listed()).not.toContain(id);
    await db.query(`UPDATE ipy_e_properties SET status = 'Available' WHERE record_id = $1`, [id]);
    expect((await state()).listed).toBe(true);
  });

  it('switched off, it leaves the portal', async () => {
    expect((await flip(false)).status).toBe(200);
    expect(await state()).toEqual({ offered: true, shown: false, listed: false });
    expect(await listed()).not.toContain(id);
  });

  /*
    Production's exact fault. A save to a switched-off field stores nothing,
    so the switch must not be offered at all rather than offered and ignored.
  */
  it('is not offered when the field is switched off, because a save could not keep it', async () => {
    await shapeTheField(false);
    expect((await state()).offered).toBe(false);
    await shapeTheField(true);
  });
});
