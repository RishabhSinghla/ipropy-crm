import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

let app: Express;
let token: string;

const auth = (method: 'get' | 'post' | 'patch', path: string) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM ipy_user
     WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  if (!admin) throw new Error('Seed admin missing');
  const email = `live-lists-${randomUUID()}@itest.ipropy`;
  await db.query(
    `INSERT INTO ipy_user (email, password_hash, first_name, last_name, is_admin)
     VALUES ($1,$2,'Live','Lists Test',true)`,
    [email, admin.password_hash],
  );
  token = await signIn(app, email);
});

describe('live list attention and favourites', () => {
  /*
    **The unread highlight went on 3 October 2026** — the owner: *"remove unread
    functionality from all records."* `POST /:module/unseen` and the amber dot it
    fed are gone, so there is nothing here to clear. Favourites, below, are the
    other half of what this suite was about and are untouched.
  */
  it('returns per-user favourite state with every list row', async () => {
    const marker = `Gold favourite ${randomUUID()}`;
    const created = await auth('post', '/api/records/properties').send({ full_name: marker, mobile: `98${Math.floor(10_000_000 + Math.random() * 89_999_999)}` }).expect(201);
    const id = created.body.id as string;
    const list = () => auth('get', `/api/records/properties?search=${encodeURIComponent(marker)}&pageSize=5`);

    const before = await list().expect(200);
    expect(before.body.rows).toHaveLength(1);
    expect(before.body.rows[0]).toMatchObject({ id, starred: false });

    await auth('post', `/api/records/properties/${id}/star`).send({ starred: true }).expect(200);
    const after = await list().expect(200);
    expect(after.body.rows[0]).toMatchObject({ id, starred: true });

    await auth('post', `/api/records/leads/${id}/star`).send({ starred: true }).expect(404);
  });

  it('always returns a factual record summary when the AI provider is unavailable', async () => {
    const marker = `Summary ${randomUUID()}`;
    const created = await auth('post', '/api/records/leads').send({
      full_name: marker,
      mobile: `97${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    }).expect(201);

    const summary = await auth('post', `/api/ai/summarise/leads/${created.body.id}`).send({}).expect(200);
    expect(summary.body.summary).toContain(marker);
    expect(summary.body.summary).toContain('Next steps to close:');
  });
});
