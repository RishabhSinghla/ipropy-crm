/**
 * The report's SQL is a string, so only a real database proves Postgres accepts it.
 * It also pins who sees what: an admin sees every agent, a rep is forced to their own numbers.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn, SEEDED } from './fixtures.js';

let app: Express;
let adminToken = '';
let repToken = '';
const range = `from=${new Date(Date.now() - 30 * 864e5).toISOString()}&to=${new Date(Date.now() + 864e5).toISOString()}`;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  adminToken = await signIn(app, 'admin@ipropy.com');
  repToken = await signIn(app, SEEDED.executiveA);
});

describe('what earns money', () => {
  it('answers for an admin with the full shape', async () => {
    const res = await request(app).get(`/api/dashboards/roi?${range}&windowDays=7`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.scopedToMe).toBe(false);
    expect(Array.isArray(res.body.channels)).toBe(true);
    expect(res.body.total).toHaveProperty('won');
    expect(res.body.costs.whatsappMarketing).toBeGreaterThan(0);
  });

  it('forces a rep to their own numbers', async () => {
    const res = await request(app).get(`/api/dashboards/roi?${range}&windowDays=14`).set('Authorization', `Bearer ${repToken}`);
    expect(res.status).toBe(200);
    expect(res.body.scopedToMe).toBe(true);
    expect(res.body.options.agents).toEqual([]);
  });

  it('refuses an attribution window that is not 3, 7 or 14 days', async () => {
    const res = await request(app).get(`/api/dashboards/roi?${range}&windowDays=5`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
