/**
 * Value coercion, validation and display formatting, keyed by uitype.
 *
 * One place decides how a raw API value becomes a DB value and how a DB value
 * becomes a JS value, so the record service, importer, workflow engine and AI
 * tools all agree on what a "date" or a "currency" is.
 */
import type { FieldMeta } from '@ipropy/shared';
import {
  formatIndianPrice, formatArea, toE164, parseIndianPrice, collectFieldErrors, evaluateFilter,
} from '@ipropy/shared';
import { ValidationError } from '../../utils/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^https?:\/\/.+/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

/**
 * Coerce an inbound value to the shape the DB column expects.
 * Throws ValidationError with a field-scoped message on bad input.
 */
/** uitypes stored in NOT NULL jsonb columns — an empty list is a value, not an absence. */
const LIST_TYPES = new Set(['multipicklist', 'multireference', 'tags']);
/**
 * uitypes backing a handful of NOT NULL DEFAULT '' columns (e.g. leads/contacts
 * last_name) — an empty string must round-trip as '' rather than NULL, or the
 * column's NOT NULL constraint rejects it outright. Safe to apply broadly: both
 * filter engines already treat '' and NULL as equivalent for text (builder.ts's
 * is_empty/is_not_empty, evaluate.ts's isBlank), so this changes no query result.
 */
const TEXT_TYPES = new Set(['string', 'textarea', 'richtext']);

