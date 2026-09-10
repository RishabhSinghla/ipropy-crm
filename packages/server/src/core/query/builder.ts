/**
 * Metadata-driven SQL builder.
 *
 * Translates a ModuleMeta + FilterGroup into a parameterised SELECT across
 * ipy_record (owner/audit/soft-delete) joined to the module's payload table.
 * Field references are always resolved through metadata — a filter can never
 * name a column that isn't a declared field, which is what keeps this safe
 * despite building SQL text.
 */
import { type FieldMeta, type FilterCondition, type FilterGroup, isFilterGroup, type ModuleMeta } from '@ipropy/shared';
import { BadRequestError } from '../../utils/errors.js';
import { registry } from '../metadata/registry.js';

export interface BuildContext {
  /** current user, for is_me / is_my_team operators */
  userId: string;
  /** user's group ids */
  groupIds: string[];
  /** users the current user can see (role hierarchy), for is_my_team */
  subordinateIds: string[];
  timezone?: string;
}

export class SqlParams {
  private values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
  all(): unknown[] {
    return this.values;
  }
  get length(): number {
    return this.values.length;
  }
}

/** Table alias for the payload table. `r` is always ipy_record. */
export const ENTITY_ALIAS = 'e';
export const RECORD_ALIAS = 'r';

/**
 * SQL expression that reads a field's value, handling both storage modes.
 * JSON-stored fields are cast to the right type so comparisons and ORDER BY
 * behave like their column-stored siblings.
 */
export function fieldExpr(field: FieldMeta, alias = ENTITY_ALIAS): string {
  /*
    A handful of fields live on ipy_record rather than the payload table.

    Keyed on the *column*, not the field's name. A rename changes the name and
    never the column, so `RECORD_FIELD_MAP[field.name]` stopped matching the
    moment somebody renamed Assigned To — and this then fell through to
    `e.owner_id`, a column the payload table has not got, so every filter and
    sort on that field raised 42703.
  */
  const recordField = RECORD_FIELD_MAP[field.columnName];
  if (recordField && field.storage === 'column' && field.config.__record === true) {
    return `${RECORD_ALIAS}.${recordField}`;
  }
  if (field.storage === 'column') {
    return `${alias}.${quoteIdent(field.columnName)}`;
  }
  const path = `${alias}.custom_fields->>'${escapeJsonKey(field.columnName)}'`;
  switch (field.uitype) {
    case 'integer':
      return `NULLIF(${path},'')::bigint`;
    case 'decimal':
    case 'currency':
    case 'percent':
    case 'area':
    case 'score':
      return `NULLIF(${path},'')::numeric`;
    case 'boolean':
      return `NULLIF(${path},'')::boolean`;
    case 'date':
      return `NULLIF(${path},'')::date`;
    case 'datetime':
      return `NULLIF(${path},'')::timestamptz`;
    case 'multipicklist':
    case 'multireference':
    case 'tags':
    case 'json':
    case 'address':
    case 'geolocation':
    case 'file':
    case 'image':
      // keep as jsonb for containment operators
      return `${alias}.custom_fields->'${escapeJsonKey(field.columnName)}'`;
    default:
      return path;
  }
}

const RECORD_FIELD_MAP: Record<string, string> = {
  owner_id: 'owner_id',
  created_by: 'created_by',
  modified_by: 'modified_by',
  created_at: 'created_at',
  updated_at: 'updated_at',
  record_number: 'record_number',
  label: 'label',
  last_activity_at: 'last_activity_at',
};

/** Pseudo-fields that always exist on every entity module. */
export const SYSTEM_FIELDS: Record<string, { uitype: FieldMeta['uitype']; label: string; column: string }> = {
  id: { uitype: 'reference', label: 'Record ID', column: 'id' },
  owner_id: { uitype: 'owner', label: 'Owner', column: 'owner_id' },
  created_by: { uitype: 'user', label: 'Created By', column: 'created_by' },
  modified_by: { uitype: 'user', label: 'Modified By', column: 'modified_by' },
  created_at: { uitype: 'datetime', label: 'Created At', column: 'created_at' },
  updated_at: { uitype: 'datetime', label: 'Modified At', column: 'updated_at' },
  last_activity_at: { uitype: 'datetime', label: 'Last Activity', column: 'last_activity_at' },
  record_number: { uitype: 'string', label: 'Record #', column: 'record_number' },
};

export function isSystemField(name: string): boolean {
  return name in SYSTEM_FIELDS;
}

export function systemFieldExpr(name: string): string {
  return `${RECORD_ALIAS}.${SYSTEM_FIELDS[name].column}`;
}

