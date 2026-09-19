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
 * Add the queue's subtitle to a list's columns when the split view is showing.
 *
 * A list row carries only the values the list asked for, so the line under
 * each name is blank on any view whose columns happen not to include it —
 * which reads as the feature not working rather than as a column being
 * absent. Undefined is left alone: that means "the server's defaults", and
 * narrowing it to one field would empty the table.
 *
 * The fields are `subtitleFieldsOf`'s, so the queue shows whatever an admin
 * flagged rather than a pair named in this file — that is how Unit Number
 * came to sit after Contact Type on a contact without a line of code naming
 * either of them.
 */
export function withQueueSubtitle(
  columns: string[] | undefined,
  module: { fields: FieldMeta[] } | undefined,
): string[] | undefined {
  if (!columns || !module) return columns;
  const extra = subtitleFieldsOf(module.fields)
    .map((field) => field.name)
    .filter((name) => !columns.includes(name));
  return extra.length ? [...columns, ...extra] : columns;
}
