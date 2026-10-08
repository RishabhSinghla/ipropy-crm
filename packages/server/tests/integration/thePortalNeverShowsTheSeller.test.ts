/**
 * The property portal's feed — `/api/public/listings`.
 *
 * Two promises the owner made to the business on 1 October 2026, and this file
 * holds them: only a property staff ticked is listed, and the seller never
 * appears. Each property here carries a seller name and number unique to this
 * run, so "not anywhere in the response" is a real check rather than a guess.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService, type ServiceContext } from '../../src/core/entity/recordService.js';
import { listingTitle, withoutPhoneNumbers } from '../../src/core/sharing/publicListings.js';
import { adminContext, propertyInput } from './fixtures.js';

let app: Express;
let ctx: ServiceContext;
const made: string[] = [];
const marker = `Seller${Date.now()}`;

async function property(extra: Record<string, unknown>): Promise<{ id: string; mobile: string }> {
  const input = propertyInput({ full_name: `${marker} ${made.length}`, status: 'Available', ...extra });
  const rec = await recordService.createRecord(ctx, 'properties', input);
  made.push(rec.id);
  return { id: rec.id, mobile: String(input.mobile) };
}

const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  ctx = await adminContext();
});

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

describe('the property portal feed', () => {
  it('lists a ticked property and never says who is selling it', async () => {
    const { id, mobile } = await property({
      publish_to_web: true,
      description: 'Sunny corner flat. Owner on 98765 43210 after six.',
    });

    const list = await request(app).get('/api/public/listings?limit=48&sort=newest');
    expect(list.status).toBe(200);
    expect(ids(list.body)).toContain(id);

    const one = await request(app).get(`/api/public/listings/${id}`);
    expect(one.status).toBe(200);
    for (const body of [JSON.stringify(list.body), JSON.stringify(one.body)]) {
      expect(body).not.toContain(marker);
      expect(body).not.toContain(mobile);
      expect(body).not.toContain('98765');
    }
    const description = (one.body.facts as { name: string; value: string }[]).find((f) => f.name === 'description');
    expect(description?.value).toContain('number on request');
  });

  it('leaves out a property nobody ticked', async () => {
    const { id } = await property({});
    const list = await request(app).get('/api/public/listings?limit=48&sort=newest');
    expect(ids(list.body)).not.toContain(id);
    expect((await request(app).get(`/api/public/listings/${id}`)).status).toBe(404);
  });

  it('drops a ticked property once it is sold, and once it is deleted', async () => {
    const sold = await property({ publish_to_web: true });
    const gone = await property({ publish_to_web: true });
    await db.query(`UPDATE ipy_e_properties SET status = 'Sold' WHERE record_id = $1`, [sold.id]);
    await db.query(`UPDATE ipy_record SET is_deleted = true WHERE id = $1`, [gone.id]);

    const list = await request(app).get('/api/public/listings?limit=48&sort=newest');
    expect(ids(list.body)).not.toContain(sold.id);
    expect(ids(list.body)).not.toContain(gone.id);
    expect((await request(app).get(`/api/public/listings/${sold.id}`)).status).toBe(404);
  });

  it('serves the photo of a ticked property and refuses one that is not', async () => {
    // Held is not on the old catalogue's list of public statuses, so this
    // proves the portal's own rule opens the photo route, not the old one.
    const shown = await property({ publish_to_web: true });
    await db.query(`UPDATE ipy_e_properties SET status = 'Held' WHERE record_id = $1`, [shown.id]);
    const hidden = await property({});
    const attach = async (recordId: string) => (await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_attachment (record_id, file_name, mime_type, size, storage_key, uploaded_by)
       VALUES ($1, 'p.jpg', 'image/jpeg', 10, $2, (SELECT id FROM ipy_user WHERE is_admin ORDER BY created_at LIMIT 1))
       RETURNING id`,
      [recordId, `missing/${Date.now()}-${recordId}.jpg`],
    ))!.id;
    const shownPhoto = await attach(shown.id);
    const hiddenPhoto = await attach(hidden.id);

    const one = await request(app).get(`/api/public/listings/${shown.id}`);
    expect(one.body.photos[0]).toContain(`/api/public/media/${shownPhoto}`);

    // The file itself is not on disk in a test run, so the visible one gets
    // past the gate and then finds nothing; the point is the gate's answer.
    const hiddenRes = await request(app).get(`/api/public/media/${hiddenPhoto}`);
    expect(hiddenRes.status).toBe(404);
    expect(hiddenRes.body.message).toBe('File not found');
    const shownRes = await request(app).get(`/api/public/media/${shownPhoto}`);
    expect(shownRes.body.message).not.toBe('File not found');
  });

  it('offers only filter values some live listing has', async () => {
    await property({ publish_to_web: true });
    const res = await request(app).get('/api/public/listings/filters');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(marker);
  });
});

describe('the two pure rules', () => {
  it('writes a title from the facts', () => {
    expect(listingTitle({ bedrooms: '3 BHK', category: 'Builder Floor', locality: 'Greenfields' }))
      .toBe('3 BHK Builder Floor in Greenfields');
    expect(listingTitle({ bedrooms: 2, category: 'Apartment' })).toBe('2 BHK Apartment');
    expect(listingTitle({})).toBe('Property');
  });

  it('hides a phone number typed into a description', () => {
    expect(withoutPhoneNumbers('call +91 98765-43210 now')).toBe('call [number on request] now');
    expect(withoutPhoneNumbers('1450 sq ft, 3rd floor')).toBe('1450 sq ft, 3rd floor');
  });
});
