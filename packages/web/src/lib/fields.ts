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
