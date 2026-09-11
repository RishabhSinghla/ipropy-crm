/**
 * Spreadsheet values need a little help before the generic record engine sees
 * them.  This is deliberately a small adapter, not a second validator: after
 * this pass every value still goes through `recordService`, the same metadata
 * coercion and validation used by a normal CRM form.
 */
import type { FieldMeta } from '@ipropy/shared';

export interface ImportSettings {
  /** Per destination field: source spelling -> CRM spelling. */
  valueMappings?: Record<string, Record<string, string>>;
  /** A custom multi-picklist delimiter, in addition to common CSV delimiters. */
  multiValueSeparator?: string;
  /** A non-ISO source date is only read when the person confirmed its order. */
  dateFormat?: 'dd-mm-yyyy' | 'dd/mm/yyyy' | 'yyyy-mm-dd' | 'mm/dd/yyyy';
  /** Turn a bare Indian ten-digit mobile into +91XXXXXXXXXX. Off by default. */
  normaliseIndianPhones?: boolean;
  /** Values that are applied even where the spreadsheet has no column. */
  defaults?: Record<string, unknown>;
}

function mapped(value: unknown, values: Record<string, string> | undefined): unknown {
  if (!values || value === null || value === undefined) return value;
  const raw = String(value).trim();
  return values[raw] ?? Object.entries(values).find(([from]) => from.toLowerCase() === raw.toLowerCase())?.[1] ?? value;
}

function asIsoDate(value: unknown, format: ImportSettings['dateFormat']): unknown {
  const text = String(value).trim();
  if (!format || /^\d{4}-\d{2}-\d{2}$/.test(text)) return value;
  const matcher = format === 'dd-mm-yyyy' ? /^(\d{1,2})-(\d{1,2})-(\d{4})$/
    : format === 'dd/mm/yyyy' ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
      : format === 'mm/dd/yyyy' ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
        : /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  const parts = text.match(matcher);
  if (!parts) return value;
  const [year, month, day] = format === 'yyyy-mm-dd'
    ? [Number(parts[1]), Number(parts[2]), Number(parts[3])]
    : format === 'mm/dd/yyyy'
      ? [Number(parts[3]), Number(parts[1]), Number(parts[2])]
      : [Number(parts[3]), Number(parts[2]), Number(parts[1])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // JavaScript otherwise turns 31/02 into March without telling anyone.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return value;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

/** Convert one mapped row without deciding whether it is valid. */
export function normaliseImportRow(
  source: Record<string, string>,
  mapping: Record<string, string>,
  fields: FieldMeta[],
  settings: ImportSettings = {},
): Record<string, unknown> {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const output: Record<string, unknown> = { ...(settings.defaults ?? {}) };
  for (const [header, fieldName] of Object.entries(mapping)) {
    if (!fieldName) continue;
    const raw = source[header];
    if (raw === undefined || raw === '') continue;
    const field = byName.get(fieldName);
    if (!field) continue;
    let value: unknown = mapped(raw, settings.valueMappings?.[fieldName]);
    if (field.uitype === 'date') value = asIsoDate(value, settings.dateFormat);
    if (field.uitype === 'multipicklist' || field.uitype === 'tags') {
      const separator = settings.multiValueSeparator?.trim();
      value = String(value).split(separator ? new RegExp(`[;,|${separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`) : /[;,|]/)
        .map((part) => mapped(part, settings.valueMappings?.[fieldName]))
        .filter((part) => String(part).trim() !== '');
    }
    if (field.uitype === 'phone' && settings.normaliseIndianPhones) {
      const digits = String(value).replace(/\D/g, '').replace(/^0/, '');
      value = digits.length === 10 ? `+91${digits}` : value;
    }
    output[fieldName] = value;
  }
  return output;
}
