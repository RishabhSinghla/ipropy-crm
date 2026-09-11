/**
 * Undoing an import.
 *
 * It removes what the file added and nothing else. An update overwrote values
 * that were never kept anywhere, so there is nothing to put back — and the
 * honest thing is to say so rather than to quietly leave half the change
 * behind a button labelled Undo.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';

let app: ReturnType<typeof createApp>;
let token = '';
const A = `97${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const B = `97${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const NAME = `QA Undo ${Date.now().toString(36)}`;

async function importRows(rows: string[], body: Record<string, string> = {}): Promise<string> {
  const req = request(app).post('/api/import/leads')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(['Full Name,Mobile,Budget / Demand', ...rows].join('\n'), 'utf8'), 'undo.csv')
    .field('mapping', JSON.stringify({ 'Full Name': 'full_name', Mobile: 'mobile', 'Budget / Demand': 'budget' }))
    .field('duplicateHandling', 'create');
  for (const [k, v] of Object.entries(body)) req.field(k, v);
  const res = await req.expect(202);
  for (let i = 0; i < 60; i += 1) {
    const job = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_import_job WHERE id = $1`, [res.body.jobId]);
    if (job && job.status !== 'running') return res.body.jobId as string;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the import never finished');
}

const liveCount = async (): Promise<number> => {
  const row = await db.queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
      WHERE l.mobile = ANY($1::text[]) AND r.is_deleted = false`, [[A, B]]);
  return Number(row?.n ?? 0);
};

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = (await request(app).post('/api/auth/login')
    .send({ email: admin!.email, password: 'Admin@123' })).body.token;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record r USING ipy_e_leads l
                   WHERE l.record_id = r.id AND l.mobile = ANY($1::text[])`, [[A, B]]);
});

describe('undoing an import', () => {
  it('removes what the file added', async () => {
    const jobId = await importRows([`${NAME},${A},50 Lac`, `${NAME} Two,${B},60 Lac`]);
    expect(await liveCount()).toBe(2);

    const res = await request(app).post(`/api/import/jobs/${jobId}/rollback`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toMatchObject({ deleted: 2, failed: 0 });
    expect(await liveCount()).toBe(0);
  });

  it('says nothing was left to remove rather than failing', async () => {
    const jobId = await importRows([`${NAME} Three,${A},70 Lac`]);
    await request(app).post(`/api/import/jobs/${jobId}/rollback`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    const again = await request(app).post(`/api/import/jobs/${jobId}/rollback`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(again.body).toMatchObject({ deleted: 0, gone: 1, failed: 0 });
  });

  it('counts the updates it cannot undo, and leaves them alone', async () => {
    await importRows([`${NAME} Keep,${B},80 Lac`]);
    const jobId = await importRows([`${NAME} Keep,${B},9 Cr`], { importMode: 'update' });

    const res = await request(app).post(`/api/import/jobs/${jobId}/rollback`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toMatchObject({ deleted: 0, keptUpdates: 1 });

    // Deliberately narrowed to the live record: the earlier undo left a
    // soft-deleted row with the same mobile, and an unordered query over both
    // reads back whichever one Postgres reaches first.
    const row = await db.queryOne<{ budget: string }>(
      `SELECT l.budget FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE l.mobile = $1 AND r.is_deleted = false`, [B]);
    expect(Number(row!.budget), 'the updated value stays — it is what the undo cannot reach').toBe(90_000_000);
  });
});
