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
