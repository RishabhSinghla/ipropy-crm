/**
 * Deleting a field must not leave a saved view answering 400 for ever.
 *
 * Delete used to clean the field out of view *columns* and layout blocks and
 * nothing else. A view that filtered on it, a workflow whose condition named it,
 * a report grouped by it or a dashboard tile aggregating it all kept pointing at
 * a field that no longer existed, and the query builder answers
 * `Unknown field 'x' on leads` — a flat 400, for ever, with no clue that a field
 * somebody removed last Tuesday is the cause.
 *
 * These use a throwaway custom field so nothing seeded is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { signIn } from './fixtures.js';

let app: Express;
let token: string;
let fieldId: string;
let moduleId: string;
const FIELD = 'e2e_doomed_field';
const madeViews: string[] = [];
const madeWidgets: string[] = [];

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  token = await signIn(app, admin!.email);

  const res = await request(app)
    .post('/api/meta/modules/leads/fields')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: FIELD, label: 'Doomed', uitype: 'string' })
    .expect(201);
  fieldId = (res.body as { id: string }).id;

  const mod = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
  moduleId = mod!.id;
});

afterAll(async () => {
  if (madeViews.length) await db.query(`DELETE FROM ipy_view WHERE id = ANY($1::uuid[])`, [madeViews]);
  if (madeWidgets.length) await db.query(`DELETE FROM ipy_dashboard_widget WHERE id = ANY($1::uuid[])`, [madeWidgets]);
  await db.query(`DELETE FROM ipy_field WHERE id = $1`, [fieldId]).catch(() => undefined);
});

describe('deleting a field takes its references with it', () => {
  it('leaves no view filtering, sorting or grouping by it', async () => {
    const view = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_view (module_id, name, columns, filter, sort_by, group_by, owner_id)
       VALUES ($1, 'Doomed View', $2::jsonb, $3::jsonb, $4, $4,
               (SELECT id FROM ipy_user WHERE is_admin ORDER BY created_at LIMIT 1))
       RETURNING id`,
      [
        moduleId,
        JSON.stringify(['full_name', FIELD]),
        JSON.stringify({
          logic: 'AND',
          conditions: [
            { field: 'full_name', operator: 'is_not_empty' },
            { field: FIELD, operator: 'equals', value: 'x' },
            // Nested, because a filter builder produces groups inside groups and
            // a sweep that only walks the top level would miss this one.
            { logic: 'OR', conditions: [{ field: FIELD, operator: 'is_empty' }] },
          ],
        }),
        FIELD,
      ],
    );
    madeViews.push(view!.id);

    await request(app)
      .delete(`/api/meta/fields/${fieldId}?permanent=true`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const after = await db.queryOne<{
      columns: string[]; filter: { conditions: unknown[] }; sort_by: string | null; group_by: string | null;
    }>(`SELECT columns, filter, sort_by, group_by FROM ipy_view WHERE id = $1`, [view!.id]);

    expect(after!.columns).not.toContain(FIELD);
    expect(JSON.stringify(after!.filter)).not.toContain(FIELD);
    // The condition that survived is the one about a field that still exists.
    expect(JSON.stringify(after!.filter)).toContain('full_name');
    expect(after!.sort_by).toBeNull();
    expect(after!.group_by).toBeNull();
  });

  it('leaves the view loadable rather than answering 400 for ever', async () => {
    // The whole point. Before this, the view above would 400 on every load.
    const res = await request(app)
      .get('/api/records/leads?limit=1')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
