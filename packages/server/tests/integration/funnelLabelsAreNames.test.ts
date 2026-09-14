/**
 * A funnel grouped by a person printed raw uuids.
 *
 * `runGrouped` resolves every group key to a display label — picklist labels,
 * user names, referenced record labels — and `runFunnel` then rebuilt the
 * label from the field's `options` instead of using it. Only a dropdown has
 * options, so grouping by an owner or a reference fell through to the key and
 * the dashboard showed `671d65cc-1ac6-…` where a name belonged.
 *
 * Asserted against a real database because the label comes from a join on
 * ipy_user; a mocked query would happily return whatever the test wanted.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { signIn } from './fixtures.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let app: ReturnType<typeof createApp>;
let token = '';
let widgetId = '';

beforeAll(async () => {
  await registry.warmup();
  app = createApp();
  const admin = await db.queryOne<{ email: string }>(
    `SELECT email FROM ipy_user WHERE is_admin = true AND password_hash IS NOT NULL ORDER BY created_at LIMIT 1`);
  token = await signIn(app, admin!.email);

  const dash = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_dashboard ORDER BY created_at LIMIT 1`);
  const made = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_dashboard_widget (dashboard_id, type, title, config, x, y, w, h, sequence)
     VALUES ($1, 'funnel', 'QA funnel grouped by a person', $2::jsonb, 0, 0, 6, 5, 98)
     RETURNING id`,
    [dash!.id, JSON.stringify({ module: 'leads', aggregate: 'count', groupBy: 'owner_id' })],
  );
  widgetId = made!.id;
});

afterAll(async () => {
  if (widgetId) await db.query(`DELETE FROM ipy_dashboard_widget WHERE id = $1`, [widgetId]);
});

describe('a funnel grouped by a person', () => {
  it('labels each band with the name, never the raw id', async () => {
    const res = await request(app).get(`/api/dashboards/widgets/${widgetId}/data`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const stages = res.body.stages as { key: string; label: string }[];
    expect(stages.length, 'seeded leads should have at least one owner to group by').toBeGreaterThan(0);

    for (const stage of stages) {
      expect(stage.key, 'the key stays the uuid — that is what drill-down needs').toMatch(UUID);
      expect(stage.label, `stage ${stage.key} still shows a raw uuid`).not.toMatch(UUID);
      expect(stage.label.trim().length).toBeGreaterThan(0);
    }
  });
});
