/**
 * Bringing back a dropdown option somebody deleted.
 *
 * A deleted option is tombstoned (`ipy_picklist_tombstone`, migration 049) so
 * the seed cannot resurrect it on the next cold start. The editor sends its
 * whole list on every save, so a tombstoned value is skipped and reported in
 * `skipped` rather than silently re-created — that part has always worked.
 *
 * What had no cover is the way back. `PUT .../values` takes `restore: [...]`,
 * and until now nothing ever sent it: the refusal named the values and pointed
 * at a "Deleted options" list that was never built, so an admin re-adding a
 * status they had removed was simply stuck. The editor now offers to restore
 * the values the save just refused, which makes this contract load-bearing.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

const PICKLIST = 'lead_source';
const VALUE = 'QA Restore Source';

let app: ReturnType<typeof createApp>;
let token = '';
let original: { value: string; label: string; color: string | null; isActive: boolean; isDefault: boolean }[] = [];

const put = (values: unknown[], restore: string[] = []) =>
  request(app).put(`/api/meta/picklists/${PICKLIST}/values`)
    .set('Authorization', `Bearer ${token}`)
    .send({ values, restore });

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = await signIn(app, admin!.email);

  const rows = await db.query<{ value: string; label: string; color: string | null; is_active: boolean; is_default: boolean }>(
    `SELECT v.value, v.label, v.color, v.is_active, v.is_default
       FROM ipy_picklist_value v JOIN ipy_picklist p ON p.id = v.picklist_id
      WHERE p.name = $1 ORDER BY v.sequence`, [PICKLIST]);
  original = rows.rows.map((r) => ({
    value: r.value, label: r.label, color: r.color, isActive: r.is_active, isDefault: r.is_default,
  }));
});

afterAll(async () => {
  // Leave the dropdown exactly as it was found, tombstone included.
  if (original.length) await put(original, original.map((o) => o.value));
  await db.query(
    `DELETE FROM ipy_picklist_tombstone WHERE picklist_name = $1 AND value = $2`, [PICKLIST, VALUE]);
  await db.query(
    `DELETE FROM ipy_picklist_value v USING ipy_picklist p
      WHERE v.picklist_id = p.id AND p.name = $1 AND v.value = $2`, [PICKLIST, VALUE]);
});

describe('an option that was deleted earlier', () => {
  it('is skipped on a plain save, and comes back when asked for by name', async () => {
    const withExtra = [...original, {
      value: VALUE, label: VALUE, color: null, isActive: true, isDefault: false,
    }];

    const added = await put(withExtra);
    expect(added.status).toBe(200);
    expect(added.body.skipped ?? [], 'a value nobody deleted should just be added').not.toContain(VALUE);

    const deleted = await request(app)
      .delete(`/api/meta/picklists/${PICKLIST}/values?value=${encodeURIComponent(VALUE)}&clear=true`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleted.status, 'the option should delete cleanly — nothing uses it').toBe(200);

    // The editor sends its whole list back, still carrying the deleted value.
    const resaved = await put(withExtra);
    expect(resaved.status).toBe(200);
    expect(resaved.body.skipped, 'a tombstoned value must not come back by accident').toContain(VALUE);

    // Asking for it by name is what the restore prompt now does.
    const restored = await put(withExtra, [VALUE]);
    expect(restored.status).toBe(200);
    expect(restored.body.skipped ?? [], 'naming it in `restore` should lift the tombstone').not.toContain(VALUE);

    const back = await db.queryOne<{ value: string }>(
      `SELECT v.value FROM ipy_picklist_value v JOIN ipy_picklist p ON p.id = v.picklist_id
        WHERE p.name = $1 AND v.value = $2`, [PICKLIST, VALUE]);
    expect(back?.value, 'the option should be in the dropdown again').toBe(VALUE);

    const tombstone = await db.queryOne<{ value: string }>(
      `SELECT value FROM ipy_picklist_tombstone WHERE picklist_name = $1 AND value = $2`, [PICKLIST, VALUE]);
    expect(tombstone, 'the tombstone should be gone, or the next seed deletes it again').toBeNull();
  });
});
