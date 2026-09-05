/**
 * In-memory evaluation of a FilterGroup against a single record.
 *
 * The same filter shape drives SQL list views and, here, workflow conditions,
 * conditional field visibility and assignment rules — so an admin builds a
 * condition once and it means the same thing everywhere.
 *
 * Lives in `shared` rather than on the server because the *form* needs it too:
 * "show this field only when Loan Required is Yes" has to be decided while the
 * user types, and a second implementation in the web package would be a copy
 * that drifts. Same reasoning as `collectFieldErrors` in uitypes.ts.
 */
import { isFilterGroup, type FilterCondition, type FilterGroup, type FilterOperator } from './uitypes.js';

export interface EvalContext {
  userId?: string;
  teamIds?: string[];
  timezone?: string;
  /** previous values, so 'changed' style conditions can be expressed */
  previous?: Record<string, unknown>;
}

export function evaluateFilter(
  filter: FilterGroup | undefined,
  values: Record<string, unknown>,
  ctx: EvalContext = {},
): boolean {
  if (!filter || !filter.conditions?.length) return true;
  const results = filter.conditions.map((node) =>
    isFilterGroup(node) ? evaluateFilter(node, values, ctx) : evaluateCondition(node, values, ctx),
  );
  return filter.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

export function evaluateCondition(
  cond: FilterCondition,
  values: Record<string, unknown>,
  ctx: EvalContext = {},
): boolean {
  const path = cond.path ?? cond.field;
  const actual = readPath(values, path);
  return applyOperator(cond.operator, actual, cond.value, cond.value2, ctx);
}

function readPath(values: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return values[path];
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, values);
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function asNum(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/[,\s₹%]/g, ''));
  return Number.isFinite(n) ? n : Number.NaN;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isBlank(v)) return [];
  if (typeof v === 'string' && v.includes(',')) return v.split(',').map((s) => s.trim());
  return [v];
}

/**
 * The same instant, with its UTC fields holding the wall clock in `timeZone`.
 *
 * Period arithmetic below is written in UTC getters, so shifting both the value
 * under test and "now" through here makes every comparison happen in the
 * organisation's day rather than the server's.
 *
 * `sv-SE` because it formats as `YYYY-MM-DD HH:mm:ss`, which `Date` parses
 * without ambiguity. Appending `Z` is what moves the wall clock into the UTC
 * fields.
 *
 * India has no daylight saving, so this is exact for iPropy. For a zone that
 * does, the offset is resolved per instant and only a period boundary landing
 * inside a transition hour can be off — worth knowing, not worth solving here.
 */
function zoned(date: Date, timeZone: string | undefined): Date {
  if (!timeZone) return date;
  try {
    return new Date(`${date.toLocaleString('sv-SE', { timeZone })}Z`);
  } catch {
    // An unknown zone should not take the filter down with it.
    return date;
  }
}

/**
 * Start of the period containing `ref`, in wall-clock terms.
 *
 * Written with UTC getters throughout: callers pass a value already shifted by
 * `zoned()`, so "UTC" here means "the organisation's wall clock". Using the
 * local getters — as this did — silently meant the *server's* wall clock, which
 * is UTC in a container and Asia/Kolkata on the developer's Mac. The SQL engine
 * has always used `AT TIME ZONE` with the organisation's zone, so the two
 * disagreed for the five and a half hours a day when the dates differ.
 */
function startOf(unit: 'day' | 'week' | 'month' | 'quarter' | 'year', ref: Date): Date {
  const d = new Date(ref);
  d.setUTCHours(0, 0, 0, 0);
  switch (unit) {
    case 'day': return d;
    case 'week': {
      // Monday-start weeks, matching Postgres' date_trunc('week', ...)
      const day = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - day);
      return d;
    }
    case 'month': d.setUTCDate(1); return d;
    case 'quarter': d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3, 1); return d;
    case 'year': d.setUTCMonth(0, 1); return d;
  }
}

function addUnit(date: Date, unit: 'day' | 'week' | 'month' | 'quarter' | 'year', n: number): Date {
  const d = new Date(date);
  switch (unit) {
    case 'day': d.setUTCDate(d.getUTCDate() + n); break;
    case 'week': d.setUTCDate(d.getUTCDate() + n * 7); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + n); break;
    case 'quarter': d.setUTCMonth(d.getUTCMonth() + n * 3); break;
    case 'year': d.setUTCFullYear(d.getUTCFullYear() + n); break;
  }
  return d;
}

function inPeriod(
  actual: unknown,
  unit: 'day' | 'week' | 'month' | 'quarter' | 'year',
  offset = 0,
  timeZone?: string,
): boolean {
  const d = asDate(actual);
  if (!d) return false;
  // Both sides shifted the same way, so the comparison happens in the
  // organisation's day rather than the server's.
  const start = addUnit(startOf(unit, zoned(new Date(), timeZone)), unit, offset);
  const end = addUnit(start, unit, 1);
  const value = zoned(d, timeZone);
  return value >= start && value < end;
}

