/**
 * The import template is generated from live metadata and handed to the user
 * as the thing they fill in. If it drifts from what the importer accepts — a
 * header that does not match, a picklist sample that is not a real option —
 * the whole "stupidly simple" path breaks, so the shape is pinned here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { createApp } from '../../src/app.js';
import { signIn } from './fixtures.js';

let app: Express;
let adminToken: string;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  adminToken = await signIn(app, admin!.email);
});

describe('the import template', () => {
  it('is a CSV whose headers name real, importable fields', async () => {
    const res = await request(app)
      .get('/api/import/leads/template')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);

    const lines = res.text.trim().split('\n');
    expect(lines.length).toBe(2); // header + one sample row

    const module = await registry.requireModule('leads');
    const importable = module.fields.filter(
      (f) => f.isActive && !f.isReadonly && f.displayType !== 'hidden',
    );
    for (const f of importable) {
      const marker = f.isMandatory ? `${f.label} *` : f.label;
      expect(lines[0]).toContain(f.label);
      void marker;
    }
  });

  it('samples picklists with real option values, not invented ones', async () => {
    const res = await request(app)
      .get('/api/import/leads/template')
      .set('Authorization', `Bearer ${adminToken}`);

    const lines = res.text.trim().split('\n');
    const headers = lines[0].split(',');
    const sample = lines[1].split(',');

    const module = await registry.requireModule('leads');
    const configuration = module.fields.find((f) => f.name === 'configuration');
    if (configuration?.options?.length) {
      const i = headers.findIndex((h) => h.includes(configuration.label));
      expect(i).toBeGreaterThanOrEqual(0);
      // The sample cell carries two options joined the way the importer
      // splits lists ("A; B"); every element must be one of the dropdown's
      // own values, so an unchanged upload passes the invalid-values check.
      const values = configuration.options.filter((o) => o.isActive).map((o) => o.value);
      for (const part of sample[i].split(';').map((s) => s.trim())) {
        expect(values).toContain(part);
      }
    }
  });

  it('marks required fields with a star that header matching still accepts', async () => {
    const res = await request(app)
      .get('/api/import/leads/template')
      .set('Authorization', `Bearer ${adminToken}`);

    const lines = res.text.trim().split('\n');
    expect(lines[0]).toMatch(/Full Name \*/);
    // Matching strips everything but letters and numbers, so the starred
    // header still resolves to the field.
    const normalised = lines[0].split(',').find((h) => h.includes('Full Name'))!
      .toLowerCase().replace(/[^a-z0-9]/g, '');
    expect(normalised).toBe('fullname');
  });

  it('refuses a stranger', async () => {
    await request(app).get('/api/import/leads/template').expect(401);
  });
});
