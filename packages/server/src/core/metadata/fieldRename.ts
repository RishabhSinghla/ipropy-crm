/**
 * What breaks when a field's API name changes, and how it is put back.
 *
 * The API name is not where the data lives. Records are stored under
 * `ipy_field.column_name` — a real column for built-in fields, a key inside
 * `custom_fields` for admin-created ones — and the query builder resolves both
 * through that, never through `name`. So a rename moves no data at all and
 * cannot lose a value.
 *
 * What it does break is every *reference*. A saved view lists its columns by
 * name; a filter names the field it compares; a layout names the fields in each
 * section; a workflow condition, a dashboard widget, a report, a formula and
 * one field's "only show this when…" rule all do the same. Rename the field and
 * leave those behind and nothing errors — the view simply renders a blank
 * column, the filter matches nothing and the automation silently stops. That is
 * the failure this module exists to prevent.
 *
 * The rewrite is a whole-document string replace of the quoted name, in the
 * manner of `picklists.renameInFilters`, and for the same reason: jsonb has no
 * "replace this leaf wherever it appears" operator, and walking every document
 * shape by hand is far more code and far more ways to be wrong. Every statement
 * is scoped to the one module, so renaming `status` on Leads cannot touch the
 * `status` on Properties.
 */
import { db, type Tx } from '../../db/pool.js';

/**
 * Fields the application reads by their API name, outside the field system.
 *
 * `renameFieldEverywhere` puts back every reference that lives in the database.
 * What it cannot rewrite is a name written into the source — `l.mobile`, a
 * scoring rule that adds points for `ai_score`, the WhatsApp sender that looks
 * for `whatsapp_number`, the public catalogue that filters on `status`. Rename
 * one of those and the rename succeeds, every view and workflow follows, and a
 * feature silently stops with nothing anywhere saying why.
 *
 * So these are refused rather than warned about. The label is what anybody
 * actually reads on a screen and stays editable; the API name behind it is
 * load-bearing, and the honest answer is "not this one, and here is why".
 *
 * Keyed `module.field`. Keep in step with the call sites.
 */
export const FIELDS_USED_IN_CODE: Record<string, string> = {
  'leads.full_name': 'the name shown on every lead, and what duplicate checking and lead capture write',
  'leads.mobile': 'every call, WhatsApp send, duplicate check and lead-capture import',
  'leads.whatsapp_number': 'which number a WhatsApp message is sent to',
  'leads.email': 'inbound email threading, and what lead capture writes',
  'leads.status': 'lead scoring, the rule that moves a lead to Contacted, and open-lead counts',
  'leads.lifecycle_stage': 'conversion — Lead to Prospect on a site visit, Customer on a booking',
  'leads.lead_source': 'source attribution on every captured lead and every source report',
  'leads.ai_score': 'lead scoring, buyer matching and the priority order on lists',
  'leads.next_followup_at': 'follow-ups — the one definition of “chase them on this date”',
  'leads.last_contacted_at': 'the neglected-lead rules and first-response timing',
  'leads.budget_min': 'buyer matching against inventory',
  'leads.budget_max': 'buyer matching against inventory',
  'leads.configuration': 'buyer matching against inventory',
  'leads.do_not_whatsapp': 'the consent check that stops a broadcast reaching someone who opted out',
  'leads.do_not_call': 'the do-not-call check before a number is dialled',
  'leads.preferred_locations': 'buyer matching against inventory, and the first reply that names a locality',
  'leads.possession_timeline': 'buyer matching, and how soon a lead is chased',
  'leads.purpose': 'buyer matching — whether they are buying to live in or to let',
  'leads.area': 'buyer matching against inventory',
  'leads.area_unit': 'buyer matching — a number without its unit matches nothing correctly',
  'leads.interested_project': 'buyer matching, and the drafted first reply that names the project',
  'leads.description': 'the drafted first reply, and what lead capture writes the enquiry into',
  'properties.status': 'the public website catalogue, share links and buyer-match alerts',
  'properties.base_price': 'buyer matching, comparables and every price shown publicly',
  'properties.carpet_area': 'buyer matching, comparables and the per-square-foot rate',
  'properties.latitude': 'the map, and distance in comparables',
  'properties.longitude': 'the map, and distance in comparables',
  'properties.name': 'the property folder name in OneDrive and every processed file inside it',
};

