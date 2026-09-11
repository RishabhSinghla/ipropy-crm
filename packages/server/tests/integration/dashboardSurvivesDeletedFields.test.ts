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

  it('repairs a reference to a field that was renamed, rather than dropping it', async () => {
    /*
      Most stale references are renames, not deletions. A rename moves
      `ipy_field.name` and never `column_name`, so a tile saved before the
      rename still says `owner_id` when the field is now `assigned_to`.

      Dropping that condition turned "My Open Leads" into a count of every lead
      in the business — a tile that works, shows a number, and lies. That is a
      worse outcome than the 400 it replaced.
    */
    const renamed = await db.queryOne<{ id: string; name: string; column_name: string }>(
      `SELECT f.id, f.name, f.column_name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.name <> f.column_name AND f.storage = 'column' LIMIT 1`);
    if (!renamed) return; // nothing renamed on this database

    await db.query(
      `UPDATE ipy_dashboard_widget SET config = jsonb_set(config, '{filter,conditions}', $2::jsonb) WHERE id = $1`,
      [widgetId, JSON.stringify([{ field: renamed.column_name, operator: 'is_not_empty' }])],
    );

    await transaction(async (tx) => { await pruneFieldRefs(tx); });

    const row = await db.queryOne<{ config: { filter: { conditions: { field: string }[] } } }>(
      `SELECT config FROM ipy_dashboard_widget WHERE id = $1`, [widgetId]);
    expect(
      row!.config.filter.conditions.map((c) => c.field),
      `the old name ${renamed.column_name} should have become ${renamed.name}, not disappeared`,
    ).toEqual([renamed.name]);
  });

  it('leaves a record timestamp alone', async () => {
    // `created_at` lives on ipy_record and has no row in ipy_field, so it reads
    // as "gone" against a module's field list. Sweeping it takes the bucketing
    // off every trend chart.
    await db.query(
      `UPDATE ipy_dashboard_widget SET config = config || '{"dateField":"created_at"}'::jsonb WHERE id = $1`,
      [widgetId]);
    await transaction(async (tx) => { await pruneFieldRefs(tx); });
    const row = await db.queryOne<{ config: Record<string, unknown> }>(
      `SELECT config FROM ipy_dashboard_widget WHERE id = $1`, [widgetId]);
    expect(row!.config.dateField).toBe('created_at');
  });

  it('repairs a renamed column in a saved view instead of removing it', async () => {
    /*
      Same rule, the other document. A view saved before a rename still names
      the old field, and dropping the column silently takes it off somebody's
      list — which is the "the CRM keeps changing my columns" complaint rather
      than a fix for it.
    */
    const renamed = await db.queryOne<{ name: string; column_name: string }>(
      `SELECT f.name, f.column_name FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads' AND f.name <> f.column_name AND f.storage = 'column' LIMIT 1`);
    const view = await db.queryOne<{ id: string; columns: unknown }>(
      `SELECT v.id, v.columns FROM ipy_view v JOIN ipy_module m ON m.id = v.module_id
        WHERE m.name = 'leads' ORDER BY v.name LIMIT 1`);
    if (!renamed || !view) return;

    const original = view.columns;
    try {
      await db.query(`UPDATE ipy_view SET columns = $2::jsonb WHERE id = $1`,
        [view.id, JSON.stringify(['full_name', renamed.column_name, 'qa_ghost_column'])]);
      await transaction(async (tx) => { await pruneFieldRefs(tx); });

      const after = await db.queryOne<{ columns: string[] }>(
        `SELECT columns FROM ipy_view WHERE id = $1`, [view.id]);
      expect(after!.columns).toEqual(['full_name', renamed.name]);
    } finally {
      await db.query(`UPDATE ipy_view SET columns = $2::jsonb WHERE id = $1`,
        [view.id, JSON.stringify(original)]);
    }
  });

  it('switches a workflow off rather than letting it act on everybody', async () => {
    /*
      The one place in this sweep where removing a stale reference is the wrong
      answer. Every workflow condition *narrows*, so dropping one widens what
      the workflow acts on — "Nurture cold leads" without `is_converted` would
      message customers who have already bought. Real messages, to real people,
      because a field was tidied away.

      It was failing on every tick anyway: a scheduled workflow pushes its
      conditions into SQL, and an unknown field is a 400. Switching it off loses
      nothing and says so.
    */
    const module = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = 'leads'`);
    const made = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_workflow (module_id, name, trigger, conditions, is_active, sequence)
       VALUES ($1, 'QA ghost-condition workflow', 'scheduled', $2::jsonb, true, 99)
       RETURNING id`,
      [module!.id, JSON.stringify({ logic: 'AND', conditions: [
        { field: 'full_name', operator: 'is_not_empty' },
        { field: 'qa_field_that_never_existed', operator: 'is_false' },
      ] })],
    );
    try {
      await transaction(async (tx) => { await pruneFieldRefs(tx); });
      const after = await db.queryOne<{ is_active: boolean; conditions: { conditions: { field: string }[] } }>(
        `SELECT is_active, conditions FROM ipy_workflow WHERE id = $1`, [made!.id]);
      expect(after!.is_active, 'it must not keep running against a condition it cannot apply').toBe(false);
      // And the condition is left in place, so an admin can see what to repoint.
      expect(after!.conditions.conditions.map((c) => c.field))
        .toEqual(['full_name', 'qa_field_that_never_existed']);
    } finally {
      await db.query(`DELETE FROM ipy_workflow WHERE id = $1`, [made!.id]);
    }
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