export function coerceValue(field: FieldMeta, raw: unknown): unknown {
  // An empty multi-select must round-trip as [] rather than NULL: the payload
  // columns are `jsonb NOT NULL DEFAULT '[]'`, so writing NULL violates the
  // constraint. Mandatory validation still rejects [] via isEmpty().
  if (Array.isArray(raw) && raw.length === 0 && LIST_TYPES.has(field.uitype)) return [];
  if (raw === '' && TEXT_TYPES.has(field.uitype)) return '';
  if (isEmpty(raw)) return null;

  switch (field.uitype) {
    case 'string':
    case 'textarea':
    case 'richtext':
    case 'password': {
      const s = String(raw);
      if (field.maxLength && s.length > field.maxLength) {
        throw new ValidationError(`${field.label} must be at most ${field.maxLength} characters`, { field: field.name });
      }
      return s;
    }

    case 'email': {
      const s = String(raw).trim().toLowerCase();
      if (!EMAIL_RE.test(s)) throw new ValidationError(`${field.label} is not a valid email address`, { field: field.name });
      return s;
    }

    case 'phone': {
      const s = String(raw).trim();
      // Stored as digits, without a country code.
      //
      // This used to force E.164 with a +91 default, which is wrong now that
      // `country_code` is its own field: it would turn a UAE lead's ten digits
      // into an Indian number and quietly make them unreachable. Every lookup
      // in this codebase already matches on the last ten digits, so digits-only
      // storage changes no query — and `toInternational()` puts the code back
      // when something actually needs to dial.
      //
      // A number typed with an explicit `+` keeps its code: that is the caller
      // telling us the country, and discarding it would lose information the
      // field cannot recover.
      const digits = s.replace(/\D/g, '');
      if (!digits) return null;
      return s.startsWith('+') ? `+${digits}` : digits;
    }

    case 'url': {
      const s = String(raw).trim();
      const withProto = URL_RE.test(s) ? s : `https://${s}`;
      try {
        new URL(withProto);
      } catch {
        throw new ValidationError(`${field.label} is not a valid URL`, { field: field.name });
      }
      return withProto;
    }

    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).replace(/[,\s]/g, ''), 10);
      if (!Number.isFinite(n)) throw new ValidationError(`${field.label} must be a whole number`, { field: field.name });
      return Math.trunc(n);
    }

    case 'decimal':
    case 'percent':
    case 'area':
    case 'score': {
      const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(/[,\s%]/g, ''));
      if (!Number.isFinite(n)) throw new ValidationError(`${field.label} must be a number`, { field: field.name });
      if (field.uitype === 'score' && (n < 0 || n > 100)) {
        throw new ValidationError(`${field.label} must be between 0 and 100`, { field: field.name });
      }
      return n;
    }

    case 'currency': {
      // Accepts 12500000, "1.25 Cr", "₹85 L", "12,50,000"
      const n = typeof raw === 'number' ? raw : parseIndianPrice(String(raw));
      if (n === null || !Number.isFinite(n)) {
        throw new ValidationError(`${field.label} must be an amount`, { field: field.name });
      }
      return n;
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      return s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on';
    }

    case 'date': {
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      const s = String(raw).trim();
      if (DATE_RE.test(s)) return s;
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new ValidationError(`${field.label} is not a valid date`, { field: field.name });
      return d.toISOString().slice(0, 10);
    }

    case 'datetime': {
      if (raw instanceof Date) return raw.toISOString();
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw new ValidationError(`${field.label} is not a valid date/time`, { field: field.name });
      return d.toISOString();
    }

    case 'time': {
      const s = String(raw).trim();
      if (!TIME_RE.test(s)) throw new ValidationError(`${field.label} must be HH:mm`, { field: field.name });
      return s;
    }

    case 'picklist': {
      const s = String(raw).trim();
      if (field.options?.length) {
        const match = field.options.find((o) => o.value === s)
          ?? field.options.find((o) => o.value.toLowerCase() === s.toLowerCase())
          ?? field.options.find((o) => o.label.toLowerCase() === s.toLowerCase());
        if (!match) {
          throw new ValidationError(
            `${field.label} must be one of: ${field.options.map((o) => o.value).join(', ')}`,
            { field: field.name, allowed: field.options.map((o) => o.value) },
          );
        }
        return match.value;
      }
      return s;
    }

    case 'multipicklist':
    case 'tags': {
      const arr = toArray(raw).map((v) => String(v).trim()).filter(Boolean);
      if (field.uitype === 'multipicklist' && field.options?.length) {
        const allowed = new Set(field.options.map((o) => o.value));
        const bad = arr.filter((v) => !allowed.has(v));
        if (bad.length) {
          throw new ValidationError(`${field.label} has invalid values: ${bad.join(', ')}`, { field: field.name });
        }
      }
      return arr;
    }

    case 'reference':
    case 'owner':
    case 'user': {
      const s = String(raw).trim();
      if (!UUID_RE.test(s)) throw new ValidationError(`${field.label} must reference a valid record`, { field: field.name });
      return s;
    }

    case 'multireference': {
      const arr = toArray(raw).map((v) => String(v).trim());
      const bad = arr.filter((v) => !UUID_RE.test(v));
      if (bad.length) throw new ValidationError(`${field.label} contains invalid record ids`, { field: field.name });
      return arr;
    }

    case 'address': {
      if (typeof raw === 'string') return { street: raw };
      if (typeof raw === 'object') return raw;
      throw new ValidationError(`${field.label} must be an address object`, { field: field.name });
    }

    case 'geolocation': {
      if (typeof raw === 'object' && raw !== null) {
        const o = raw as Record<string, unknown>;
        const lat = Number(o.lat ?? o.latitude);
        const lng = Number(o.lng ?? o.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          throw new ValidationError(`${field.label} needs numeric lat/lng`, { field: field.name });
        }
        return { lat, lng };
      }
      throw new ValidationError(`${field.label} must be a { lat, lng } object`, { field: field.name });
    }

    case 'file':
    case 'image':
    case 'json':
      return typeof raw === 'string' ? safeJsonParse(raw) : raw;

    case 'autonumber':
    case 'formula':
    case 'rollup':
      // Engine-owned; ignore anything the client sends.
      return undefined;

    default:
      return raw;
  }
}

function toArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      const parsed = safeJsonParse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    }
    // Support "A;B;C" and "A,B,C" from CSV imports.
    return trimmed.split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
  }
  return [raw];
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Wrap a coerced value for the pg driver (JSON columns need stringification). */
export function toDbValue(field: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const jsonTypes = ['multipicklist', 'multireference', 'tags', 'address', 'geolocation', 'file', 'image', 'json'];
  if (jsonTypes.includes(field.uitype)) return JSON.stringify(value);
  return value;
}