/**
 * `properties.project_name` and `properties.city` are deliberately NOT on that
 * list, and should not be added back.
 *
 * They were on it for one day. Both had been deleted from production, which had
 * quietly emptied the projects catalogue, every project page and the cities list
 * on the public website, and the obvious reading was that somebody had removed
 * them without knowing what they carried.
 *
 * That reading was wrong. The removal was deliberate: this business sells
 * builder floors in one area, so a "project" grouping and a city filter are
 * both noise on its own site. A CRM whose whole promise is that an admin never
 * needs a developer cannot then refuse a field an admin has decided they do not
 * want. The correct response to their absence is for the website to stop
 * offering those sections, which is what it now does, rather than for the CRM to
 * argue.
 *
 * What belongs on the list above is a field the *engine* reads by name and
 * cannot work without. These two are read by one optional surface, and that
 * surface handles their absence.
 */

/** Tables holding module-scoped JSON that can name a field, and their columns. */
const MODULE_SCOPED: { table: string; columns: string[]; key: string }[] = [
  { table: 'ipy_view', columns: ['columns', 'filter'], key: 'module_id' },
  { table: 'ipy_layout', columns: ['config'], key: 'module_id' },
  { table: 'ipy_workflow', columns: ['watch_fields', 'conditions'], key: 'module_id' },
  { table: 'ipy_report', columns: ['columns', 'group_by', 'aggregates', 'filter', 'chart_config'], key: 'module_id' },
  { table: 'ipy_assignment_rule', columns: ['conditions'], key: 'module_id' },
  { table: 'ipy_field', columns: ['config'], key: 'module_id' },
];

/**
 * Take every reference to a deleted field out of everything that named it.
 *
 * The twin of `renameFieldEverywhere`, and it existed only half-written. Delete
 * removed the field from saved-view *columns* and layout blocks and stopped
 * there, so a view that *filtered* on the field, a workflow whose condition
 * named it, a report grouped by it or a dashboard tile aggregating it all kept
 * pointing at something that no longer existed.
 *
 * The failure is not subtle once you hit it and is invisible until you do: the
 * query builder throws `Unknown field 'x' on leads`, which the error handler
 * turns into a flat 400. A saved view that answers 400 for ever looks like the
 * CRM is broken, and the connection to a field somebody deleted last Tuesday is
 * not one anybody makes.
 *
 * Renaming can be a string replace. Removing cannot: you cannot lift a name out
 * of `{ field: 'x', operator: 'equals', value: 'New' }` and be left with valid
 * JSON. The whole condition has to go, which means walking the document — so
 * this reads, transforms in JS, and writes back, rather than doing it in SQL.
 */

interface FilterCondition { field?: string; conditions?: unknown[]; logic?: string }

/** Drop every condition naming this field, at any depth. Groups stay, emptied. */
function withoutField(node: unknown, name: string): unknown {
  if (!node || typeof node !== 'object') return node;
  const group = node as FilterCondition;
  if (!Array.isArray(group.conditions)) return node;
  return {
    ...group,
    conditions: group.conditions
      .filter((c) => !(c && typeof c === 'object' && (c as FilterCondition).field === name))
      .map((c) => withoutField(c, name)),
  };
}

/** Drop a name from an array of field names. */
function withoutName(node: unknown, name: string): unknown {
  return Array.isArray(node) ? node.filter((v) => v !== name) : node;
}

