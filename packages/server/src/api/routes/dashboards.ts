import { Router } from 'express';
import { z } from 'zod';
import type { WidgetConfig } from '@ipropy/shared';
import { db, transaction, type Tx } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { runWidget } from '../../core/analytics/widgets.js';

export const dashboardsRouter = Router();
dashboardsRouter.use(requireAuth);

interface DashboardRow {
  id: string; name: string; description: string | null; owner_id: string | null;
  is_shared: boolean; is_default: boolean; is_system: boolean;
  module_id: string | null; module_name: string | null; sequence: number;
}

dashboardsRouter.get('/', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const rows = await db.query<DashboardRow>(
    `SELECT d.*, m.name AS module_name FROM ipy_dashboard d
     LEFT JOIN ipy_module m ON m.id = d.module_id
     WHERE d.is_shared OR d.owner_id = $1
     ORDER BY d.is_default DESC, d.sequence, d.name`,
    [user.id],
  );
  res.json(rows.rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, ownerId: r.owner_id,
    isShared: r.is_shared, isDefault: r.is_default, isSystem: r.is_system,
    module: r.module_name, sequence: r.sequence,
    canEdit: user.isAdmin || r.owner_id === user.id,
  })));
}));

dashboardsRouter.get('/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const dash = await db.queryOne<DashboardRow>(
    `SELECT d.*, m.name AS module_name FROM ipy_dashboard d
     LEFT JOIN ipy_module m ON m.id = d.module_id
     WHERE d.id = $1 AND (d.is_shared OR d.owner_id = $2)`,
    [req.params.id, user.id],
  );
  if (!dash) throw new NotFoundError('Dashboard not found');

  const widgets = await db.query(
    `SELECT id, type, title, x, y, w, h, config, sequence
     FROM ipy_dashboard_widget WHERE dashboard_id = $1 ORDER BY sequence`,
    [req.params.id],
  );

  res.json({
    id: dash.id, name: dash.name, description: dash.description,
    ownerId: dash.owner_id, isShared: dash.is_shared, isDefault: dash.is_default,
    isSystem: dash.is_system, module: dash.module_name,
    canEdit: user.isAdmin || dash.owner_id === user.id,
    widgets: widgets.rows,
  });
}));

/** Run a single widget. Kept separate so the grid can load tiles in parallel. */
dashboardsRouter.get('/widgets/:widgetId/data', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const widget = await db.queryOne<{ type: string; title: string; config: WidgetConfig; dashboard_id: string }>(
    `SELECT type, title, config, dashboard_id FROM ipy_dashboard_widget WHERE id = $1`,
    [req.params.widgetId],
  );
  if (!widget) throw new NotFoundError('Widget not found');

  const dash = await db.queryOne<{ is_shared: boolean; owner_id: string | null }>(
    `SELECT is_shared, owner_id FROM ipy_dashboard WHERE id = $1`, [widget.dashboard_id],
  );
  if (!dash || (!dash.is_shared && dash.owner_id !== scope.user.id)) throw new ForbiddenError();

  const data = await runWidget(scope, widget.type, widget.config);
  res.json({ ...data, title: widget.title });
}));

/** Ad-hoc widget preview — used by the widget builder before saving. */
dashboardsRouter.post('/preview', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { type, config } = z.object({
    type: z.string(),
    config: z.record(z.unknown()),
  }).parse(req.body);
  res.json(await runWidget(scope, type, config as WidgetConfig));
}));

const dashboardSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  isShared: z.boolean().default(false),
  isDefault: z.boolean().optional(),
  module: z.string().nullable().optional(),
});

/**
 * "Default" means "what /dashboard opens on", so exactly one may hold it within
 * a visibility scope. Shared dashboards compete with each other, personal ones
 * only with that user's own — otherwise setting a personal default would move
 * every colleague's landing page.
 */
async function setDefaultDashboard(conn: Tx, dashboardId: string, ownerId: string | null, isShared: boolean): Promise<void> {
  if (isShared) {
    await conn.query(`UPDATE ipy_dashboard SET is_default = false WHERE is_shared AND id <> $1`, [dashboardId]);
  } else {
    await conn.query(`UPDATE ipy_dashboard SET is_default = false WHERE owner_id = $2 AND NOT is_shared AND id <> $1`, [dashboardId, ownerId]);
  }
  await conn.query(`UPDATE ipy_dashboard SET is_default = true WHERE id = $1`, [dashboardId]);
}

dashboardsRouter.post('/', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = dashboardSchema.parse(req.body);
  const moduleId = input.module
    ? (await db.queryOne<{ id: string }>(`SELECT id FROM ipy_module WHERE name = $1`, [input.module]))?.id ?? null
    : null;

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_dashboard (name, description, owner_id, is_shared, module_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.name, input.description ?? null, user.id, input.isShared && user.isAdmin, moduleId],
  );
  res.status(201).json({ id: row?.id });
}));

async function assertCanEdit(dashboardId: string, userId: string, isAdmin: boolean): Promise<void> {
  const dash = await db.queryOne<{ owner_id: string | null; is_system: boolean }>(
    `SELECT owner_id, is_system FROM ipy_dashboard WHERE id = $1`, [dashboardId],
  );
  if (!dash) throw new NotFoundError('Dashboard not found');
  if (dash.is_system && !isAdmin) throw new ForbiddenError('Built-in dashboards can only be edited by an administrator');
  if (dash.owner_id !== userId && !isAdmin) throw new ForbiddenError('You can only edit dashboards you created');
}

dashboardsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanEdit(req.params.id, user.id, user.isAdmin);
  const input = dashboardSchema.partial().parse(req.body);

  await transaction(async (tx) => {
    const sets: string[] = [];
    const params: unknown[] = [req.params.id];
    if (input.name !== undefined) { params.push(input.name); sets.push(`name = $${params.length}`); }
    if (input.description !== undefined) { params.push(input.description); sets.push(`description = $${params.length}`); }
    if (input.isShared !== undefined && user.isAdmin) { params.push(input.isShared); sets.push(`is_shared = $${params.length}`); }
    if (sets.length) {
      await tx.query(`UPDATE ipy_dashboard SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    }

    if (input.isDefault !== undefined) {
      // Re-read after the update above so a rename+share+default in one PATCH
      // scopes the default against the new sharing state, not the old one.
      const dash = await tx.queryOne<{ owner_id: string | null; is_shared: boolean }>(
        `SELECT owner_id, is_shared FROM ipy_dashboard WHERE id = $1`, [req.params.id],
      );
      if (!dash) throw new NotFoundError('Dashboard not found');
      if (dash.is_shared && !user.isAdmin) throw new ForbiddenError('Only an administrator can change the shared default');
      if (input.isDefault) await setDefaultDashboard(tx, req.params.id, dash.owner_id, dash.is_shared);
      else await tx.query(`UPDATE ipy_dashboard SET is_default = false WHERE id = $1`, [req.params.id]);
    }
  });
  res.json({ ok: true });
}));

dashboardsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanEdit(req.params.id, user.id, user.isAdmin);
  await db.query(`DELETE FROM ipy_dashboard WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

/** Copy a shared dashboard into the user's own space so they can customise it. */
dashboardsRouter.post('/:id/duplicate', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const id = await transaction(async (tx) => {
    const src = await tx.queryOne<DashboardRow>(`SELECT * FROM ipy_dashboard WHERE id = $1`, [req.params.id]);
    if (!src) throw new NotFoundError('Dashboard not found');
    const row = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_dashboard (name, description, owner_id, module_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [`${src.name} (my copy)`, src.description, user.id, src.module_id],
    );
    await tx.query(
      `INSERT INTO ipy_dashboard_widget (dashboard_id, type, title, x, y, w, h, config, sequence)
       SELECT $1, type, title, x, y, w, h, config, sequence FROM ipy_dashboard_widget WHERE dashboard_id = $2`,
      [row!.id, req.params.id],
    );
    return row!.id;
  });
  res.status(201).json({ id });
}));

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

const widgetSchema = z.object({
  type: z.string(),
  title: z.string().min(1),
  x: z.number().int().min(0).default(0),
  y: z.number().int().min(0).default(0),
  w: z.number().int().min(1).max(12).default(4),
  h: z.number().int().min(1).max(20).default(4),
  config: z.record(z.unknown()).default({}),
});

dashboardsRouter.post('/:id/widgets', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanEdit(req.params.id, user.id, user.isAdmin);
  const input = widgetSchema.parse(req.body);
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_dashboard_widget (dashboard_id, type, title, x, y, w, h, config, sequence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT COALESCE(MAX(sequence),0)+1 FROM ipy_dashboard_widget WHERE dashboard_id = $1))
     RETURNING id`,
    [req.params.id, input.type, input.title, input.x, input.y, input.w, input.h, JSON.stringify(input.config)],
  );
  res.status(201).json({ id: row?.id });
}));

dashboardsRouter.patch('/:id/widgets/:widgetId', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanEdit(req.params.id, user.id, user.isAdmin);
  const input = widgetSchema.partial().parse(req.body);

  const sets: string[] = [];
  const params: unknown[] = [req.params.widgetId, req.params.id];
  for (const [k, v] of Object.entries(input)) {
    if (k === 'config') { params.push(JSON.stringify(v)); sets.push(`config = $${params.length}`); continue; }
    if (!['type', 'title', 'x', 'y', 'w', 'h'].includes(k)) continue;
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_dashboard_widget SET ${sets.join(', ')} WHERE id = $1 AND dashboard_id = $2`, params);
  }
  res.json({ ok: true });
}));

/** Persist the whole grid after a drag/resize — one round trip, not N. */
dashboardsRouter.post('/:id/layout', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanEdit(req.params.id, user.id, user.isAdmin);
  const { widgets } = z.object({
    widgets: z.array(z.object({
      id: z.string().uuid(),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      w: z.number().int().min(1).max(12),
      h: z.number().int().min(1).max(20),
    })),
  }).parse(req.body);

  await transaction(async (tx) => {
    for (const [i, w] of widgets.entries()) {
      await tx.query(
        `UPDATE ipy_dashboard_widget SET x = $2, y = $3, w = $4, h = $5, sequence = $6
         WHERE id = $1 AND dashboard_id = $7`,
        [w.id, w.x, w.y, w.w, w.h, i, req.params.id],
      );
    }
  });
  res.json({ ok: true });
}));

dashboardsRouter.delete('/:id/widgets/:widgetId', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCanEdit(req.params.id, user.id, user.isAdmin);
  await db.query(`DELETE FROM ipy_dashboard_widget WHERE id = $1 AND dashboard_id = $2`, [
    req.params.widgetId, req.params.id,
  ]);
  res.json({ ok: true });
}));

