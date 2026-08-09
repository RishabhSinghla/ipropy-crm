import { Router } from 'express';
import { z } from 'zod';
import { db, transaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { registry } from '../../core/metadata/registry.js';
import { canAccessModule } from '../../core/permissions/index.js';
import { recordService } from '../../core/entity/recordService.js';

export const viewsRouter = Router();
viewsRouter.use(requireAuth);

const viewSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  columns: z.array(z.string()).default([]),
  filter: z.record(z.unknown()).default({ logic: 'AND', conditions: [] }),
  sortBy: z.string().nullable().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  displayMode: z.enum(['table', 'kanban', 'calendar', 'map', 'timeline', 'gallery', 'split']).default('table'),
  groupBy: z.string().nullable().optional(),
  isPublic: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  showMetrics: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sequence: z.number().int().min(0).max(9999).default(0),
});

function rowToView(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id, module: r.module_name, name: r.name, description: r.description,
    isDefault: r.is_default, isPublic: r.is_public, isSystem: r.is_system,
    ownerId: r.owner_id, columns: r.columns, filter: r.filter,
    sortBy: r.sort_by, sortDir: r.sort_dir, displayMode: r.display_mode,
    groupBy: r.group_by, showMetrics: r.show_metrics, sequence: r.sequence,
    isActive: r.is_active,
  };
}

/** Views visible to this user: system, public, or their own. */
viewsRouter.get('/:module', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const module = await registry.requireModule(req.params.module);
  if (!(await canAccessModule(user, module.name, 'view'))) throw new ForbiddenError();

  const rows = await db.query(
    `SELECT v.*, m.name AS module_name FROM ipy_view v
     JOIN ipy_module m ON m.id = v.module_id
     WHERE v.module_id = $1 AND (v.is_system OR v.is_public OR v.owner_id = $2)
       AND (v.is_active OR $3)
     ORDER BY v.sequence, v.is_system DESC, v.name`,
    [module.id, user.id, user.isAdmin && req.query.includeInactive === 'true'],
  );

  const views = rows.rows.map(rowToView);

  // Optional per-view record counts for the badge in the view switcher.
  if (req.query.withCounts === 'true') {
    const scope = getScope(req);
    for (const view of views) {
      if (!view.showMetrics) continue;
      try {
        const result = await recordService.listRecords(scope, module.name, {
          view: String(view.id), page: 1, pageSize: 1,
        });
        (view as { count?: number }).count = result.total;
      } catch {
        (view as { count?: number }).count = undefined;
      }
    }
  }

  res.json(views);
}));

viewsRouter.post('/:module', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const module = await registry.requireModule(req.params.module);
  if (!(await canAccessModule(user, module.name, 'view'))) throw new ForbiddenError();
  const input = viewSchema.parse(req.body);

  // Only admins (or users with the capability) can publish a view to everyone.
  const isPublic = input.isPublic && (user.isAdmin || module.isCustom);

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_view
      (module_id, name, description, owner_id, columns, filter, sort_by, sort_dir,
       display_mode, group_by, is_public, show_metrics)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      module.id, input.name, input.description ?? null, user.id,
      JSON.stringify(input.columns), JSON.stringify(input.filter),
      input.sortBy ?? null, input.sortDir, input.displayMode,
      input.groupBy ?? null, isPublic, input.showMetrics,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

viewsRouter.put('/:module/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = viewSchema.partial().parse(req.body);

  const view = await db.queryOne<{ owner_id: string | null; is_system: boolean }>(
    `SELECT owner_id, is_system FROM ipy_view WHERE id = $1`, [req.params.id],
  );
  if (!view) throw new NotFoundError('View not found');
  if (view.is_system && !user.isAdmin) throw new ForbiddenError('System views can only be edited by an administrator');
  if (!view.is_system && view.owner_id !== user.id && !user.isAdmin) {
    throw new ForbiddenError('You can only edit views you created');
  }

  const map: Record<string, string> = {
    name: 'name', description: 'description', sortBy: 'sort_by', sortDir: 'sort_dir',
    displayMode: 'display_mode', groupBy: 'group_by', isPublic: 'is_public', showMetrics: 'show_metrics',
    isActive: 'is_active', sequence: 'sequence',
  };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [k, v] of Object.entries(input)) {
    if (k === 'columns' || k === 'filter') {
      params.push(JSON.stringify(v));
      sets.push(`${k} = $${params.length}`);
      continue;
    }
    if (k === 'isDefault') continue;
    const col = map[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE ipy_view SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }
  res.json({ ok: true });
}));

/** Mark a view as this user's default for the module. */
viewsRouter.post('/:module/:id/default', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const module = await registry.requireModule(req.params.module);
  await transaction(async (tx) => {
    // Personal default is stored in preferences so it doesn't disturb others.
    await tx.query(
      `UPDATE ipy_user
       SET preferences = jsonb_set(COALESCE(preferences,'{}'::jsonb), $2, $3::jsonb, true)
       WHERE id = $1`,
      [user.id, `{defaultViews,${module.name}}`, JSON.stringify(req.params.id)],
    );
  });
  res.json({ ok: true });
}));

viewsRouter.delete('/:module/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const view = await db.queryOne<{ owner_id: string | null; is_system: boolean }>(
    `SELECT owner_id, is_system FROM ipy_view WHERE id = $1`, [req.params.id],
  );
  if (!view) throw new NotFoundError('View not found');
  if (view.is_system && !user.isAdmin) {
    throw new ForbiddenError('Built-in views can only be removed by an administrator');
  }
  if (!view.is_system && view.owner_id !== user.id && !user.isAdmin) {
    throw new ForbiddenError('You can only delete views you created');
  }

  await db.query(`DELETE FROM ipy_view WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

/** Duplicate a view — the fastest way to build on a system view. */
viewsRouter.post('/:module/:id/duplicate', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const source = await db.queryOne<Record<string, unknown>>(`SELECT * FROM ipy_view WHERE id = $1`, [req.params.id]);
  if (!source) throw new NotFoundError('View not found');

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_view
      (module_id, name, description, owner_id, columns, filter, sort_by, sort_dir,
       display_mode, group_by, show_metrics)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      source.module_id, `${source.name} (copy)`, source.description, user.id,
      JSON.stringify(source.columns), JSON.stringify(source.filter),
      source.sort_by, source.sort_dir, source.display_mode, source.group_by, source.show_metrics,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

/**
 * Reorder the view tabs.
 *
 * The strip's order is the first thing anyone notices about a list, and the
 * seeded order is a guess about how this desk works. Sent as a whole list
 * rather than per-view moves so the result cannot end up with two views
 * claiming the same position.
 */
viewsRouter.post('/:module/reorder', asyncHandler(async (req, res) => {
  const user = getUser(req);
  if (!user.isAdmin) throw new ForbiddenError('Only an administrator can reorder the shared view tabs');

  const input = z.object({ ids: z.array(z.string().uuid()).max(100) }).parse(req.body);
  await transaction(async (tx) => {
    for (const [index, id] of input.ids.entries()) {
      await tx.query(`UPDATE ipy_view SET sequence = $2, updated_at = now() WHERE id = $1`, [id, index * 10]);
    }
  });
  res.json({ ok: true });
}));
