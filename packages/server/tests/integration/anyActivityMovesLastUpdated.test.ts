/**
 * Anything done on a record moves its "last updated", not only a form edit.
 *
 * The owner, 2 October 2026: *"any sort of small to big activity inside that
 * record its last updated be changed and not just on form"*. So a note and a
 * tag each move `updated_at` — which is what the queue's "2h ago", the Updated
 * date filter and "Recently updated" all read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, signIn } from './fixtures.js';

let app: Express;
let token = '';
let recordId = '';

const LONG_AGO = '2020-01-01T00:00:00Z';

async function updatedAt(): Promise<number> {
  const row = await db.queryOne<{ updated_at: Date }>(`SELECT updated_at FROM ipy_record WHERE id = $1`, [recordId]);
  return new Date(row!.updated_at).getTime();
}

async function makeItOld(): Promise<void> {
  await db.query(`UPDATE ipy_record SET updated_at = $2 WHERE id = $1`, [recordId, LONG_AGO]);
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  token = await signIn(app, 'admin@ipropy.com');
  const lead = await recordService.createRecord(await adminContext(), 'leads', {
    full_name: `Activity Moves Updated ${Date.now()}`,
    mobile: `98${String(Date.now()).slice(-8)}`,
  });
  recordId = lead.id;
});

afterAll(async () => {
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

describe('last updated follows activity', () => {
  it('moves when somebody leaves a note', async () => {
    await makeItOld();
    await request(app).post(`/api/records/leads/${recordId}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'Rang them, call back Tuesday' })
      .expect(201);
    expect(await updatedAt()).toBeGreaterThan(new Date(LONG_AGO).getTime());
  });

  it('moves when somebody tags the record', async () => {
    await makeItOld();
    await request(app).post(`/api/records/leads/${recordId}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tags: ['itest-activity'] })
      .expect(200);
    expect(await updatedAt()).toBeGreaterThan(new Date(LONG_AGO).getTime());
  });
});
