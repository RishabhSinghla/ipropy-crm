import { type UIType } from '@ipropy/shared';

export type InvalidValueStrategy = 'blank' | 'default' | 'keep';

export interface ConversionPlan {
  targetType: UIType;
  valueMap?: Record<string, string>;
  invalidStrategy: InvalidValueStrategy;
  defaultValue?: unknown;
}

export function convertFieldValue(raw: unknown, plan: ConversionPlan): { ok: true; value: unknown } | { ok: false } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const mapped = plan.valueMap?.[String(raw)] ?? raw;
  const text = String(mapped).trim();
  if (['string', 'textarea', 'richtext', 'email', 'phone', 'url'].includes(plan.targetType)) return { ok: true, value: text };
  if (plan.targetType === 'multipicklist') return { ok: true, value: Array.isArray(mapped) ? mapped : text.split(',').map((v) => v.trim()).filter(Boolean) };
  if (plan.targetType === 'picklist') return { ok: true, value: text };
  if (['integer', 'decimal', 'currency', 'percent', 'area', 'score'].includes(plan.targetType)) {
    const n = Number(text.replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) && (plan.targetType !== 'integer' || Number.isInteger(n)) ? { ok: true, value: n } : { ok: false };
  }
  if (plan.targetType === 'boolean') {
    if (['true', '1', 'yes', 'y'].includes(text.toLowerCase())) return { ok: true, value: true };
    if (['false', '0', 'no', 'n'].includes(text.toLowerCase())) return { ok: true, value: false };
    return { ok: false };
  }
  if (plan.targetType === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { ok: true, value: text } : { ok: false };
  if (plan.targetType === 'datetime') return !Number.isNaN(Date.parse(text)) ? { ok: true, value: new Date(text).toISOString() } : { ok: false };
  if (plan.targetType === 'time') return /^([01]\d|2[0-3]):[0-5]\d/.test(text) ? { ok: true, value: text } : { ok: false };
  // JSON/reference/address/file data already carries its own structure.
  return { ok: true, value: mapped };
}
