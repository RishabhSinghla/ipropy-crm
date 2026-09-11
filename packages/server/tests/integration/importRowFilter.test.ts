/**
 * Importing part of a file.
 *
 * A portal export holds everything the portal has — closed enquiries, other
 * cities, the commercial stock a residential desk does not want. The answer
 * otherwise is to delete rows in Excel first, which loses the file somebody
 * was sent and takes an hour.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';

let app: ReturnType<typeof createApp>;
let token = '';
const MOBILES = ['9800000094', '9800000095', '9800000096'];
const csv = Buffer.from(
  'Name,Phone,Type\n'
  + `Res One,${MOBILES[0]},Residential\n`
  + `Comm One,${MOBILES[1]},Commercial\n`
  + `Res Two,${MOBILES[2]},Residential\n`, 'utf8');
const MAPPING = JSON.stringify({ Name: 'full_name', Phone: 'mobile' });
const ONLY_RESIDENTIAL = JSON.stringify([{ header: 'Type', op: 'is', value: 'Residential' }]);

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
                   WHERE l.record_id = r.id AND l.mobile = ANY($1::text[])`, [MOBILES]);
});

describe('importing only some of the rows', () => {
  it('shows the rows that survive, and counts the rest', async () => {
    const res = await request(app).post('/api/import/leads/dry-run')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'mixed.csv')
      .field('mapping', MAPPING)
      .field('rowFilters', ONLY_RESIDENTIAL)
      .expect(200);

    expect(res.body.shown, 'the preview is of what will happen, not of what was excluded').toBe(2);
    expect(res.body.filtered).toBe(1);
    expect(res.body.filteredBecause).toContain('Commercial');
  });

  it('imports only those rows', async () => {
    const res = await request(app).post('/api/import/leads')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'mixed.csv')
      .field('mapping', MAPPING)
      .field('duplicateHandling', 'create')
      .field('rowFilters', ONLY_RESIDENTIAL)
      .expect(202);

    for (let i = 0; i < 60; i += 1) {
      const job = await db.queryOne<{ status: string }>(
        `SELECT status FROM ipy_import_job WHERE id = $1`, [res.body.jobId]);
      if (job && job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const job = await db.queryOne<{ created_rows: number; skipped_rows: number }>(
      `SELECT created_rows, skipped_rows FROM ipy_import_job WHERE id = $1`, [res.body.jobId]);
    expect(job).toMatchObject({ created_rows: 2, skipped_rows: 1 });

    const live = await db.queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE l.mobile = $1 AND r.is_deleted = false`, [MOBILES[1]]);
    expect(Number(live!.n), 'the commercial row was never written').toBe(0);
  });

  it('ignores a condition naming a column the file has not got', async () => {
    const res = await request(app).post('/api/import/leads/dry-run')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'mixed.csv')
      .field('mapping', MAPPING)
      // A saved template outliving a change to the export is the ordinary way
      // this happens; rejecting every row would read as a broken importer.
      .field('rowFilters', JSON.stringify([{ header: 'City', op: 'is', value: 'Pune' }]))
      .expect(200);
    expect(res.body.filtered).toBe(0);
    expect(res.body.shown).toBe(3);
  });
});