export function applyOperator(
  op: FilterOperator,
  actual: unknown,
  expected: unknown,
  expected2: unknown,
  ctx: EvalContext = {},
): boolean {
  switch (op) {
    case 'equals':
      if (isBlank(expected)) return isBlank(actual);
      if (typeof actual === 'boolean' || typeof expected === 'boolean') {
        return Boolean(actual) === (expected === true || expected === 'true');
      }
      return String(actual ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
    case 'not_equals':
      return !applyOperator('equals', actual, expected, expected2, ctx);

    case 'contains':
      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'not_contains':
      return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'starts_with':
      return String(actual ?? '').toLowerCase().startsWith(String(expected ?? '').toLowerCase());
    case 'ends_with':
      return String(actual ?? '').toLowerCase().endsWith(String(expected ?? '').toLowerCase());

    case 'is_empty': return isBlank(actual);
    case 'is_not_empty': return !isBlank(actual);

    case 'greater_than': return compareNumericOrDate(actual, expected, (a, b) => a > b);
    case 'greater_or_equal': return compareNumericOrDate(actual, expected, (a, b) => a >= b);
    case 'less_than': return compareNumericOrDate(actual, expected, (a, b) => a < b);
    case 'less_or_equal': return compareNumericOrDate(actual, expected, (a, b) => a <= b);
    case 'between':
      return compareNumericOrDate(actual, expected, (a, b) => a >= b)
        && compareNumericOrDate(actual, expected2, (a, b) => a <= b);

    case 'in':
      return asArray(expected).some((e) => String(e).toLowerCase() === String(actual ?? '').toLowerCase());
    case 'not_in':
      return !asArray(expected).some((e) => String(e).toLowerCase() === String(actual ?? '').toLowerCase());

    case 'is_true': return actual === true || actual === 'true' || actual === 1;
    case 'is_false': return actual === false || actual === 'false' || actual === 0 || isBlank(actual);

    case 'today': return inPeriod(actual, 'day', 0, ctx.timezone);
    case 'tomorrow': return inPeriod(actual, 'day', 1, ctx.timezone);
    case 'yesterday': return inPeriod(actual, 'day', -1, ctx.timezone);
    case 'this_week': return inPeriod(actual, 'week', 0, ctx.timezone);
    case 'this_month': return inPeriod(actual, 'month', 0, ctx.timezone);
    case 'this_quarter': return inPeriod(actual, 'quarter', 0, ctx.timezone);
    case 'this_year': return inPeriod(actual, 'year', 0, ctx.timezone);

    case 'last_n_days': {
      const d = asDate(actual);
      if (!d) return false;
      const n = Number(expected) || 0;
      const now = new Date();
      return d <= now && d >= new Date(now.getTime() - n * 86_400_000);
    }
    case 'next_n_days': {
      const d = asDate(actual);
      if (!d) return false;
      const n = Number(expected) || 0;
      const now = new Date();
      return d >= now && d <= new Date(now.getTime() + n * 86_400_000);
    }
    case 'older_than_n_days': {
      const d = asDate(actual);
      if (!d) return false;
      const n = Number(expected) || 0;
      return d < new Date(Date.now() - n * 86_400_000);
    }

    case 'is_me': return String(actual ?? '') === String(ctx.userId ?? '');
    case 'is_my_team': return (ctx.teamIds ?? []).includes(String(actual ?? ''));

    case 'has_any': {
      const have = asArray(actual).map((x) => String(x).toLowerCase());
      return asArray(expected).some((e) => have.includes(String(e).toLowerCase()));
    }
    case 'has_all': {
      const have = asArray(actual).map((x) => String(x).toLowerCase());
      return asArray(expected).every((e) => have.includes(String(e).toLowerCase()));
    }

    default:
      return false;
  }
}

function compareNumericOrDate(a: unknown, b: unknown, cmp: (x: number, y: number) => boolean): boolean {
  if (isBlank(a) || isBlank(b)) return false;
  const na = asNum(a);
  const nb = asNum(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return cmp(na, nb);
  const da = asDate(a);
  const dbv = asDate(b);
  if (da && dbv) return cmp(da.getTime(), dbv.getTime());
  return cmp(String(a).localeCompare(String(b)), 0);
}

/** Collect every field name referenced by a filter — used to know what to watch. */
export function collectFilterFields(filter: FilterGroup | undefined): string[] {
  if (!filter) return [];
  const out = new Set<string>();
  const walk = (g: FilterGroup): void => {
    for (const node of g.conditions) {
      if (isFilterGroup(node)) walk(node);
      else out.add((node.path ?? node.field).split('.')[0]);
    }
  };
  walk(filter);
  return [...out];
}
