/**
 * A field somebody cannot see is a field they cannot fill from a spreadsheet.
 *
 * Field permissions are enforced on the way out — `stripHidden` runs on every
 * read. The import is a way in, and a new one: it takes a column, a field name
 * and a file, and writes. If it does not ask the same question, then a profile
 * that hides Budget hides it from the screen and from nothing else, and the
 * quickest way round it is an upload.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { invalidatePermissions } from '../../src/core/permissions/index.js';
import { signIn } from './fixtures.js';

let app: ReturnType<typeof createApp>;
let token = '';
let profileId = '';
let fieldId = '';
let fieldName = '';
const MOBILE = `96${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const user = await db.queryOne<{ email: string; profile_id: string }>(
    `SELECT email, profile_id FROM ipy_user
      WHERE is_admin = false AND password_hash IS NOT NULL AND profile_id IS NOT NULL
      ORDER BY created_at LIMIT 1`);
  profileId = user!.profile_id;
  await db.query(`UPDATE ipy_profile_module_perm SET can_import = true WHERE profile_id = $1`, [profileId]);
  await db.query(
    `UPDATE ipy_profile SET capabilities = CASE WHEN capabilities ? 'records.import'
        THEN capabilities ELSE capabilities || '["records.import"]'::jsonb END WHERE id = $1`,
    [profileId]);

  const field = await db.queryOne<{ id: string; name: string }>(
    `SELECT f.id, f.name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
      WHERE m.name = 'leads' AND f.name = 'budget'`);
  fieldId = field!.id; fieldName = field!.name;
  await db.query(
    `INSERT INTO ipy_profile_field_perm (profile_id, field_id, permission) VALUES ($1, $2, 'hidden')
     ON CONFLICT (profile_id, field_id) DO UPDATE SET permission = 'hidden'`,
    [profileId, fieldId]);
  invalidatePermissions();

  token = await signIn(app, user!.email);
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_profile_field_perm WHERE profile_id = $1 AND field_id = $2`,
    [profileId, fieldId]);
  await db.query(`DELETE FROM ipy_record r USING ipy_e_leads l
                   WHERE l.record_id = r.id AND l.mobile = $1`, [MOBILE]);
  invalidatePermissions();
  registry.invalidate();
});

describe('importing into a field the profile cannot see', () => {
  it('does not offer it as a target', async () => {
    const res = await request(app).post('/api/import/leads/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('Name,Phone,Budget\nX,9800000001,1 Cr\n', 'utf8'), 'x.csv')
      .expect(200);
    const names = (res.body.fields as { name: string }[]).map((f) => f.name);
    expect(names, 'a hidden field is not an import target').not.toContain(fieldName);
  });

  it('does not write it even when the mapping names it anyway', async () => {
    const res = await request(app).post('/api/import/leads')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(`Name,Phone,Budget\nSneaky,${MOBILE},9 Cr\n`, 'utf8'), 'x.csv')
      .field('mapping', JSON.stringify({ Name: 'full_name', Phone: 'mobile', Budget: fieldName }))
      .field('duplicateHandling', 'create')
      .expect(202);

    for (let i = 0; i < 60; i += 1) {
      const job = await db.queryOne<{ status: string }>(
        `SELECT status FROM ipy_import_job WHERE id = $1`, [res.body.jobId]);
      if (job && job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const row = await db.queryOne<{ budget: string | null }>(
      `SELECT l.budget FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
        WHERE l.mobile = $1 AND r.is_deleted = false`, [MOBILE]);
    // Either the row is refused or the value is dropped; what must not happen
    // is 90,000,000 sitting in a field this person cannot see.
    expect(row?.budget ?? null, 'a hidden field must not be fillable from a file').toBeNull();
  });
});
