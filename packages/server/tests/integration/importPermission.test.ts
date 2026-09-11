/**
 * Where somebody may import, not merely whether.
 *
 * `records.import` says a person may import at all; the profile's per-module
 * permission says where. Only the first was checked, so the module dropdown
 * correctly hid Properties from somebody allowed only Contacts — and the API
 * took a file for it anyway. A permission that exists on the screen and
 * nowhere else is not a permission.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { invalidatePermissions } from '../../src/core/permissions/index.js';

let app: ReturnType<typeof createApp>;
let token = '';
let profileId = '';
let restore = false;
const csv = Buffer.from('Name\nX\n', 'utf8');

/** The capability and both module permissions, so only the narrowing under test differs. */
async function allowImportEverywhere(): Promise<void> {
  await db.query(`UPDATE ipy_profile_module_perm SET can_import = true WHERE profile_id = $1`, [profileId]);
  await db.query(
    `UPDATE ipy_profile
        SET capabilities = CASE WHEN capabilities ? 'records.import'
                                THEN capabilities ELSE capabilities || '["records.import"]'::jsonb END
      WHERE id = $1`, [profileId]);
  invalidatePermissions();
}

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const user = await db.queryOne<{ email: string; profile_id: string }>(
    `SELECT email, profile_id FROM ipy_user
      WHERE is_admin = false AND password_hash IS NOT NULL AND profile_id IS NOT NULL
      ORDER BY created_at LIMIT 1`);
  profileId = user!.profile_id;
  await allowImportEverywhere();
  token = (await request(app).post('/api/auth/login')
    .send({ email: user!.email, password: 'Admin@123' })).body.token;
});

afterAll(async () => {
  if (restore) await allowImportEverywhere();
  invalidatePermissions();
  registry.invalidate();
});

describe('importing into a module', () => {
  it('is refused where the profile cannot import, and allowed where it can', async () => {
    expect(token, 'the test user could not sign in').toBeTruthy();

    restore = true;
    await db.query(
      `UPDATE ipy_profile_module_perm p SET can_import = false
         FROM ipy_module m
        WHERE m.id = p.module_id AND m.name = 'properties' AND p.profile_id = $1`,
      [profileId]);
    invalidatePermissions();

    await request(app).post('/api/import/properties/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'x.csv')
      .expect(403);

    // The module they may import into is untouched — a refusal that took
    // everything with it would be just as wrong.
    await request(app).post('/api/import/leads/preview')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csv, 'x.csv')
      .expect(200);
  });
});
