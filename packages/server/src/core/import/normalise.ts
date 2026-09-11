/**
 * Turning what people actually have in Excel into what the CRM stores.
 *
 * The record API is strict on purpose — ISO dates, ten-digit mobiles, numbers
 * that are numbers — because everything else in the product depends on that.
 * A spreadsheet somebody has kept for four years obeys none of it, and an
 * import that answers "not a valid date" to a column of perfectly ordinary
 * Indian dates is an import nobody can use.
 *
 * So this sits between the cell and `coerceValue`, and it is deliberately the
 * only place that is lenient. Three rules it works to:
 *
 *  * **Never guess between two readings that are both plausible.** `03/04/2026`
 *    is the third of April to everyone who will ever use this CRM and the
 *    fourth of March to `new Date()`. Guessing silently moves a follow-up by a
 *    month; the order is decided once for the whole column, from evidence, and
 *    reported so a person can overrule it.
 *  * **Fail loudly rather than store something plausible-but-wrong.** A value
 *    this cannot read comes back `null` with a reason, and the row fails with
 *    that reason on it.
 *  * **Correct only presentation.** `₹`, spaces, `Sq. Yds.` and a leading zero
 *    are how the number was typed, not what it means.
 */
import { parseIndianPrice, type FieldMeta } from '@ipropy/shared';

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

export interface NormaliseContext {
  /** How to read an ambiguous `05/06/2026`. */
  dateOrder: DateOrder;
  /** Separator for a multi-select cell. */
  listSeparator: RegExp;
}

export const DEFAULT_CONTEXT: NormaliseContext = { dateOrder: 'dmy', listSeparator: /[;,|]/ };

export interface Normalised {
  value: unknown;
  /** Set when the cell could not be read; the row fails with this sentence. */
  problem?: string;
  /** Set when the cell was read, but in a way worth showing in the preview. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const SEPARATED = /^(\d{1,4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,4})$/;

/**
 * Which way round a column of dates is written, from the column itself.
 *
 * A single `13/04/2026` settles it: there is no thirteenth month. Only when
 * every row could be read both ways is this undecidable, and then the caller's
 * choice stands rather than a coin toss.
 */
export function detectDateOrder(samples: unknown[]): { order: DateOrder | null; certain: boolean } {
  let sawHighFirst = false;
  let sawHighSecond = false;
  let sawIso = false;

  for (const sample of samples) {
    const s = String(sample ?? '').trim();
    if (!s) continue;
    const m = SEPARATED.exec(s);
    if (!m) continue;
    const [, a, b] = m;
    if (a!.length === 4) { sawIso = true; continue; }
    if (Number(a) > 12) sawHighFirst = true;
    if (Number(b) > 12) sawHighSecond = true;
  }

  if (sawHighFirst && !sawHighSecond) return { order: 'dmy', certain: true };
  if (sawHighSecond && !sawHighFirst) return { order: 'mdy', certain: true };
  if (sawIso && !sawHighFirst && !sawHighSecond) return { order: 'ymd', certain: true };
  return { order: null, certain: false };
}

/** Excel keeps dates as days since 1899-12-30. */
function fromExcelSerial(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 60_000) return null;
  // Built in UTC and read in UTC, so no zone can move it a day.
  const ms = Math.round((n - 25_569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Rejects the 31st of a 30-day month rather than rolling into the next one.
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

export function normaliseDate(raw: unknown, order: DateOrder = 'dmy'): Normalised {
  if (raw instanceof Date) return { value: raw.toISOString().slice(0, 10) };
  const s = String(raw ?? '').trim();
  if (!s) return { value: null };

  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = fromExcelSerial(Number(s));
    if (serial) return { value: serial, note: 'read as an Excel date' };
  }

  const m = SEPARATED.exec(s);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]); const c = Number(m[3]);
    const fourDigitFirst = m[1]!.length === 4;
    const year = fourDigitFirst ? a : c < 100 ? 2000 + c : c;
    const out = fourDigitFirst
      ? iso(year, b, c)
      : order === 'mdy' ? iso(year, a, b) : iso(year, b, a);
    if (out) return { value: out };
    return { value: null, problem: `“${s}” is not a real date` };
  }

  // Month names and anything else the platform can read unambiguously.
  //
  // Read back off the *local* parts, never `toISOString()`. "20 May 2026"
  // parses as local midnight, and in IST local midnight is 18:30 the previous
  // day in UTC — so the ISO string is the 19th. A follow-up quietly a day
  // early is the same class of bug as reading an EXIF timestamp as UTC.
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime()) && /[A-Za-z]/.test(s)) {
    return { value: iso(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()) };
  }
  return { value: null, problem: `“${s}” is not a date this can read` };
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

