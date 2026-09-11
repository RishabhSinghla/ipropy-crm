/**
 * Where a record came from belongs in its own history.
 *
 * "Record created" was the same sentence whether somebody typed the record or
 * it arrived in a file of four thousand — the audit trail carries a source and
 * the import never set one. A week later that is the difference between "the
 * rep chose Referral" and "the whole file was referrals", and nothing on the
 * record could tell you which.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';

let app: ReturnType<typeof createApp>;
let token = '';
const MOBILE = `95${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

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
                   WHERE l.record_id = r.id AND l.mobile = $1`, [MOBILE]);
});

describe('a record that arrived in a file', () => {
  it('says so in its history', async () => {
    const res = await request(app).post('/api/import/leads')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(`Name,Phone\nFrom A File,${MOBILE}\n`, 'utf8'), 'history.csv')
      .field('mapping', JSON.stringify({ Name: 'full_name', Phone: 'mobile' }))
      .field('duplicateHandling', 'create')
      .expect(202);

    for (let i = 0; i < 60; i += 1) {
      const job = await db.queryOne<{ status: string }>(
        `SELECT status FROM ipy_import_job WHERE id = $1`, [res.body.jobId]);
      if (job && job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const row = await db.queryOne<{ record_id: string }>(
      `SELECT l.record_id FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE l.mobile = $1 AND r.is_deleted = false`, [MOBILE]);

    const audit = await db.queryOne<{ source: string }>(
      `SELECT source FROM ipy_audit WHERE record_id = $1 AND action = 'create'`, [row!.record_id]);
    expect(audit?.source, 'the audit row knows it was an import').toBe('import');

    const timeline = await request(app).get(`/api/records/leads/${row!.record_id}/timeline`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    const entries = (Array.isArray(timeline.body) ? timeline.body : timeline.body.entries) as
      { title: string }[];
    expect(entries.some((e) => e.title === 'Record created by import'),
      'and the person reading the record can see it').toBe(true);
  });
});