export async function removeFieldEverywhere(
  moduleId: string,
  moduleName: string,
  name: string,
  conn: Tx = db,
): Promise<{ references: number }> {
  let references = 0;

  const sweep = async (
    table: string,
    where: string,
    params: unknown[],
    columns: { column: string; clean: (v: unknown) => unknown }[],
  ): Promise<void> => {
    const cols = columns.map((c) => c.column);
    const { rows } = await conn.query<Record<string, unknown>>(
      `SELECT id, ${cols.join(', ')} FROM ${table} WHERE ${where}`, params,
    );
    for (const row of rows) {
      const sets: string[] = [];
      const values: unknown[] = [row.id];
      for (const { column, clean } of columns) {
        const before = JSON.stringify(row[column] ?? null);
        const after = JSON.stringify(clean(row[column]) ?? null);
        if (before === after) continue;
        values.push(after === 'null' ? null : after);
        sets.push(`${column} = $${values.length}::jsonb`);
      }
      if (!sets.length) continue;
      // eslint-disable-next-line no-await-in-loop
      await conn.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1`, values);
      references += 1;
    }
  };

  const asFilter = { clean: (v: unknown) => withoutField(v, name) };
  const asList = { clean: (v: unknown) => withoutName(v, name) };

  await sweep('ipy_view', 'module_id = $1', [moduleId], [
    { column: 'columns', ...asList },
    { column: 'filter', ...asFilter },
  ]);
  await sweep('ipy_workflow', 'module_id = $1', [moduleId], [
    { column: 'watch_fields', ...asList },
    { column: 'conditions', ...asFilter },
  ]);
  await sweep('ipy_report', 'module_id = $1', [moduleId], [
    { column: 'columns', ...asList },
    { column: 'group_by', ...asList },
    { column: 'aggregates', ...asList },
    { column: 'filter', ...asFilter },
  ]);
  await sweep('ipy_assignment_rule', 'module_id = $1', [moduleId], [
    { column: 'conditions', ...asFilter },
  ]);

  // `sort_by` and `group_by` on a view are plain columns holding one field name,
  // not JSON. A view sorted by a field that is gone falls back to a default
  // order on its own, but one *grouped* by it renders an empty board.
  const cleared = await conn.query(
    `UPDATE ipy_view SET sort_by = CASE WHEN sort_by = $2 THEN NULL ELSE sort_by END,
                         group_by = CASE WHEN group_by = $2 THEN NULL ELSE group_by END
      WHERE module_id = $1 AND ($2 IN (sort_by, group_by))`,
    [moduleId, name],
  );
  references += cleared.rowCount ?? 0;

  // Widgets belong to a dashboard, not a module, and name their module inside
  // their own config — the same scoping problem the rename has, and the same
  // answer, or deleting `status` on Leads would edit a Properties tile.
  const widgets = await conn.query<{ id: string; config: Record<string, unknown> }>(
    `SELECT id, config FROM ipy_dashboard_widget WHERE config->>'module' = $1`, [moduleName],
  );
  for (const w of widgets.rows) {
    const next: Record<string, unknown> = { ...w.config };
    if (next.filter) next.filter = withoutField(next.filter, name);
    // A tile aggregating or grouping by a field that is gone is worse than a
    // broken one: `aggregateExpr` falls back to COUNT(*), so an "average score"
    // tile silently starts showing how many records there are.
    for (const key of ['aggregateField', 'groupBy', 'dateField', 'sortBy']) {
      if (next[key] === name) next[key] = null;
    }
    if (JSON.stringify(next) === JSON.stringify(w.config)) continue;
    // eslint-disable-next-line no-await-in-loop
    await conn.query(`UPDATE ipy_dashboard_widget SET config = $2::jsonb WHERE id = $1`,
      [w.id, JSON.stringify(next)]);
    references += 1;
  }

  // A workflow's actions belong to the workflow, one level below the module.
  const tasks = await conn.query<{ id: string; config: Record<string, unknown> }>(
    `SELECT t.id, t.config FROM ipy_workflow_task t
       JOIN ipy_workflow w ON w.id = t.workflow_id
      WHERE w.module_id = $1 AND t.config::text LIKE '%' || $2 || '%'`,
    [moduleId, name],
  );
  for (const t of tasks.rows) {
    const next: Record<string, unknown> = { ...t.config };
    let touched = false;
    // `values` and `writeTo` are keyed by field name, so the key goes.
    for (const key of ['values', 'writeTo'] as const) {
      const bag = next[key];
      if (bag && typeof bag === 'object' && !Array.isArray(bag) && name in (bag as object)) {
        const { [name]: _gone, ...rest } = bag as Record<string, unknown>;
        next[key] = rest;
        touched = true;
      }
    }
    if (next.conditions) {
      const cleaned = withoutField(next.conditions, name);
      if (JSON.stringify(cleaned) !== JSON.stringify(next.conditions)) {
        next.conditions = cleaned;
        touched = true;
      }
    }
    if (!touched) continue;
    // eslint-disable-next-line no-await-in-loop
    await conn.query(`UPDATE ipy_workflow_task SET config = $2::jsonb WHERE id = $1`,
      [t.id, JSON.stringify(next)]);
    references += 1;
  }

  return { references };
}

export async function renameFieldEverywhere(
  moduleId: string,
  moduleName: string,
  from: string,
  to: string,
  conn: Tx = db,
): Promise<{ references: number }> {
  const quotedFrom = JSON.stringify(from);
  const quotedTo = JSON.stringify(to);
  let references = 0;

  /*
    A field's `config` names other fields — `dependsOn`, a formula's operands,
    a conditional-visibility rule — so it has to be rewritten with the rest. But
    it also names its **picklist**, and a picklist is a separate thing that
    merely happens to share the field's name.

    Rewriting that pointer broke the field it was renaming: `funding_type`
    became `funding_readiness`, its config started pointing at a picklist called
    `funding_readiness`, and no such picklist exists. The field kept its label,
    kept its stored values, and offered **zero options**. Silently — nothing
    errors, the dropdown is simply empty.

    So the pointers are captured first and put back afterwards. Restoring is
    used rather than a cleverer replace because `config` has no fixed shape: any
    future key holding a field name still gets renamed for free, and only this
    one known exception is undone.
  */
  const picklistPointers = await conn.query<{ id: string; picklist: string }>(
    `SELECT id, config->>'picklist' AS picklist
       FROM ipy_field
      WHERE module_id = $1 AND config->>'picklist' IS NOT NULL`,
    [moduleId],
  );

  for (const { table, columns, key } of MODULE_SCOPED) {
    for (const column of columns) {
      const res = await conn.query(
        `UPDATE ${table}
            SET ${column} = replace(${column}::text, $2, $3)::jsonb
          WHERE ${key} = $1
            AND ${column} IS NOT NULL
            AND ${column}::text LIKE '%' || $2 || '%'`,
        [moduleId, quotedFrom, quotedTo],
      );
      references += res.rowCount ?? 0;
    }
  }

  // Put every dropdown back where it was pointing.
  for (const row of picklistPointers.rows) {
    await conn.query(
      `UPDATE ipy_field
          SET config = jsonb_set(config, '{picklist}', to_jsonb($2::text))
        WHERE id = $1 AND config->>'picklist' IS DISTINCT FROM $2`,
      [row.id, row.picklist],
    );
  }

  // Workflow actions belong to a workflow, which belongs to a module — one
  // level further down than everything above.
  for (const column of ['config'] as const) {
    const res = await conn.query(
      `UPDATE ipy_workflow_task t
          SET ${column} = replace(t.${column}::text, $2, $3)::jsonb
         FROM ipy_workflow w
        WHERE t.workflow_id = w.id AND w.module_id = $1
          AND t.${column}::text LIKE '%' || $2 || '%'`,
      [moduleId, quotedFrom, quotedTo],
    );
    references += res.rowCount ?? 0;
  }

  // A widget names its module inside its own config rather than in a column,
  // so that is what scopes it — without the check, renaming `status` on Leads
  // would rewrite every Properties widget that groups by status.
  const widgets = await conn.query(
    `UPDATE ipy_dashboard_widget
        SET config = replace(config::text, $2, $3)::jsonb
      WHERE config ->> 'module' = $1 AND config::text LIKE '%' || $2 || '%'`,
    [moduleName, quotedFrom, quotedTo],
  );
  references += widgets.rowCount ?? 0;

  // Plain text columns: an exact match, never a substring.
  for (const [table, column] of [
    ['ipy_view', 'sort_by'], ['ipy_view', 'group_by'], ['ipy_report', 'sort_by'],
  ] as const) {
    const res = await conn.query(
      `UPDATE ${table} SET ${column} = $3 WHERE module_id = $1 AND ${column} = $2`,
      [moduleId, from, to],
    );
    references += res.rowCount ?? 0;
  }

  // The module's own three references to a field by name.
  const mod = await conn.query(
    `UPDATE ipy_module
        SET label_fields = replace(label_fields::text, $2, $3)::jsonb,
            duplicate_check_fields = replace(duplicate_check_fields::text, $2, $3)::jsonb,
            pipeline_field = CASE WHEN pipeline_field = $4 THEN $5 ELSE pipeline_field END
      WHERE id = $1`,
    [moduleId, quotedFrom, quotedTo, from, to],
  );
  references += mod.rowCount ?? 0;

  // Cascading dropdowns name both halves of the pair.
  const deps = await conn.query(
    `UPDATE ipy_picklist_dependency
        SET source_field = CASE WHEN source_field = $2 THEN $3 ELSE source_field END,
            target_field = CASE WHEN target_field = $2 THEN $3 ELSE target_field END
      WHERE module_id = $1 AND (source_field = $2 OR target_field = $2)`,
    [moduleId, from, to],
  );
  references += deps.rowCount ?? 0;

  // Formulas and message templates name a field in braces rather than in
  // quotes, so the replace above misses them entirely. `{budget_max}` in a
  // formula, `{{budget_max}}` in a WhatsApp or email body — both would keep
  // rendering the old name, which is an empty value rather than an error.
  const braced = await conn.query(
    `UPDATE ipy_field
        SET config = replace(config::text, $2, $3)::jsonb
      WHERE module_id = $1 AND config::text LIKE '%' || $2 || '%'`,
    [moduleId, `{${from}}`, `{${to}}`],
  );
  references += braced.rowCount ?? 0;

  const bracedTasks = await conn.query(
    `UPDATE ipy_workflow_task t
        SET config = replace(t.config::text, $2, $3)::jsonb
       FROM ipy_workflow w
      WHERE t.workflow_id = w.id AND w.module_id = $1
        AND t.config::text LIKE '%' || $2 || '%'`,
    [moduleId, `{{${from}}}`, `{{${to}}}`],
  );
  references += bracedTasks.rowCount ?? 0;

  return { references };
}