/** Resolve `field` (possibly "reference_field.target_field") to a SQL expression. */
export interface ResolvedField {
  expr: string;
  field: FieldMeta | null;
  uitype: FieldMeta['uitype'];
  /** extra JOIN clauses this reference walk needs */
  joins: string[];
}

export async function resolveFieldPath(
  module: ModuleMeta,
  path: string,
  joinRegistry: Map<string, string>,
): Promise<ResolvedField> {
  if (!path.includes('.')) {
    if (isSystemField(path)) {
      return { expr: systemFieldExpr(path), field: null, uitype: SYSTEM_FIELDS[path].uitype, joins: [] };
    }
    const field = module.fields.find((f) => f.name === path);
    if (!field) throw new BadRequestError(`Unknown field '${path}' on ${module.name}`);
    return { expr: fieldExpr(field), field, uitype: field.uitype, joins: [] };
  }

  // Walk one level of reference: "project_id.city"
  const [refName, ...rest] = path.split('.');
  const refField = module.fields.find((f) => f.name === refName);
  if (!refField || refField.uitype !== 'reference') {
    throw new BadRequestError(`'${refName}' is not a lookup field on ${module.name}`);
  }
  const targetModuleName = refField.config.referenceModules?.[0];
  if (!targetModuleName) throw new BadRequestError(`Lookup '${refName}' has no target module`);
  const targetModule = await registry.requireModule(targetModuleName);

  const alias = `j_${refName}`;
  if (!joinRegistry.has(alias)) {
    joinRegistry.set(
      alias,
      `LEFT JOIN ${quoteIdent(targetModule.tableName)} ${alias} ON ${alias}.record_id = ${fieldExpr(refField)}`,
    );
  }

  const targetPath = rest.join('.');
  if (isSystemField(targetPath)) {
    // Joining to ipy_record for the target too would be needed; keep it simple
    // and only support payload fields one hop out.
    throw new BadRequestError(`Cannot filter on system field '${targetPath}' across a lookup`);
  }
  const targetField = targetModule.fields.find((f) => f.name === targetPath);
  if (!targetField) throw new BadRequestError(`Unknown field '${targetPath}' on ${targetModule.name}`);

  return {
    expr: fieldExpr(targetField, alias),
    field: targetField,
    uitype: targetField.uitype,
    joins: [joinRegistry.get(alias)!],
  };
}

// ---------------------------------------------------------------------------
// Filter → WHERE
// ---------------------------------------------------------------------------

export interface WhereResult {
  sql: string;
  joins: string[];
}

export async function buildWhere(
  module: ModuleMeta,
  filter: FilterGroup | undefined,
  params: SqlParams,
  ctx: BuildContext,
): Promise<WhereResult> {
  const joinRegistry = new Map<string, string>();
  const sql = await buildGroup(module, filter, params, ctx, joinRegistry);
  return { sql, joins: [...joinRegistry.values()] };
}

async function buildGroup(
  module: ModuleMeta,
  group: FilterGroup | undefined,
  params: SqlParams,
  ctx: BuildContext,
  joins: Map<string, string>,
): Promise<string> {
  if (!group || !group.conditions?.length) return '';
  const parts: string[] = [];
  for (const node of group.conditions) {
    const sql = isFilterGroup(node)
      ? await buildGroup(module, node, params, ctx, joins)
      : await buildCondition(module, node, params, ctx, joins);
    if (sql) parts.push(`(${sql})`);
  }
  if (parts.length === 0) return '';
  return parts.join(group.logic === 'OR' ? ' OR ' : ' AND ');
}

