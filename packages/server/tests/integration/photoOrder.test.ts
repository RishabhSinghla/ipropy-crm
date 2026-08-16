/**
 * Which photo goes first, and whether everyone agrees about it.
 *
 * Four surfaces render the same set — the record carousel, the Files tab, a
 * share link sent to a buyer, and the zip somebody downloads — and they used
 * to order it three different ways. The share link led with `ai_category`, so
 * the shot a rep saw leading a property was not the one the buyer got. That is
 * the bug worth a test: not that ordering works, but that the surfaces agree.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { db } from '../../src/db/pool.js';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { createRecord } from '../../src/core/entity/recordService.js';
import { adminContext } from './fixtures.js';

let app: Express;
let token = '';
let recordId = '';
const ids: string[] = [];

/** Three photos, deliberately inserted out of any natural order. */
async function seedPhoto(name: string, capturedAt: string, aiCategory: string | null): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_attachment
       (record_id, file_name, mime_type, size, storage_key, captured_at, ai_category, cull_state)
     VALUES ($1,$2,'image/png',100,$3,$4,$5,'keep')
     RETURNING id`,
    [recordId, name, `test/${name}`, capturedAt, aiCategory],
  );
  return row!.id;
}

beforeAll(async () => {
  // supertest bypasses boot, and the record routes need the registry loaded.
  await registry.warmup();
  app = createApp();

  const adminRow = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: adminRow!.email, password: 'Admin@123' });
  expect(login.status).toBe(200);
  token = login.body.token as string;

  const admin = await adminContext();
  const property = await createRecord(admin, 'properties', {
    name: `Photo Order ${Date.now()}`,
    status: 'Available',
  });
  recordId = property.id;

  // Shot in this order; `ai_category` set so the old share-link ordering would
  // have produced a different answer from the Files tab.
  ids.push(await seedPhoto('a-first-shot.png', '2026-01-01T09:00:00Z', 'living_room'));
  ids.push(await seedPhoto('b-second-shot.png', '2026-01-01T09:05:00Z', 'bedroom'));
  ids.push(await seedPhoto('c-third-shot.png', '2026-01-01T09:10:00Z', 'balcony'));
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_attachment WHERE record_id = $1`, [recordId]);
});

async function fileOrder(): Promise<string[]> {
  const res = await request(app)
    .get(`/api/records/${recordId}/files`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (res.body as { file_name: string }[]).map((f) => f.file_name);
}

describe('photo order', () => {
  it('falls back to capture order until somebody arranges it', async () => {
    expect(await fileOrder()).toEqual(['a-first-shot.png', 'b-second-shot.png', 'c-third-shot.png']);
  });

  it('honours an explicit arrangement', async () => {
    const res = await request(app)
      .put(`/api/records/${recordId}/files/order`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [ids[2], ids[0], ids[1]] });
    expect(res.status).toBe(200);
    expect(await fileOrder()).toEqual(['c-third-shot.png', 'a-first-shot.png', 'b-second-shot.png']);
  });

  it('shows a buyer the same order the rep arranged', async () => {
    const created = await request(app)
      .post(`/api/records/properties/${recordId}/share-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(created.status).toBeLessThan(300);

    const shared = await request(app).get(`/api/public/share/${created.body.token}`);
    expect(shared.status).toBe(200);

    const shownIds = (shared.body.photos as { url: string }[]).map((p) => p.url.split('/').pop());
    // The arrangement, not `ai_category` — which is what it used to be.
    expect(shownIds).toEqual([ids[2], ids[0], ids[1]]);
  });

  it('ignores ids belonging to another record rather than failing the save', async () => {
    const res = await request(app)
      .put(`/api/records/${recordId}/files/order`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [ids[1], '00000000-0000-0000-0000-000000000000', ids[0], ids[2]] });
    expect(res.status).toBe(200);
    expect(await fileOrder()).toEqual(['b-second-shot.png', 'a-first-shot.png', 'c-third-shot.png']);
  });
});
