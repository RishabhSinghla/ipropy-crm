/**
 * What the Quick & Live Filters panel asks the server: a field's top values,
 * and a number field's lowest and highest — the ends of its slider.
 *
 * Both run through the reporting engine, so they are counted as the person
 * asking. The SQL is a string, so only a real database can say Postgres
 * accepts it; and the route sits beside `/:module/:id`, which would take
 * "facet" as a record id if it were registered after it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn, authUser, SEEDED, leadInput, adminContext } from './fixtures.js';
import { recordService } from '../../src/core/entity/recordService.js';

let app: Express;
let token = '';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
});

describe('quick filter facets', () => {
  it('counts tags and unfilled for the search and owner, and recounts tag edits', async () => {
    const ownerA = await authUser(SEEDED.executiveA);
    const ownerB = await authUser(SEEDED.executiveB);
    const ctx = await adminContext();
    const marker = `TagFacet-${Date.now()}`;
    const a = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${marker} A`, owner_id: ownerA.id }));
    await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${marker} Blank`, owner_id: ownerA.id }));
    const b = await recordService.createRecord(ctx, 'leads', leadInput({ full_name: `${marker} B`, owner_id: ownerB.id }));
    for (const id of [a.id, b.id]) await request(app).post(`/api/records/leads/${id}/tags`).set('Authorization', `Bearer ${token}`).send({ tags: ['facet-test-hot'] }).expect(200);
    const facet = async (owner?: string) => {
      const context = { search: marker, ...(owner ? { filter: { logic: 'AND', conditions: [{ field: 'owner_id', operator: 'equals', value: owner }] } } : {}) };
      return (await request(app).get('/api/records/leads/facet').query({ field: 'record_tags', context: JSON.stringify(context) }).set('Authorization', `Bearer ${token}`).expect(200)).body;
    };
    expect((await facet()).values).toContainEqual(expect.objectContaining({ value: 'facet-test-hot', count: 2 }));
    expect((await facet(ownerA.id)).values).toContainEqual(expect.objectContaining({ value: 'facet-test-hot', count: 1 }));
    expect((await facet(ownerA.id)).blank).toBe(1);
    expect((await facet(ownerB.id)).blank).toBe(0);
    await request(app).post(`/api/records/leads/${a.id}/tags`).set('Authorization', `Bearer ${token}`).send({ tags: [] }).expect(200);
    expect((await facet(ownerA.id)).blank).toBe(2);
    expect((await facet(ownerA.id)).values).toEqual([]);
  });
  it('counts the same filtered search as the visible list', async () => {
    const context = { search: `facet-no-match-${Date.now()}`, filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'today' }] } };
    const list = await request(app).get('/api/records/leads').query({ ...context, filter: JSON.stringify(context.filter), pageSize: 1 }).set('Authorization', `Bearer ${token}`).expect(200);
    const facet = await request(app).get('/api/records/leads/facet').query({ field: 'status', limit: 50, context: JSON.stringify(context) }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.total).toBe(0);
    expect(facet.body.values).toEqual([]);
    expect(facet.body.blank).toBe(0);
  });
  it('answers a picklist field with its values, most used first', async () => {
    const res = await request(app).get('/api/records/leads/facet')
      .query({ field: 'status', limit: 10 })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const values = res.body.values as { value: string; label: string; count: number }[];
    expect(Array.isArray(values)).toBe(true);
    for (const row of values) {
      expect(typeof row.value).toBe('string');
      expect(row.value).not.toBe('');
      expect(typeof row.label).toBe('string');
    }
    const counts = values.map((row) => row.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('counts how the last call went, and how many were never called', async () => {
    // Record-level ideas every module has — the call outcome and who owns it —
    // are counted too, so every quick filter can show its numbers.
    const res = await request(app).get('/api/records/leads/facet')
      .set('Authorization', `Bearer ${token}`)
      .query({ field: 'last_call_disposition', limit: 50 })
      .expect(200);
    expect(Array.isArray(res.body.values)).toBe(true);
    expect(typeof res.body.blank).toBe('number');
    const owners = await request(app).get('/api/records/leads/facet')
      .set('Authorization', `Bearer ${token}`)
      .query({ field: 'owner_id', limit: 50 })
      .expect(200);
    expect(Array.isArray(owners.body.values)).toBe(true);
  });

  it('narrows to values containing the words typed', async () => {
    const res = await request(app).get('/api/records/leads/facet')
      .query({ field: 'status', search: 'zzz-no-such-value' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.values).toEqual([]);
  });

  it('gives a number field its lowest and highest value', async () => {
    const res = await request(app).get('/api/records/leads/facet-range')
      .query({ field: 'budget' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const { min, max } = res.body as { min: number | null; max: number | null };
    if (min !== null && max !== null) expect(min).toBeLessThanOrEqual(max);
  });

  it('refuses a field the module does not have, rather than guessing', async () => {
    await request(app).get('/api/records/leads/facet')
      .query({ field: 'no_such_field' })
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('asks who is asking', async () => {
    await request(app).get('/api/records/leads/facet').query({ field: 'status' }).expect(401);
  });
});
