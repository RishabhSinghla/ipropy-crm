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
  /*
    Who this view is shared with, by name.

    `isPublic` is the old all-or-nothing answer — everyone who can open the
    module — and there was nothing between that and nobody. The switch in the
    editor now asks who, and this is the answer. An empty list with the switch
    off is a private view, which is what a new one starts as.
  */
  sharedWith: z.array(z.string().uuid()).max(200).optional(),
});

/*
  One row out, with a personal override folded into it.

  A built-in view is one row read by the whole team, so editing it used to mean
  reshaping everyone's list. Editing one now saves that person's own version
  (migration 135), and this is where the two become the single entry the
  switcher shows: the built-in view's identity and sequence, the override's
  columns, filter and sort.

  `overridesId` is what the list sends when it asks for records, and
  `builtInId` is the built-in row underneath — the switcher needs both so a
  link made before the override existed still selects the right entry, and so
  "Reset to the built-in" has something to delete.

  `sortBy` is read off the override wholesale rather than coalesced: null there
  means "the list's own default", and falling back to the built-in's sort is
  exactly wrong for somebody who cleared theirs.
*/
function rowToView(r: Record<string, unknown>): Record<string, unknown> {
  const overridden = r.override_id != null;
  return {
    id: overridden ? r.override_id : r.id,
    builtInId: r.id,
    isOverride: overridden,
    module: r.module_name,
    name: overridden ? r.override_name : r.name,
    description: overridden ? r.override_description : r.description,
    isDefault: r.is_default,
    isPublic: r.is_public,
    isSystem: r.is_system,
    ownerId: r.owner_id,
    columns: overridden ? r.override_columns : r.columns,
    filter: overridden ? r.override_filter : r.filter,
    sortBy: overridden ? r.override_sort_by : r.sort_by,
    sortDir: overridden ? r.override_sort_dir : r.sort_dir,
    displayMode: overridden ? r.override_display_mode : r.display_mode,
    groupBy: overridden ? r.override_group_by : r.group_by,
    showMetrics: r.show_metrics,
    sequence: r.sequence,
    isActive: r.is_active,
    sharedWith: r.shared_with ?? [],
  };
}

/** Views visible to this user: system, public, or their own. */
viewsRouter.get('/:module', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const module = await registry.requireModule(req.params.module);
  if (!(await canAccessModule(user, module.name, 'view'))) throw new ForbiddenError();

  /*
    `v.overrides_view_id IS NULL` keeps personal overrides out of the top-level
    list. They are not views in their own right — each one is somebody's
    version of a built-in view, and it is joined back in below so the switcher
    shows one entry rather than the built-in one and a near-identical copy.
  */
  const rows = await db.query(
    `SELECT v.*, m.name AS module_name,
            o.id           AS override_id,
            o.name         AS override_name,
            o.description  AS override_description,
            o.columns      AS override_columns,
            o.filter       AS override_filter,
            o.sort_by      AS override_sort_by,
            o.sort_dir     AS override_sort_dir,
            o.display_mode AS override_display_mode,
            o.group_by     AS override_group_by,
            COALESCE(
              (SELECT jsonb_agg(s.user_id) FROM ipy_view_share s WHERE s.view_id = v.id),
              '[]'::jsonb
            ) AS shared_with
     FROM ipy_view v
     JOIN ipy_module m ON m.id = v.module_id
     LEFT JOIN ipy_view o ON o.overrides_view_id = v.id AND o.owner_id = $2
     WHERE v.module_id = $1
       AND v.overrides_view_id IS NULL
       AND (v.is_system OR v.is_public OR v.owner_id = $2
            OR EXISTS (SELECT 1 FROM ipy_view_share s
                        WHERE s.view_id = v.id AND s.user_id = $2))
       AND (v.is_active OR $3)
     ORDER BY v.sequence, v.is_system DESC, v.name`,
    [module.id, user.id, user.isAdmin && req.query.includeInactive === 'true'],
  );

  const views = rows.rows.map(rowToView);

  // Optional per-view record counts for the badge in the view switcher.
  /*
    How many records each view holds, beside its name in the switcher.

    It used to count only views with `showMetrics` set, and nothing sets it —
    so the flag was on by default for nobody and the counts never appeared. The
    question "how many are in My Leads" is the reason somebody opens that menu,
    and it was the one thing the menu would not say.

    Counted in parallel rather than in a loop: this runs on every list page
    load, and three sequential counts against 23,000 records is three round
    trips somebody waits through. A count that fails is left undefined and the
    switcher simply shows no number — a wrong count beside a view name is worse
    than none, and one failing view must not take the menu down.

    Capped, because a business that made forty views should not turn its own
    view menu into forty counts.
  */
  if (req.query.withCounts === 'true') {
    const scope = getScope(req);
    await Promise.all(views.slice(0, 12).map(async (view) => {
      try {
        const result = await recordService.listRecords(scope, module.name, {
          view: String(view.id), page: 1, pageSize: 1,
        });
        (view as { count?: number }).count = result.total;
      } catch {
        (view as { count?: number }).count = undefined;
      }
    }));
  }

  res.json(views);
}));

