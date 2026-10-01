/**
 * A record marked Lost must say why.
 *
 * **1 October 2026, the owner:** *"when … lead status/property status/associate
 * status field's value is Lost then there'd be Lost Reason field to actually
 * highlight and be populated meaning be getting mandatory."* It is the same
 * rule on all three modules, so it lives here once and the server, the form
 * and the inline editors all ask this file.
 *
 * Found through metadata, never by a module's name:
 * - the status field is the one stored in the `status` column (production
 *   calls it `lead_status`, `associate_status` and `status`);
 * - the reason field is the one drawing on the `lost_reason` dropdown;
 * - "Lost" is any stored value with the word lost in it — Leads stores
 *   `Lead Lost`, the other two `Lost`.
 *
 * It asks only when somebody **sets** the status to Lost (or clears the reason
 * of a Lost record). A record that was Lost before this rule existed can still
 * have its phone number corrected without being stopped for a reason.
 */
import type { FieldMeta } from './uitypes.js';

type FieldLike = Pick<FieldMeta, 'name' | 'columnName' | 'isActive' | 'displayType' | 'config'>;

/** The record's stage field: the one stored in the `status` column. */
export function statusFieldOf<F extends FieldLike>(fields: F[]): F | undefined {
  return fields.find((field) => field.columnName === 'status')
    ?? fields.find((field) => field.name === 'status');
}

/** The field that says why a record was lost, if the module has one switched on. */
export function lostReasonFieldOf<F extends FieldLike>(fields: F[]): F | undefined {
  return fields.find((field) => field.isActive && field.displayType !== 'hidden'
    && (field.config?.picklist === 'lost_reason' || field.name === 'lost_reason'));
}

/** True for a stage that means the deal is gone: "Lost", "Lead Lost". */
export function isLostStatus(value: unknown): boolean {
  return typeof value === 'string' && /\blost\b/i.test(value);
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Whether this save has to carry a Lost Reason.
 *
 * `changes` is what is being saved; `record` is the whole record with the
 * changes applied. Returns the reason field when one is needed and missing,
 * so a caller can name it, otherwise null.
 */
export function missingLostReason<F extends FieldLike>(
  fields: F[],
  changes: Record<string, unknown>,
  record: Record<string, unknown>,
): F | null {
  const status = statusFieldOf(fields);
  const reason = lostReasonFieldOf(fields);
  if (!status || !reason) return null;
  if (!isLostStatus(record[status.name])) return null;
  const touched = status.name in changes || reason.name in changes;
  if (!touched) return null;
  return isBlank(record[reason.name]) ? reason : null;
}

/**
 * True when `field` is the Lost Reason of a Lost record and is still empty —
 * what the screens highlight in red, so the gap is seen before anybody saves.
 */
export function owesLostReason<F extends FieldLike>(
  fields: F[],
  field: F,
  record: Record<string, unknown>,
): boolean {
  const status = statusFieldOf(fields);
  const reason = lostReasonFieldOf(fields);
  if (!status || !reason || reason.name !== field.name) return false;
  return isLostStatus(record[status.name]) && isBlank(record[reason.name]);
}
