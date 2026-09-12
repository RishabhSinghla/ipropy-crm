/** Full attachment lifecycle through the same HTTP API the Files tab uses. */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { getDriver } from '../../src/core/storage/index.js';
import { SEEDED, adminContext, propertyInput, signIn } from './fixtures.js';

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

describe('record files', () => {
  it('creates, opens, lists, renames, categorises and deletes a uniquely marked file', async () => {
    const ctx = await adminContext();
    const marker = `file-crud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const record = await recordService.createRecord(ctx, 'properties', propertyInput({ full_name: `Property ${marker}` }));
    const originalBytes = Buffer.from(`original ${marker}`);

    const uploaded = await request(app).post('/api/files')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('recordId', record.id)
      .field('module', 'properties')
      .attach('file', originalBytes, { filename: `${marker}.txt`, contentType: 'text/plain' })
      .expect(201);
    const fileId = uploaded.body.id as string;

    const opened = await request(app).get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const received = Buffer.isBuffer(opened.body) ? opened.body : Buffer.from(opened.text);
    expect(received).toEqual(originalBytes);

    const listed = await request(app).get(`/api/records/${record.id}/files`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(listed.body.find((file: { id: string }) => file.id === fileId).file_name).toBe(`${marker}.txt`);

    const renamed = `${marker}-renamed.txt`;
    await request(app).patch(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fileName: renamed, category: 'Agreement' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.file_name).toBe(renamed);
        expect(body.category).toBe('Agreement');
      });

    // A viewer cannot silently turn record-read access into file-edit access.
    const viewer = await signIn(app, SEEDED.executiveB);
    await request(app).patch(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${viewer}`)
      .send({ fileName: 'not-allowed.txt' })
      .expect(403);

    const attachment = await db.queryOne<{ storage_key: string }>(
      `SELECT storage_key FROM ipy_attachment WHERE id = $1`, [fileId],
    );
    const derivative = `itest/${marker}-derived.webp`;
    const driver = await getDriver();
    await driver.save(derivative, Buffer.from(`derived ${marker}`), 'image/webp');
    await db.query(
      `UPDATE ipy_attachment SET variants = $2::jsonb WHERE id = $1`,
      [fileId, JSON.stringify({ thumb: derivative })],
    );

    await request(app).delete(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(await db.queryOne(`SELECT id FROM ipy_attachment WHERE id = $1`, [fileId])).toBeNull();
    expect(await driver.read(attachment!.storage_key)).toBeNull();
    expect(await driver.read(derivative)).toBeNull();
  });
});