/**
 * `09810012345`, `+91 98100 12345` and `98100-12345` are one number.
 *
 * The leading zero is a trunk prefix people type out of habit; `+91` is the
 * country code the CRM keeps in its own field. Both are presentation. What is
 * kept is the ten digits every lookup in this codebase matches on.
 */
export function normalisePhone(raw: unknown, expectedDigits = 10): Normalised {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null };
  let digits = s.replace(/\D/g, '');
  if (!digits) return { value: null, problem: `“${s}” has no digits in it` };

  if (digits.length > expectedDigits) {
    const trimmed = digits.replace(/^0+/, '');
    if (trimmed.length === expectedDigits) digits = trimmed;
  }
  if (digits.length > expectedDigits) {
    // A country code in front of a national number of the expected length.
    const tail = digits.slice(-expectedDigits);
    const prefix = digits.slice(0, -expectedDigits);
    if (/^(0|91|091|0091)$/.test(prefix)) digits = tail;
  }
  if (digits.length !== expectedDigits) {
    return { value: null, problem: `“${s}” is not a ${expectedDigits}-digit number` };
  }
  return { value: digits, note: digits === s ? undefined : `read as ${digits}` };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** `Sq Yard`, `sq.yd`, `SQ YDS` and `Sq. Yds.` are the same unit. */
function unitKey(value: string): string {
  return value.toLowerCase()
    .replace(/[.\s_-]/g, '')
    .replace(/s$/, '')
    .replace(/square/g, 'sq')
    .replace(/yards?|yds?/g, 'yd')
    .replace(/feet|foot|fts?/g, 'ft')
    .replace(/met(er|re)s?|mtrs?/g, 'm');
}

export function normaliseUnit(raw: unknown, options: { value: string; label: string }[]): Normalised {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null };
  if (!options.length) return { value: s };

  const key = unitKey(s);
  for (const option of options) {
    if (unitKey(option.value) === key || unitKey(option.label) === key) {
      return { value: option.value, note: option.value === s ? undefined : `matched to ${option.label}` };
    }
  }
  return { value: null, problem: `“${s}” is not one of the units set up for this field` };
}

/** `250 Sq. Yds.` in one cell — the number and the unit, separated. */
export function splitAmountAndUnit(raw: unknown): { amount: string; unit: string | null } {
  const s = String(raw ?? '').trim();
  const m = /^([\d,.\s]+)\s*([A-Za-z.\s]+)$/.exec(s);
  if (!m) return { amount: s, unit: null };
  return { amount: m[1]!.trim(), unit: m[2]!.trim() };
}

// ---------------------------------------------------------------------------

/** The one entry point the import loop calls. */
export function normaliseForField(
  field: FieldMeta,
  raw: unknown,
  ctx: NormaliseContext = DEFAULT_CONTEXT,
): Normalised {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null };

  switch (field.uitype) {
    case 'date':
      return normaliseDate(raw, ctx.dateOrder);
    case 'datetime': {
      const d = normaliseDate(raw, ctx.dateOrder);
      return d.value ? { ...d, value: `${String(d.value)}T00:00:00.000Z` } : d;
    }
    case 'phone': {
      const expected = Number(field.config.digits ?? 10) || 10;
      return normalisePhone(raw, expected);
    }
    case 'currency': {
      const n = typeof raw === 'number' ? raw : parseIndianPrice(String(raw));
      if (n === null || !Number.isFinite(n)) {
        return { value: null, problem: `“${String(raw)}” is not an amount this can read` };
      }
      return { value: n, note: String(n) === String(raw).trim() ? undefined : `read as ${n}` };
    }
    case 'area':
    case 'decimal':
    case 'integer': {
      // A cell may carry its unit: "250 Sq. Yds.". The unit goes to the
      // companion field through `splitAmountAndUnit`; here it is stripped so
      // the number survives.
      const { amount } = splitAmountAndUnit(raw);
      const n = Number(String(amount).replace(/,/g, ''));
      if (!Number.isFinite(n)) return { value: null, problem: `“${String(raw)}” is not a number` };
      return { value: n };
    }
    case 'picklist':
    case 'multipicklist': {
      const options = (field.config.unitOptions ?? []) as { value: string; label: string }[];
      // A unit selector is a picklist whose options come from a master, and
      // those have spellings of their own.
      if (options.length) return normaliseUnit(raw, options);
      return { value: raw };
    }
    default:
      return { value: raw };
  }
}
