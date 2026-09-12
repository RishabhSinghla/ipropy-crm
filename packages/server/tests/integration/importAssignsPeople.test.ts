/**
 * "Rakesh" in a spreadsheet, and the colleague it means.
 *
 * An owner field stores a user id and no spreadsheet holds one, so a perfectly
 * ordinary Assigned To column used to fail every row with "Assigned To must
 * reference a valid record" — true, and useless to the person holding the
 * file.
 *
 * The half that matters as much: a first name two colleagues share resolves to
 * neither. Guessing which Rahul owns two hundred leads is not a guess worth
 * making, and the row says so instead.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let owner = { id: '', name: '', email: '', first: '' };
/** Looked up, not assumed: the owner field is named differently across seeds. */
let ownerField = 'assigned_to';
const MOBILES = ['9800000051', '9800000052', '9800000053'];

async function dryRun(rows: string[]): Promise<{ row: number; outcome: string;
  problems: string[]; values: Record<string, unknown> }[]> {
  const res = await request(app).post('/api/import/leads/dry-run')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(['Name,Phone,Owner', ...rows].join('\n'), 'utf8'), 'owners.csv')
    .field('mapping', JSON.stringify({ Name: 'full_name', Phone: 'mobile', Owner: ownerField }))
    .expect(200);
  return res.body.rows;
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = await signIn(app, admin!.email);

  const u = await db.queryOne<{ id: string; name: string; email: string; first: string }>(
    `SELECT id, trim(concat_ws(' ', first_name, last_name)) AS name, email, first_name AS first
       FROM ipy_user
      WHERE is_active = true AND deleted_at IS NULL AND last_name <> '' AND first_name <> ''
        AND first_name NOT IN (
          SELECT first_name FROM ipy_user WHERE is_active AND deleted_at IS NULL
           GROUP BY first_name HAVING count(*) > 1)
      ORDER BY created_at LIMIT 1`);
  owner = u!;

  const leads = await registry.requireModule('leads');
  const f = leads.fields.find((x) => x.uitype === 'owner' || x.uitype === 'user');
  if (!f) throw new Error('the leads module has no owner field');
  ownerField = f.name;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_record r USING ipy_e_leads l
                   WHERE l.record_id = r.id AND l.mobile = ANY($1::text[])`, [MOBILES]);
});

describe('an Assigned To column', () => {
  it('finds the person by email, by full name and by first name', async () => {
    const rows = await dryRun([
      `A,${MOBILES[0]},${owner.email}`,
      `B,${MOBILES[1]},${owner.name}`,
      `C,${MOBILES[2]},${owner.first}`,
    ]);
    for (const r of rows) {
      expect(r.problems, `row ${r.row}`).toEqual([]);
      expect(r.values[ownerField], 'shown as a person, not a uuid').toBe(owner.name);
    }
  });

  it('says who it could not find rather than failing with a foreign key', async () => {
    const [row] = await dryRun([`D,${MOBILES[0]},Nobody Here At All`]);
    expect(row.outcome).toBe('failed');
    expect(row.problems[0]).toContain('nobody here called');
  });

  it('actually assigns the record', async () => {
    const res = await request(app).post('/api/import/leads')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(`Name,Phone,Owner\nAssigned,${MOBILES[0]},${owner.first}\n`, 'utf8'), 'o.csv')
      .field('mapping', JSON.stringify({ Name: 'full_name', Phone: 'mobile', Owner: ownerField }))
      .field('duplicateHandling', 'create')
      .expect(202);

    for (let i = 0; i < 60; i += 1) {
      const job = await db.queryOne<{ status: string }>(
        `SELECT status FROM ipy_import_job WHERE id = $1`, [res.body.jobId]);
      if (job && job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const row = await db.queryOne<{ owner_id: string }>(
      `SELECT r.owner_id FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE l.mobile = $1 AND r.is_deleted = false`, [MOBILES[0]]);
    expect(row?.owner_id).toBe(owner.id);
  });
});