async function buildCondition(
  module: ModuleMeta,
  cond: FilterCondition,
  params: SqlParams,
  ctx: BuildContext,
  joins: Map<string, string>,
): Promise<string> {
  const path = cond.path ?? cond.field;
  const resolved = await resolveFieldPath(module, path, joins);
  const { expr, uitype } = resolved;
  const op = cond.operator;
  const v = cond.value;

  const isJsonArray = ['multipicklist', 'multireference', 'tags'].includes(uitype);
  const isText = ['string', 'textarea', 'richtext', 'email', 'phone', 'url', 'picklist', 'autonumber', 'formula', 'time'].includes(uitype);

  switch (op) {
    case 'equals':
      if (v === null) return `${expr} IS NULL`;
      return `${expr} = ${castParam(params.add(normalize(uitype, v)), uitype)}`;
    case 'not_equals':
      if (v === null) return `${expr} IS NOT NULL`;
      return `(${expr} IS DISTINCT FROM ${castParam(params.add(normalize(uitype, v)), uitype)})`;

    case 'contains':
      return `${expr}::text ILIKE ${params.add(`%${escapeLike(String(v))}%`)}`;
    case 'not_contains':
      return `(${expr} IS NULL OR ${expr}::text NOT ILIKE ${params.add(`%${escapeLike(String(v))}%`)})`;
    case 'starts_with':
      return `${expr}::text ILIKE ${params.add(`${escapeLike(String(v))}%`)}`;
    case 'ends_with':
      return `${expr}::text ILIKE ${params.add(`%${escapeLike(String(v))}`)}`;

    case 'is_empty':
      return isJsonArray
        ? `(${expr} IS NULL OR jsonb_array_length(COALESCE(${expr},'[]'::jsonb)) = 0)`
        : isText
          ? `(${expr} IS NULL OR ${expr}::text = '')`
          : `${expr} IS NULL`;
    case 'is_not_empty':
      return isJsonArray
        ? `(${expr} IS NOT NULL AND jsonb_array_length(COALESCE(${expr},'[]'::jsonb)) > 0)`
        : isText
          ? `(${expr} IS NOT NULL AND ${expr}::text <> '')`
          : `${expr} IS NOT NULL`;

    case 'greater_than':
      return `${expr} > ${castParam(params.add(normalize(uitype, v)), uitype)}`;
    case 'greater_or_equal':
      return `${expr} >= ${castParam(params.add(normalize(uitype, v)), uitype)}`;
    case 'less_than':
      return `${expr} < ${castParam(params.add(normalize(uitype, v)), uitype)}`;
    case 'less_or_equal':
      return `${expr} <= ${castParam(params.add(normalize(uitype, v)), uitype)}`;
    case 'between': {
      const a = params.add(normalize(uitype, v));
      const b = params.add(normalize(uitype, cond.value2));
      return `${expr} BETWEEN ${castParam(a, uitype)} AND ${castParam(b, uitype)}`;
    }

    case 'in': {
      const arr = asArray(v).map((x) => normalize(uitype, x));
      if (!arr.length) return 'FALSE';
      return `${expr} = ANY(${castArrayParam(params.add(arr), uitype)})`;
    }
    case 'not_in': {
      const arr = asArray(v).map((x) => normalize(uitype, x));
      if (!arr.length) return 'TRUE';
      return `(${expr} IS NULL OR NOT (${expr} = ANY(${castArrayParam(params.add(arr), uitype)})))`;
    }

    case 'is_true':
      return `${expr} = TRUE`;
    case 'is_false':
      return `(${expr} = FALSE OR ${expr} IS NULL)`;

    // --- relative dates, evaluated in the user's timezone -------------------
    case 'today':
      return dateRange(expr, `date_trunc('day', now() AT TIME ZONE ${params.add(tz(ctx))})`, "interval '1 day'", params, ctx);
    case 'tomorrow':
      return dateRange(expr, `date_trunc('day', now() AT TIME ZONE ${params.add(tz(ctx))}) + interval '1 day'`, "interval '1 day'", params, ctx);
    case 'yesterday':
      return dateRange(expr, `date_trunc('day', now() AT TIME ZONE ${params.add(tz(ctx))}) - interval '1 day'`, "interval '1 day'", params, ctx);
    case 'this_week':
      return dateRange(expr, `date_trunc('week', now() AT TIME ZONE ${params.add(tz(ctx))})`, "interval '1 week'", params, ctx);
    case 'this_month':
      return dateRange(expr, `date_trunc('month', now() AT TIME ZONE ${params.add(tz(ctx))})`, "interval '1 month'", params, ctx);
    case 'this_quarter':
      return dateRange(expr, `date_trunc('quarter', now() AT TIME ZONE ${params.add(tz(ctx))})`, "interval '3 months'", params, ctx);
    case 'this_year':
      return dateRange(expr, `date_trunc('year', now() AT TIME ZONE ${params.add(tz(ctx))})`, "interval '1 year'", params, ctx);
    case 'last_n_days': {
      const n = Math.max(0, Number(v) || 0);
      return `${expr} >= now() - ${params.add(`${n} days`)}::interval AND ${expr} <= now()`;
    }
    case 'next_n_days': {
      const n = Math.max(0, Number(v) || 0);
      return `${expr} >= now() AND ${expr} <= now() + ${params.add(`${n} days`)}::interval`;
    }
    case 'older_than_n_days': {
      const n = Math.max(0, Number(v) || 0);
      return `${expr} < now() - ${params.add(`${n} days`)}::interval`;
    }

    case 'is_me':
      return `${expr} = ${params.add(ctx.userId)}::uuid`;
    case 'is_my_team': {
      const ids = [ctx.userId, ...ctx.subordinateIds, ...ctx.groupIds];
      return `${expr} = ANY(${params.add(ids)}::uuid[])`;
    }

    case 'has_any': {
      const arr = asArray(v).map(String);
      if (!arr.length) return 'FALSE';
      return `COALESCE(${expr},'[]'::jsonb) ?| ${params.add(arr)}::text[]`;
    }
    case 'has_all': {
      const arr = asArray(v).map(String);
      if (!arr.length) return 'TRUE';
      return `COALESCE(${expr},'[]'::jsonb) ?& ${params.add(arr)}::text[]`;
    }

    default:
      throw new BadRequestError(`Unsupported filter operator '${op}'`);
  }
}

