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
import { signIn } from './fixtures.js';

let app: Express;
let token = '';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
});

describe('quick filter facets', () => {
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