viewsRouter.post('/:module', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const module = await registry.requireModule(req.params.module);
  if (!(await canAccessModule(user, module.name, 'view'))) throw new ForbiddenError();
  const input = viewSchema.parse(req.body);

  // A view's filter is personal configuration, not a privileged schema change.
  // Its owner may choose to share it with everyone who can already view this
  // module; record-level permissions still apply when that view is opened.
  const isPublic = input.isPublic;

  // Adding a tab back by the name of one that was deleted clears its
  // tombstone: otherwise the seed's own copy could never return, and an admin
  // who changed their mind would have no way to say so.
  await db.query(
    `DELETE FROM ipy_view_tombstone WHERE module_id = $1 AND seed_key = $2`,
    [module.id, input.name],
  );

  const row = await transaction(async (tx) => {
    const created = await tx.queryOne<{ id: string }>(
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
    await replaceShares(tx, created!.id, input.sharedWith ?? [], user.id);
    return created;
  });
  res.status(201).json({ id: row?.id });
}));

/**
 * Set exactly who a view is shared with.
 *
 * Delete-then-insert rather than a diff: the editor sends the whole list every
 * time, the lists are a handful of people, and working out which two rows
 * changed costs more than writing all of them. Sharing with yourself is
 * dropped — you already own it, and a row saying otherwise would show the view
 * twice in your own switcher.
 */
async function replaceShares(
  tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  viewId: string,
  userIds: string[],
  sharedBy: string,
): Promise<void> {
  await tx.query(`DELETE FROM ipy_view_share WHERE view_id = $1`, [viewId]);
  const recipients = [...new Set(userIds)].filter((id) => id !== sharedBy);
  if (!recipients.length) return;
  await tx.query(
    `INSERT INTO ipy_view_share (view_id, user_id, shared_by)
     SELECT $1, unnest($2::uuid[]), $3
     ON CONFLICT DO NOTHING`,
    [viewId, recipients, sharedBy],
  );
}