/** Convert a DB value back to the JS shape the API returns. */
export function fromDbValue(field: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.uitype) {
    case 'multipicklist':
    case 'multireference':
    case 'tags':
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        const p = safeJsonParse(value);
        return Array.isArray(p) ? p : [];
      }
      return [];
    case 'address':
    case 'geolocation':
    case 'file':
    case 'image':
    case 'json':
      return typeof value === 'string' ? safeJsonParse(value) : value;
    case 'boolean':
      return Boolean(value);
    case 'integer':
    case 'decimal':
    case 'currency':
    case 'percent':
    case 'area':
    case 'score':
      return typeof value === 'number' ? value : Number(value);
    case 'datetime':
      return value instanceof Date ? value.toISOString() : value;
    default:
      return value;
  }
}

/** Human-readable rendering, used in emails, WhatsApp merges and AI prompts. */
export function formatValue(field: FieldMeta, value: unknown, display?: string): string {
  if (isEmpty(value)) return '';
  if (display) return display;
  switch (field.uitype) {
    case 'currency':
      return formatIndianPrice(Number(value));
    case 'area':
      return formatArea(Number(value), (field.config.unit as string) ?? 'sqft');
    case 'percent':
      return `${value}%`;
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'date':
      return new Date(String(value)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    case 'datetime':
      return new Date(String(value)).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    case 'multipicklist':
    case 'tags':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'address': {
      const a = value as Record<string, unknown>;
      return [a.street, a.locality, a.city, a.state, a.pincode, a.country].filter(Boolean).join(', ');
    }
    case 'picklist': {
      const opt = field.options?.find((o) => o.value === value);
      return opt?.label ?? String(value);
    }
    default:
      return String(value);
  }
}

/**
 * Format, range and cross-field validation.
 *
 * Runs on the server on every write, which is the only place it counts — the
 * form's copy of these rules is for fast feedback, not for safety, and the API
 * is reachable without it.
 *
 * Every rule is read from field metadata (`max_length`, `config.min`,
 * `config.pattern`, `config.notAfterField`, …). Nothing here knows what a lead
 * or a budget is, so an admin adding a field gets validation without a deploy,
 * and the engine never grows a `if (module === 'leads')`.
 *
 * Errors accumulate rather than throwing on the first one: a form that reports
 * one problem per submit takes five round trips to fill in.
 */
export function validateValues(
  fields: FieldMeta[],
  values: Record<string, unknown>,
  merged: Record<string, unknown>,
): void {
  const errors = collectFieldErrors(fields, values, merged);
  if (errors.length) {
    throw new ValidationError(errors.map((e) => e.message).join('; '), { fields: errors });
  }
}

/**
 * Mandatory / uniqueness-independent validation of a whole payload.
 *
 * `merged` is the stored record plus this payload — needed because a field's
 * "only show when…" condition may depend on a value the payload doesn't carry.
 */
export function validateRequired(
  fields: FieldMeta[],
  values: Record<string, unknown>,
  isCreate: boolean,
  merged: Record<string, unknown> = values,
): void {
  const errors: { field: string; message: string }[] = [];
  for (const f of fields) {
    if (!f.isMandatory || !f.isActive) continue;
    if (f.displayType === 'hidden') continue;
    // A field the form was told to hide cannot have been filled in. Requiring
    // it anyway would reject a save the user had no way to make valid — the
    // form and the API have to agree on which fields are even on screen.
    if (f.config.visibleWhen && !evaluateFilter(f.config.visibleWhen, merged)) continue;
    // On update, a field simply absent from the payload keeps its stored value.
    if (!isCreate && !(f.name in values)) continue;
    if (isEmpty(values[f.name])) {
      errors.push({ field: f.name, message: `${f.label} is required` });
    }
  }
  if (errors.length) {
    throw new ValidationError(errors.map((e) => e.message).join('; '), { fields: errors });
  }
}