function dateRange(expr: string, startSql: string, intervalSql: string, _p: SqlParams, _ctx: BuildContext): string {
  return `${expr} >= (${startSql}) AND ${expr} < (${startSql}) + ${intervalSql}`;
}

function tz(ctx: BuildContext): string {
  return ctx.timezone ?? 'Asia/Kolkata';
}

function normalize(uitype: FieldMeta['uitype'], v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (uitype) {
    case 'integer':
      return Math.trunc(Number(v));
    case 'decimal':
    case 'currency':
    case 'percent':
    case 'area':
    case 'score':
      return Number(v);
    case 'boolean':
      return v === true || v === 'true' || v === 1 || v === '1';
    default:
      return v;
  }
}

/**
 * JSON-stored fields come out of `->>` as text. Casting the *parameter* rather
 * than the column keeps index usage on column-stored fields intact.
 */
function castParam(placeholder: string, uitype: FieldMeta['uitype']): string {
  switch (uitype) {
    case 'reference':
    case 'owner':
    case 'user':
      return `${placeholder}::uuid`;
    case 'integer':
      return `${placeholder}::bigint`;
    case 'decimal':
    case 'currency':
    case 'percent':
    case 'area':
    case 'score':
      return `${placeholder}::numeric`;
    case 'boolean':
      return `${placeholder}::boolean`;
    case 'date':
      return `${placeholder}::date`;
    case 'datetime':
      return `${placeholder}::timestamptz`;
    default:
      return placeholder;
  }
}

function castArrayParam(placeholder: string, uitype: FieldMeta['uitype']): string {
  switch (uitype) {
    case 'reference':
    case 'owner':
    case 'user':
      return `${placeholder}::uuid[]`;
    case 'integer':
      return `${placeholder}::bigint[]`;
    case 'decimal':
    case 'currency':
    case 'percent':
    case 'area':
    case 'score':
      return `${placeholder}::numeric[]`;
    case 'date':
      return `${placeholder}::date[]`;
    case 'datetime':
      return `${placeholder}::timestamptz[]`;
    default:
      return `${placeholder}::text[]`;
  }
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  if (typeof v === 'string' && v.includes(',')) return v.split(',').map((s) => s.trim());
  return [v];
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function escapeJsonKey(s: string): string {
  return s.replace(/'/g, "''");
}

/** Only [a-z0-9_] identifiers reach SQL; metadata is the gate but belt-and-braces. */
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new BadRequestError(`Illegal identifier '${name}'`);
  }
  return `"${name}"`;
}

// ---------------------------------------------------------------------------
// Full-text / quick search
// ---------------------------------------------------------------------------

export function buildSearchClause(term: string, params: SqlParams): string {
  const t = term.trim();
  if (!t) return '';
  const like = params.add(`%${escapeLike(t)}%`);
  const ts = params.add(t.split(/\s+/).filter(Boolean).map((w) => `${w}:*`).join(' & '));
  return `(${RECORD_ALIAS}.label ILIKE ${like}
    OR ${RECORD_ALIAS}.record_number ILIKE ${like}
    OR ${RECORD_ALIAS}.search_vector @@ to_tsquery('simple', ${ts}))`;
}

// ---------------------------------------------------------------------------
// ORDER BY
// ---------------------------------------------------------------------------

export async function buildOrderBy(
  module: ModuleMeta,
  sortBy: string | null | undefined,
  sortDir: 'asc' | 'desc' = 'desc',
  joins: Map<string, string>,
): Promise<string> {
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  if (!sortBy) return `${RECORD_ALIAS}.updated_at DESC`;
  try {
    const resolved = await resolveFieldPath(module, sortBy, joins);
    return `${resolved.expr} ${dir} NULLS LAST`;
  } catch {
    return `${RECORD_ALIAS}.updated_at DESC`;
  }
}