viewsRouter.put('/:module/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = viewSchema.partial().parse(req.body);

  const view = await db.queryOne<{
    id: string; owner_id: string | null; is_system: boolean; module_id: string;
    name: string; description: string | null; columns: unknown; filter: unknown;
    sort_by: string | null; sort_dir: string; display_mode: string; group_by: string | null;
  }>(
    `SELECT id, owner_id, is_system, module_id, name, description, columns, filter,
            sort_by, sort_dir, display_mode, group_by
     FROM ipy_view WHERE id = $1`,
    [req.params.id],
  );
  if (!view) throw new NotFoundError('View not found');

  /*
    Editing a built-in view gives you your own copy of it.

    "All Leads" and "My Leads" are one row each, read by everybody, so an
    editable built-in view meant one person's column choice landing on the
    whole team's screen. Refusing the edit unless you were an administrator was
    the old answer and it made the two views anybody actually lives in the only
    ones they could not touch.

    So the edit is taken, and saved as this person's version of that view. They
    see theirs; everyone else goes on seeing the built-in one. Deleting the
    override puts them back on it — that is the Reset below.

    Uniform, including for administrators. An admin edit that silently changed
    the list for the whole company while a rep's edit changed only their own is
    two behaviours behind one pencil, and no one would be able to predict which
    they had just done.
  */
  if (view.is_system) {
    const merged = {
      name: input.name ?? view.name,
      description: input.description ?? view.description,
      columns: input.columns ?? view.columns,
      filter: input.filter ?? view.filter,
      sortBy: input.sortBy !== undefined ? input.sortBy : view.sort_by,
      sortDir: input.sortDir ?? view.sort_dir,
      displayMode: input.displayMode ?? view.display_mode,
      groupBy: input.groupBy !== undefined ? input.groupBy : view.group_by,
    };
    const saved = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_view
        (module_id, name, description, owner_id, columns, filter, sort_by, sort_dir,
         display_mode, group_by, overrides_view_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (overrides_view_id, owner_id) WHERE overrides_view_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
                     columns = EXCLUDED.columns, filter = EXCLUDED.filter,
                     sort_by = EXCLUDED.sort_by, sort_dir = EXCLUDED.sort_dir,
                     display_mode = EXCLUDED.display_mode, group_by = EXCLUDED.group_by,
                     updated_at = now()
       RETURNING id`,
      [
        view.module_id, merged.name, merged.description, user.id,
        JSON.stringify(merged.columns), JSON.stringify(merged.filter),
        merged.sortBy, merged.sortDir, merged.displayMode, merged.groupBy, view.id,
      ],
    );
    res.json({ ok: true, id: saved?.id, personal: true });
    return;
  }

  if (view.owner_id !== user.id && !user.isAdmin) {
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
  await transaction(async (tx) => {
    if (sets.length) {
      await tx.query(`UPDATE ipy_view SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    }
    if (input.sharedWith) await replaceShares(tx, req.params.id, input.sharedWith, user.id);
  });
  res.json({ ok: true });
}));

/**
 * Put me back on the built-in view.
 *
 * Deleting my override, not the built-in view — which is why this is its own
 * route rather than a DELETE on the view's id. There is no way to delete
 * either of the two built-in views: the product has exactly those two, and a
 * switcher that can end up empty is a list nobody can open.
 */
viewsRouter.delete('/:module/:id/override', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await db.query(
    `DELETE FROM ipy_view
     WHERE owner_id = $1
       AND (id = $2::uuid OR overrides_view_id = $2::uuid)
       AND overrides_view_id IS NOT NULL`,
    [user.id, req.params.id],
  );
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
  const view = await db.queryOne<{ owner_id: string | null; is_system: boolean; module_id: string; seed_key: string | null; name: string }>(
    `SELECT owner_id, is_system, module_id, seed_key, name FROM ipy_view WHERE id = $1`, [req.params.id],
  );
  if (!view) throw new NotFoundError('View not found');
  /*
    The two built-in views cannot be deleted by anyone.

    They used to be, by an administrator, leaving a tombstone so the seed would
    not put them back. That was right when the switcher held nine of them and
    an admin was curating a strip; it is wrong now that the product ships
    exactly two and every user opens one of them. Somebody who does not want
    the built-in shape edits it — which gives them their own version of it
    (migration 135) — and Reset puts it back.
  */
  if (view.is_system) {
    throw new ForbiddenError(
      'This is one of the two built-in views and cannot be deleted. '
      + 'Edit it to make your own version, or Reset to put it back.',
    );
  }
  if (view.owner_id !== user.id && !user.isAdmin) {
    throw new ForbiddenError('You can only delete views you created');
  }

  await db.query(`DELETE FROM ipy_view WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
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
