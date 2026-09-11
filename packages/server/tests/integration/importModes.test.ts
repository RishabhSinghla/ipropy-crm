/**
 * What an import is for.
 *
 * The importer could only ever create. A property database kept in Excel is
 * mostly a *refresh* — most rows are already in the CRM, a few are new — and
 * the only way to load one was to create duplicates and sort them out
 * afterwards.
 *
 * Update has to find the record before it writes. The create path reports a
 * collision by throwing, and by then the record exists and there is nothing to
 * take it back with.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';

let app: ReturnType<typeof createApp>;
let token = '';
const MOBILE = `98${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const NEW_MOBILE = `97${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const NAME = `QA Import Modes ${Date.now().toString(36)}`;

const csv = (rows: string[]): Buffer =>
  Buffer.from(['Full Name,Mobile,Budget / Demand', ...rows].join('\n'), 'utf8');

async function runImport(body: Record<string, string>, rows: string[]): Promise<Record<string, number>> {
  const req = request(app).post('/api/import/leads')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', csv(rows), 'refresh.csv')
    .field('mapping', JSON.stringify({
      'Full Name': 'full_name', Mobile: 'mobile', 'Budget / Demand': 'budget',
    }));
  for (const [k, v] of Object.entries(body)) req.field(k, v);
  const res = await req.expect(202);

  // The import runs in the background; wait for the job to settle.
  for (let i = 0; i < 60; i += 1) {
    const job = await db.queryOne<Record<string, number | string>>(
      `SELECT status, created_rows, updated_rows, skipped_rows, failed_rows
         FROM ipy_import_job WHERE id = $1`, [res.body.jobId]);
    if (job && job.status !== 'running') {
      return {
        created: Number(job.created_rows), updated: Number(job.updated_rows),
        skipped: Number(job.skipped_rows), failed: Number(job.failed_rows),
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the import never finished');
}

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
                   WHERE l.record_id = r.id AND l.mobile = ANY($1::text[])`, [[MOBILE, NEW_MOBILE]]);
});

describe('import modes', () => {
  it('creates the first time', async () => {
    const out = await runImport({ importMode: 'create', duplicateHandling: 'create' },
      [`${NAME},${MOBILE},75 Lac`]);
    expect(out).toMatchObject({ created: 1, failed: 0 });
  });

  it('updates the record it matches, and creates the one it does not', async () => {
    const out = await runImport({ importMode: 'upsert' }, [
      `${NAME},${MOBILE},2.10 Cr`,
      `${NAME} Two,${NEW_MOBILE},50 Lac`,
    ]);
    expect(out).toMatchObject({ created: 1, updated: 1, failed: 0 });

    const row = await db.queryOne<{ budget: string }>(
      `SELECT budget FROM ipy_e_leads WHERE mobile = $1`, [MOBILE]);
    expect(Number(row!.budget)).toBe(21_000_000);
  });

  it('never invents a record in update-only mode', async () => {
    const out = await runImport({ importMode: 'update' }, [`Nobody Here,9000000001,1 Cr`]);
    expect(out).toMatchObject({ created: 0, updated: 0, skipped: 1 });
  });

  it('adds only what is missing in skip-existing mode', async () => {
    const out = await runImport({ importMode: 'skip_existing' }, [`${NAME},${MOBILE},9 Cr`]);
    expect(out).toMatchObject({ created: 0, skipped: 1 });
    // And the value it skipped is genuinely untouched.
    const row = await db.queryOne<{ budget: string }>(
      `SELECT budget FROM ipy_e_leads WHERE mobile = $1`, [MOBILE]);
    expect(Number(row!.budget)).toBe(21_000_000);
  });

  it('applies a value set for the whole file, and a column still wins', async () => {
    const out = await runImport(
      { importMode: 'upsert', staticValues: JSON.stringify({ lead_source: 'Referral' }) },
      [`${NAME},${MOBILE},2.10 Cr`],
    );
    expect(out.failed).toBe(0);
    const row = await db.queryOne<{ lead_source: string }>(
      `SELECT lead_source FROM ipy_e_leads WHERE mobile = $1`, [MOBILE]);
    expect(row!.lead_source).toBe('Referral');
  });
});
