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
import { SYSTEM_FIELDS } from '../../core/query/builder.js';

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
    /*
      The pseudo-fields every module has, alongside its own.

      `created_at`, `owner_id`, `record_number` and the rest live on
      `ipy_record` and have no row in `ipy_field`, so a name-only check reads
      them as deleted — and this sweep would then strip a perfectly valid
      `created_at` off a trend chart, or switch off a workflow for narrowing on
      the date a lead arrived. The filter builder accepts them, so this must
      too; `SYSTEM_FIELDS` is where it keeps that list, and taking it from there
      means the two cannot drift.
    */
    const exists = new Set([...fields.rows.map((f) => f.name), ...Object.keys(SYSTEM_FIELDS)]);
    const onScreen = new Set(
      fields.rows.filter((f) => f.is_active && f.display_type !== 'hidden').map((f) => f.name),
    );

    /*
      A stale name is repaired before it is removed.

      Most references that no longer match a field are not deletions at all —
      they are renames. This CRM promises an admin may rename a field, and a
      rename moves `ipy_field.name` while `column_name` stays exactly where it
      was. So `owner_id` and `status` on a Contacts tile are not fields that
      vanished: they are `assigned_to` and `lead_status` under the names their
      owner chose.

      Dropping them turned "My Open Leads" into a count of every lead in the
      business — a tile that works, shows a number, and lies. Rewriting them
      keeps what the tile meant. Only a name that no field owns by any route is
      actually gone, and only that is removed.
    */
    const columnRows = await conn.query<{ name: string; column_name: string }>(
      `SELECT name, column_name FROM ipy_field WHERE module_id = $1`, [module.id],
    );
    const byColumn = new Map<string, string>();
    for (const f of columnRows.rows) {
      if (!exists.has(f.column_name)) byColumn.set(f.column_name, f.name);
    }
    /**
     * The field this name means today, against a given list, or null when
     * nothing owns it. `onScreen` for a layout, `exists` for everything else —
     * the same distinction the two sets already draw.
     */
    const resolveIn = (allowed: Set<string>) => (name: string): string | null => {
      if (allowed.has(name)) return name;
      const renamed = byColumn.get(name);
      return renamed && allowed.has(renamed) ? renamed : null;
    };
    const resolve = resolveIn(exists);
    const resolveOnScreen = resolveIn(onScreen);


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
          // A renamed field is still on this layout under its new name; only a
          // name nothing owns is actually off the screen.
          return { ...block, fields: block.fields.map((f) => resolveOnScreen(String(f))).filter(Boolean) };
        }),
        ...(Array.isArray(config.headerFields)
          ? { headerFields: config.headerFields.map((f) => resolveOnScreen(String(f))).filter(Boolean) }
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
      // Repaired, not dropped: a column saved before a rename still names the
      // old field, and removing it silently takes a column off somebody's list.
      const kept = cols.map((c) => resolve(String(c))).filter(Boolean);
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

    /*
      --- dashboard tiles ---------------------------------------------------

      The comment at the top of this file has always listed dashboard tiles as
      part of the class, and this is the first version that actually sweeps
      them. Seven of the twenty-one seeded widgets were answering 400 on
      production — `Unknown field 'is_converted' on leads`, `project_name`,
      `blocked_until`, and `status` on Contacts, whose field is now called
      `lead_status` after a rename. A third of the dashboard, on the first
      screen anybody opens.

      A tile's whole filter is not dropped when one condition goes: a metric
      that counted "my open leads" still counts "my leads", which is a
      narrower claim than the title makes but a working tile and a real number.
      A tile left with no conditions at all keeps its group — the count is then
      "everything", which is honest — and the removal is logged either way so
      it is a visible decision rather than a silent one.
    */
    const widgets = await conn.query<{ id: string; title: string; config: Record<string, unknown> }>(
      `SELECT id, title, config FROM ipy_dashboard_widget
        WHERE config->>'module' = $1`, [module.name],
    );
    for (const widget of widgets.rows) {
      const config = widget.config ?? {};
      const filter = config.filter as { conditions?: { field?: string }[] } | undefined;
      const conditions = Array.isArray(filter?.conditions) ? filter!.conditions : null;

      /*
        `dateField` is deliberately not here. It usually holds `created_at` or
        `updated_at`, which live on `ipy_record` and have no row in `ipy_field`
        — so they read as "gone" against this module's field list and sweeping
        them takes the bucketing off every trend chart. A tile pointing at a
        record timestamp is correct, not stale.
      */
      const KEYS = ['groupBy', 'sortBy', 'valueField', 'field', 'measureField'];
      const next: Record<string, unknown> = { ...config };
      const renamed: string[] = [];
      const dropped: string[] = [];

      for (const key of KEYS) {
        const value = next[key];
        if (typeof value !== 'string' || !value || exists.has(value)) continue;
        const target = resolve(value);
        if (target) { next[key] = target; renamed.push(`${value}→${target}`); }
        else { delete next[key]; dropped.push(`${key}:${value}`); }
      }

      let keptConditions = conditions;
      if (conditions) {
        keptConditions = conditions.flatMap((c) => {
          if (!c.field || exists.has(c.field)) return [c];
          const target = resolve(c.field);
          if (target) { renamed.push(`${c.field}→${target}`); return [{ ...c, field: target }]; }
          dropped.push(c.field);
          return [];
        });
      }
      if (!renamed.length && !dropped.length) continue;
      if (conditions) next.filter = { ...filter, conditions: keptConditions };
      const droppedConditions = dropped.length;

      await conn.query(`UPDATE ipy_dashboard_widget SET config = $2::jsonb WHERE id = $1`,
        [widget.id, JSON.stringify(next)]);
      logger.warn(
        { module: module.name, widget: widget.title, renamed, dropped },
        renamed.length && !dropped.length
          ? 'a dashboard tile named a field by its old name — repointed at the renamed field'
          : 'a dashboard tile named a field that is gone — the reference was removed',
      );
      removed.push(`${module.name} → dashboard tile "${widget.title}"`);
    }

    /*
      --- workflows -----------------------------------------------------------

      Seven of them had conditions naming a field that is gone, and a scheduled
      workflow pushes its conditions into SQL, so each one raised
      `Unknown field` on every tick and did nothing. "Birthday greeting" dying
      nightly is the same story told once before.

      A rename is repaired, which revives the workflow. A field that is
      genuinely gone is **not** dropped, and this is the one place in this file
      where removing the reference is the wrong answer: every condition here
      narrows, so deleting one widens what the workflow acts on. "Nurture cold
      leads" without `is_converted` and `last_activity_at` would message
      customers who have already bought and leads somebody rang yesterday —
      real messages, to real people, because a field was tidied away.

      So it is switched off instead, loudly. That is not a loss: it was failing
      on every run already. The difference is that it now says so, and an admin
      can point the condition at whatever replaced the field and switch it back
      on.
    */
    const workflows = await conn.query<{ id: string; name: string; conditions: { conditions?: { field?: string }[] } | null; is_active: boolean }>(
      `SELECT id, name, conditions, is_active FROM ipy_workflow WHERE module_id = $1`, [module.id],
    );
    for (const workflow of workflows.rows) {
      const conditions = Array.isArray(workflow.conditions?.conditions) ? workflow.conditions!.conditions! : null;
      if (!conditions?.length) continue;

      const renamed: string[] = [];
      const unresolved: string[] = [];
      const next = conditions.map((c) => {
        if (!c.field || exists.has(c.field)) return c;
        const target = resolve(c.field);
        if (target) { renamed.push(`${c.field}→${target}`); return { ...c, field: target }; }
        unresolved.push(c.field);
        return c;
      });

      if (!renamed.length && !unresolved.length) continue;

      if (renamed.length) {
        await conn.query(`UPDATE ipy_workflow SET conditions = $2::jsonb WHERE id = $1`,
          [workflow.id, JSON.stringify({ ...workflow.conditions, conditions: next })]);
      }
      if (unresolved.length && workflow.is_active) {
        await conn.query(`UPDATE ipy_workflow SET is_active = false WHERE id = $1`, [workflow.id]);
      }
      logger.warn(
        { module: module.name, workflow: workflow.name, renamed, unresolved,
          switchedOff: Boolean(unresolved.length && workflow.is_active) },
        unresolved.length
          ? 'a workflow narrows on a field that is gone — switched off rather than let it act on everybody'
          : 'a workflow named a field by its old name — repointed at the renamed field',
      );
      removed.push(`${module.name} → workflow "${workflow.name}"`);
    }

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
