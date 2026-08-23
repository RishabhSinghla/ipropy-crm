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
  'leads.ai_grade': 'the A-to-D grade lead scoring writes',
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
  'properties.price': 'buyer matching, comparables and every price shown publicly',
  'properties.carpet_area': 'buyer matching, comparables and the per-square-foot rate',
  'properties.latitude': 'the map, and distance in comparables',
  'properties.longitude': 'the map, and distance in comparables',
  'properties.unit_no': 'the property folder name in OneDrive and every processed file inside it',
};

/** Tables holding module-scoped JSON that can name a field, and their columns. */
const MODULE_SCOPED: { table: string; columns: string[]; key: string }[] = [
  { table: 'ipy_view', columns: ['columns', 'filter'], key: 'module_id' },
  { table: 'ipy_layout', columns: ['config'], key: 'module_id' },
  { table: 'ipy_workflow', columns: ['watch_fields', 'conditions'], key: 'module_id' },
  { table: 'ipy_report', columns: ['columns', 'group_by', 'aggregates', 'filter', 'chart_config'], key: 'module_id' },
  { table: 'ipy_assignment_rule', columns: ['conditions'], key: 'module_id' },
  { table: 'ipy_field', columns: ['config'], key: 'module_id' },
];

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
