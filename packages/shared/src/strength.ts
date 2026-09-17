import { UITYPES, type FieldMeta } from './uitypes.js';

/** One field the record has no answer for yet. */
export interface MissingField {
  name: string;
  label: string;
  isMandatory: boolean;
}

/** How complete one record is, and what is missing from it. */
export interface RecordStrength {
  filled: number;
  total: number;
  /** 0–100, rounded. A module with nothing to fill in is 100. */
  percent: number;
  /** Mandatory first, then layout order — the order somebody would fix them in. */
  missing: MissingField[];
}

/**
 * Whether a field is something a person can answer.
 *
 * Counting a formula, a rollup or an AI score would make the percentage
 * unreachable: nobody can type into them, so a record could sit at 80% for
 * ever with nothing a rep could do about it. The same goes for a read-only
 * or hidden field. This reads the metadata rather than a list of field names
 * so a field an admin adds today counts tomorrow without a deploy.
 */
export function isAnswerable(field: FieldMeta): boolean {
  if (!field.isActive) return false;
  if (field.isReadonly) return false;
  if (field.displayType === 'hidden' || field.displayType === 'readonly') return false;
  // The group, not only the `computed` flag: `score` sits in the Computed
  // group without carrying the flag, and an AI score is the clearest example
  // of a number a rep cannot fill in.
  const spec = UITYPES[field.uitype];
  return !spec?.computed && spec?.group !== 'Computed';
}

/**
 * Whether a value counts as answered.
 *
 * `0` and `false` are answers — a budget of zero and an unticked box are both
 * decisions, and treating them as blanks would make a fully filled record
 * read as incomplete. Empty arrays are not: rule 9 keeps JSONB lists as `[]`
 * rather than null, so `[]` is "nothing chosen", not "chosen nothing".
 */
export function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/**
 * How much of a record is filled in, as a percentage of the fields a person
 * could answer.
 *
 * Hidden fields never reach the client — `stripHidden` removes them — so a
 * rep is never marked down for a field they are not allowed to see.
 */
export function recordStrength(
  fields: FieldMeta[],
  values: Record<string, unknown>,
): RecordStrength {
  const answerable = fields.filter(isAnswerable);
  const missing: MissingField[] = [];
  let filled = 0;

  for (const field of answerable) {
    if (isAnswered(values[field.name])) filled += 1;
    else missing.push({ name: field.name, label: field.label, isMandatory: field.isMandatory });
  }

  missing.sort((a, b) => Number(b.isMandatory) - Number(a.isMandatory));

  const total = answerable.length;
  return { filled, total, percent: total ? Math.round((filled / total) * 100) : 100, missing };
}
