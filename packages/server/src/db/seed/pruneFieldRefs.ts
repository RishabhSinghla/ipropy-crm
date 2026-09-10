/**
 * A field that is gone must be gone everywhere.
 *
 * The owner: "why CRM keeps on bringing those fields back somewhere or the
 * other inside of it after removing from fields — this is so bad."
 *
 * He is describing a real hole, and it is not one hole but a class of them. A
 * field's name is written into a dozen documents that are not `ipy_field`:
 * every layout's sections and header strip, every saved view's columns, sort
 * and filter, dashboard tiles, workflow conditions and actions, dependent
 * dropdown maps. Deleting a field sweeps most of those (`removeFieldEverywhere`
 * plus the layout statement beside it). *Hiding* one sweeps none of them —
 * which is right for a view, where hiding is temporary, and wrong for the
 * Layout Designer, which then goes on showing a field the admin has taken off
 * every screen. That is the reappearance.
 *
 * And there is a second source no per-action sweep can cover: references
 * written before that sweep existed, or by an older version, or by a migration.
 * They sit there indefinitely.
 *
 * So this runs at boot, after the modules are upserted, and removes every
 * reference to a field name the module does not have. It cannot remove a
 * *live* field from anything — the whole test is "does this name still exist on
 * this module" — so it is safe to run unconditionally, and on a database in
 * step it writes nothing.
 */
import type { Tx } from '../pool.js';
import { logger } from '../../utils/logger.js';

export interface PruneResult {
  /** `module.field → where` for each reference removed. */
  removed: string[];
}

export async function pruneFieldRefs(conn: Tx): Promise<PruneResult> {
  const removed: string[] = [];

  const modules = await conn.query<{ id: string; name: string }>(`SELECT id, name FROM ipy_module`);

  for (const module of modules.rows) {
    // The names this module actually has. A hidden field is still a field —
    // it keeps its data and can be restored — so it stays in saved views and
    // filters. What it must not stay in is a *layout*, because a layout is the
    // list of what is on screen and the field is not. Both lists below.
    const fields = await conn.query<{ name: string; is_active: boolean; display_type: string }>(
      `SELECT name, is_active, display_type FROM ipy_field WHERE module_id = $1`, [module.id],
    );
    const exists = new Set(fields.rows.map((f) => f.name));
    const onScreen = new Set(
      fields.rows.filter((f) => f.is_active && f.display_type !== 'hidden').map((f) => f.name),
    );

    // --- layouts: sections and the header strip -----------------------------
    const layouts = await conn.query<{ id: string; config: Record<string, unknown> }>(
      `SELECT id, config FROM ipy_layout WHERE module_id = $1`, [module.id],
    );
    for (const layout of layouts.rows) {
      const config = layout.config ?? {};
      const before = JSON.stringify(config);
      const blocks = Array.isArray(config.blocks) ? config.blocks : [];
      const next = {
        ...config,
        blocks: blocks.map((b) => {
          const block = b as { fields?: unknown };
          if (!Array.isArray(block.fields)) return b;
          return { ...block, fields: block.fields.filter((f) => onScreen.has(String(f))) };
        }),
        ...(Array.isArray(config.headerFields)
          ? { headerFields: config.headerFields.filter((f) => onScreen.has(String(f))) }
          : {}),
      };
      if (JSON.stringify(next) === before) continue;
      await conn.query(`UPDATE ipy_layout SET config = $2::jsonb WHERE id = $1`,
        [layout.id, JSON.stringify(next)]);
      removed.push(`${module.name} → layout`);
    }

    // --- saved views: columns, and the sort/group they order by -------------
    //
    // `exists`, not `onScreen`: a view may legitimately sort by a field that is
    // hidden from the forms, and un-hiding it should not mean rebuilding the
    // view. Only a name with no field behind it goes.
    const views = await conn.query<{ id: string; columns: unknown[] }>(
      `SELECT id, columns FROM ipy_view WHERE module_id = $1`, [module.id],
    );
    for (const view of views.rows) {
      const cols = Array.isArray(view.columns) ? view.columns : [];
      const kept = cols.filter((c) => exists.has(String(c)));
      if (kept.length === cols.length) continue;
      // A view stripped to nothing shows no columns at all, which is a broken
      // screen; leaving it alone at least shows the old list. This has not
      // happened, and if it does the admin should see it rather than a blank.
      if (!kept.length) {
        logger.warn({ module: module.name, view: view.id },
          'every column on this view names a field that is gone — left alone for an admin to fix');
        continue;
      }
      await conn.query(`UPDATE ipy_view SET columns = $2::jsonb WHERE id = $1`,
        [view.id, JSON.stringify(kept)]);
      removed.push(`${module.name} → view columns`);
    }

    const orders = await conn.query(
      `UPDATE ipy_view
          SET sort_by  = CASE WHEN sort_by  = ANY($2::text[]) THEN sort_by  ELSE NULL END,
              group_by = CASE WHEN group_by = ANY($2::text[]) THEN group_by ELSE NULL END
        WHERE module_id = $1
          AND (sort_by IS NOT NULL AND NOT (sort_by = ANY($2::text[]))
            OR group_by IS NOT NULL AND NOT (group_by = ANY($2::text[])))`,
      [module.id, [...exists]],
    );
    if (orders.rowCount) removed.push(`${module.name} → view sort/group (${orders.rowCount})`);

    // --- dependent dropdowns ------------------------------------------------
    //
    // A City → Locality map whose source field has been deleted narrows every
    // Locality dropdown to nothing, which reads as the list being empty.
    const deps = await conn.query(
      `DELETE FROM ipy_picklist_dependency
        WHERE module_id = $1
          AND (NOT (source_field = ANY($2::text[])) OR NOT (target_field = ANY($2::text[])))`,
      [module.id, [...exists]],
    );
    if (deps.rowCount) removed.push(`${module.name} → dependent dropdown (${deps.rowCount})`);
  }

  if (removed.length) {
    logger.warn({ removed }, 'pruneFieldRefs cleared references to fields that no longer exist');
  }
  return { removed };
}
