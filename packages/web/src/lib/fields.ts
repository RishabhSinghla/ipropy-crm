/**
 * Finding a field without hard-coding its name.
 *
 * Fields get renamed in this CRM all the time — `owner_id` is called
 * `assigned_to` today, and its label has been both "Owner" and "Assigned To".
 * Code that looks a field up by the name it had when the code was written
 * doesn't error when that changes: `fields.find(f => f.name === 'owner_id')`
 * simply returns undefined, and the screen quietly loses a control. The
 * assignment chip in the record header sat read-only for exactly this reason
 * while every field beside it edited in place.
 *
 * So: prefer what a field *is* (its uitype) over what it is called, and where
 * only a name will do, accept the column name as well — the column survives a
 * rename even when the name does not.
 */
import type { FieldMeta } from '@ipropy/shared';

/** The record's assignee. One per module, identified by uitype. */
export function assignmentField(fields: FieldMeta[]): FieldMeta | undefined {
  return fields.find((f) => f.uitype === 'owner')
    ?? fields.find((f) => f.columnName === 'owner_id' || f.name === 'owner_id');
}

/**
 * The chase date — the CRM's task field.
 *
 * Inventories on older workspaces keep the same fact as `next_follow_up` in
 * JSON, so both spellings are recognised; the canonical column wins.
 */
export function followUpFieldOf(fields: FieldMeta[]): FieldMeta | undefined {
  return fields.find((field) => field.columnName === 'next_followup_at')
    ?? fields.find((field) => field.name === 'next_follow_up' || field.columnName === 'next_follow_up');
}

/**
 * The field a module's pipeline is measured on — the kanban's columns and the
 * list's stage breakdown.
 *
 * `pipeline_field` is a stored name, and a rename changes a field's name while
 * leaving its column alone, so the two drift apart with nothing to show for
 * it. Production's leads module says `status` and has called the field
 * `lead_status` for some time: matching on the name alone lost the kanban's
 * grouping and hid the stage breakdown entirely, both without an error,
 * because the column was still there and nothing asked for it.
 */
export function pipelineFieldOf(module: {
  pipelineField: string | null;
  fields: FieldMeta[];
}): FieldMeta | undefined {
  return module.pipelineField ? fieldByKey(module.fields, module.pipelineField) : undefined;
}

/**
 * The fields that make up the line under a record's name in a list.
 *
 * Ordered by the flag itself, not by where each field happens to sit in its
 * module. Leads and Inventory both carry Contact Type and Unit Number, and
 * field sequence put them in opposite orders — "Builder — B-118" on one screen
 * and "B-118 — Builder" on the other, which reads as two different facts to
 * somebody moving between them.
 *
 * `config.listSubtitle` carries the position: a number is that position, and
 * `true` still means "include me" and sorts first. Field sequence breaks a tie,
 * so two fields left at `true` keep the order the module gives them.
 */
export function subtitleFieldsOf(fields: FieldMeta[]): FieldMeta[] {
  const rank = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return fields
    .filter((f) => f.config?.listSubtitle && f.isActive && f.displayType !== 'hidden')
    .sort((a, b) => rank(a.config?.listSubtitle) - rank(b.config?.listSubtitle) || a.sequence - b.sequence);
}

/** A field by name, tolerating a rename that left the column alone. */
export function fieldByKey(fields: FieldMeta[], key: string): FieldMeta | undefined {
  return fields.find((f) => f.name === key) ?? fields.find((f) => f.columnName === key);
}

/**
 * Fields in alphabetical order by label, for anything that offers them as a
 * list to pick from.
 *
 * They arrive in `sequence` — the order an admin arranged them on the form.
 * That is the right order on a form, where you read top to bottom, and no
 * order at all in a dropdown of forty where you are hunting for one word:
 * "Lead Source" sat eleventh for no reason a reader could see. Alphabetical
 * also makes type-ahead do what people expect from every other app — press
 * "p" and land on the P's.
 *
 * Deliberately not applied to a *dropdown's values* (Lead Status, Category,
 * and the rest). Those carry an order somebody chose in Admin → Dropdowns —
 * New before Contacted before Site Visit Done — and alphabetising them would
 * overrule a real setting with a rule of thumb.
 *
 * Copies rather than sorting in place: these arrays come from React Query's
 * cache, and sorting one mutates state every other component is reading.
 */
export function byLabel<T extends { label: string }>(fields: readonly T[]): T[] {
  return fields.slice().sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Add everything a queue row reads to a list's columns, when the split view is
 * showing.
 *
 * A list row carries only the values the list asked for, so a fact the row
 * prints is blank on any view whose columns happen not to include it — which
 * reads as the feature not working rather than as a column being absent.
 * Undefined is left alone: that means "the server's defaults", and narrowing
 * it to a handful of fields would empty the table.
 *
 * Three things go in. The line under the name — the fields the module itself
 * flags `config.listSubtitle`, so the queue shows what the Field Manager says
 * rather than a pair named in this file. The **pipeline field**, whose chip
 * sits beside it: Lead Status on a contact, Property Status on a unit. And
 * **who the record is assigned to**, which the card's third row has carried
 * since 3 October 2026 — *"a Text of assign to agent name in third row"*.
 */
export function withQueueSubtitle(
  columns: string[] | undefined,
  module: { fields: FieldMeta[]; pipelineField: string | null } | undefined,
): string[] | undefined {
  if (!columns || !module) return columns;
  const wanted = [
    ...subtitleFieldsOf(module.fields).map((field) => field.name),
    pipelineFieldOf(module)?.name,
    assignmentField(module.fields)?.name,
  ].filter((name): name is string => Boolean(name));
  const extra = wanted.filter((name) => !columns.includes(name));
  return extra.length ? [...columns, ...extra] : columns;
}

/** Resolve the visit date without depending on a custom field's stored name. */
export function plannedVisitField(fields: FieldMeta[]): FieldMeta | undefined {
  return fields.find(field => field.isActive && field.displayType !== 'hidden'
    && ['date', 'datetime'].includes(field.uitype)
    && /visit.*plan|plan.*visit/i.test(`${field.name} ${field.label}`));
}
