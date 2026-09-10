/**
 * Dashboard tiles that name a field somebody deleted.
 *
 * Seven of the twenty-one seeded widgets were answering 400 on production —
 * `Unknown field 'is_converted' on leads`, `project_name`, `blocked_until`, and
 * `status` on Contacts, whose field is called `lead_status` since a rename. A
 * third of the dashboard, on the first screen anybody opens, and nothing said
 * why.
 *
 * `pruneFieldRefs` runs at every boot and exists precisely for this class — its
 * own comment lists "dashboard tiles" — but it swept layouts, views and
 * dependent dropdowns and never touched widgets.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db, transaction } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { pruneFieldRefs } from '../../src/db/seed/pruneFieldRefs.js';

let app: ReturnType<typeof createApp>;
let token = '';
let widgetId = '';
let dashboardId = '';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = (await request(app).post('/api/auth/login')
    .send({ email: admin!.email, password: 'Admin@123' })).body.token;

  const dash = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_dashboard ORDER BY created_at LIMIT 1`);
  dashboardId = dash!.id;
  const made = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_dashboard_widget (dashboard_id, type, title, config, x, y, w, h, sequence)
     VALUES ($1, 'metric', 'QA tile on a ghost field', $2::jsonb, 0, 0, 3, 2, 99)
     RETURNING id`,
    [dashboardId, JSON.stringify({
      module: 'leads', aggregate: 'count',
      filter: { logic: 'AND', conditions: [
        { field: 'qa_field_that_never_existed', operator: 'is_not_empty' },
        { field: 'full_name', operator: 'is_not_empty' },
      ] },
    })],
  );
  widgetId = made!.id;
});

afterAll(async () => {
  if (widgetId) await db.query(`DELETE FROM ipy_dashboard_widget WHERE id = $1`, [widgetId]);
});

describe('a dashboard tile filtering on a field that is gone', () => {
  it('answers 400 until the references are swept', async () => {
    const before = await request(app).get(`/api/dashboards/widgets/${widgetId}/data`)
      .set('Authorization', `Bearer ${token}`);
    expect(before.status, 'the tile should be broken before pruning — otherwise this proves nothing').toBe(400);
  });

  it('works once pruneFieldRefs has run, keeping the conditions that are real', async () => {
    await transaction(async (tx) => { await pruneFieldRefs(tx); });
    registry.invalidate();

    const after = await request(app).get(`/api/dashboards/widgets/${widgetId}/data`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.status, JSON.stringify(after.body)).toBe(200);

    // The surviving condition is kept: the tile narrows less than its title
    // claims, which is a working number rather than a broken screen.
    const row = await db.queryOne<{ config: { filter: { conditions: { field: string }[] } } }>(
      `SELECT config FROM ipy_dashboard_widget WHERE id = $1`, [widgetId]);
    expect(row!.config.filter.conditions.map((c) => c.field)).toEqual(['full_name']);
  });

  it('every seeded tile on every dashboard answers', async () => {
    const dashboards = await db.query<{ id: string }>(`SELECT id FROM ipy_dashboard`);
    const failures: string[] = [];
    for (const dash of dashboards.rows) {
      const widgets = await db.query<{ id: string; title: string }>(
        `SELECT id, title FROM ipy_dashboard_widget WHERE dashboard_id = $1`, [dash.id]);
      for (const w of widgets.rows) {
        const res = await request(app).get(`/api/dashboards/widgets/${w.id}/data`)
          .set('Authorization', `Bearer ${token}`);
        if (res.status !== 200) failures.push(`${w.title}: ${res.status} ${JSON.stringify(res.body).slice(0, 90)}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
