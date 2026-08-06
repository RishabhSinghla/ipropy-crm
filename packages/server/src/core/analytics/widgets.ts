/**
 * Widget/report query engine.
 *
 * One function turns a WidgetConfig (module + aggregate + groupBy + filter)
 * into a result, so dashboards, reports and the AI's data tools all share the
 * same code path and the same permission scoping.
 */
import type { WidgetConfig, WidgetType } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { BadRequestError } from '../../utils/errors.js';
import { registry } from '../metadata/registry.js';
import {
  ENTITY_ALIAS, RECORD_ALIAS, SqlParams, buildWhere, fieldExpr,
  quoteIdent, resolveFieldPath, type BuildContext,
} from '../query/builder.js';
import { recordScopeSql, type ScopeContext } from '../permissions/index.js';

export interface WidgetResult {
  type: WidgetType | string;
  title?: string;
  /** scalar widgets */
  value?: number;
  previousValue?: number;
  changePercent?: number;
  target?: number;
  /** series widgets */
  series?: { key: string; label: string; value: number; color?: string | null; secondary?: number }[];
  /** multi-series (stacked) */
  stacked?: { key: string; label: string; segments: { key: string; label: string; value: number; color?: string | null }[] }[];
  /** table/list widgets */
  rows?: Record<string, unknown>[];
  columns?: string[];
  /** funnel */
  stages?: { key: string; label: string; value: number; conversionFromPrevious: number; conversionFromFirst: number }[];
  format?: string;
  total?: number;
  meta?: Record<string, unknown>;
}

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

function aggregateExpr(agg: string, expr: string | null): string {
  if (agg === 'count' || !expr) return 'COUNT(*)::numeric';
  if (!AGGREGATES.has(agg)) throw new BadRequestError(`Unsupported aggregate '${agg}'`);
  return `COALESCE(${agg.toUpperCase()}(${expr}), 0)::numeric`;
}

interface QueryPieces {
  from: string;
  where: string;
  params: SqlParams;
  moduleTable: string;
}

async function baseQuery(
  ctx: ScopeContext,
  moduleName: string,
  filter: WidgetConfig['filter'],
  extraJoins: Map<string, string> = new Map(),
): Promise<QueryPieces> {
  const module = await registry.requireModule(moduleName);
  const params = new SqlParams();
  const buildCtx: BuildContext = {
    userId: ctx.user.id,
    groupIds: ctx.groupIds,
    subordinateIds: ctx.subordinateIds,
    timezone: ctx.user.timezone,
  };

  const clauses = [
    `${RECORD_ALIAS}.module_id = ${params.add(module.id)}::uuid`,
    `${RECORD_ALIAS}.is_deleted = false`,
  ];

  if (filter) {
    const w = await buildWhere(module, filter, params, buildCtx);
    if (w.sql) clauses.push(w.sql);
    for (const j of w.joins) extraJoins.set(j, j);
  }

  const scope = await recordScopeSql(ctx, moduleName, params);
  if (scope) clauses.push(scope);

  return {
    from: `FROM ipy_record ${RECORD_ALIAS}
           JOIN ${quoteIdent(module.tableName)} ${ENTITY_ALIAS} ON ${ENTITY_ALIAS}.record_id = ${RECORD_ALIAS}.id
           ${[...extraJoins.values()].join('\n')}`,
    where: `WHERE ${clauses.join(' AND ')}`,
    params,
    moduleTable: module.tableName,
  };
}

export async function runWidget(
  ctx: ScopeContext,
  type: WidgetType | string,
  config: WidgetConfig,
  conn: Tx = db,
): Promise<WidgetResult> {
  switch (type) {
    case 'metric':
    case 'gauge':
      return runMetric(ctx, config, conn, type);
    case 'bar':
    case 'pie':
    case 'donut':
    case 'leaderboard':
      return runGrouped(ctx, config, conn, type);
    case 'line':
    case 'area':
      return runTimeSeries(ctx, config, conn, type);
    case 'funnel':
      return runFunnel(ctx, config, conn);
    case 'table':
    case 'list':
    case 'tasks':
      return runTable(ctx, config, conn, type);
    case 'inventory_status':
      return runStacked(ctx, config, conn);
    case 'pipeline_forecast':
      return runForecast(ctx, config, conn);
    case 'heatmap':
      return runHeatmap(ctx, config, conn);
    case 'markdown':
    case 'iframe':
    case 'ai_insights':
    case 'activity_feed':
    case 'calendar':
      // Rendered client-side or by a dedicated endpoint.
      return { type, meta: config as Record<string, unknown> };
    default:
      throw new BadRequestError(`Unknown widget type '${type}'`);
  }
}

// ---------------------------------------------------------------------------

async function runMetric(ctx: ScopeContext, config: WidgetConfig, conn: Tx, type: string): Promise<WidgetResult> {
  if (!config.module) throw new BadRequestError('metric widget needs a module');
  const module = await registry.requireModule(config.module);
  const joins = new Map<string, string>();
  const { from, where, params } = await baseQuery(ctx, config.module, config.filter, joins);

  const aggField = config.aggregateField
    ? module.fields.find((f) => f.name === config.aggregateField)
    : null;
  const expr = aggField ? fieldExpr(aggField) : null;
  const agg = config.aggregate ?? 'count';

  const row = await conn.queryOne<{ value: number }>(
    `SELECT ${aggregateExpr(agg, expr)} AS value ${from} ${where}`,
    params.all(),
  );
  const value = Number(row?.value ?? 0);

  const result: WidgetResult = {
    type, value,
    format: config.format ?? (aggField?.uitype === 'currency' ? 'currency' : 'number'),
    target: config.target,
  };

  // Compare against the equivalent window one period back.
  if (config.comparePrevious && config.dateField) {
    const prevFilter = shiftFilterToPreviousPeriod(config.filter, config.dateField);
    if (prevFilter) {
      const prevJoins = new Map<string, string>();
      const prev = await baseQuery(ctx, config.module, prevFilter, prevJoins);
      const prevRow = await conn.queryOne<{ value: number }>(
        `SELECT ${aggregateExpr(agg, expr)} AS value ${prev.from} ${prev.where}`,
        prev.params.all(),
      );
      const previousValue = Number(prevRow?.value ?? 0);
      result.previousValue = previousValue;
      result.changePercent = previousValue === 0
        ? (value > 0 ? 100 : 0)
        : Math.round(((value - previousValue) / previousValue) * 1000) / 10;
    }
  }

  return result;
}

/**
 * Rewrite `this_month` → previous month, `last_n_days` → the n days before that,
 * so the comparison window is genuinely like-for-like.
 */
function shiftFilterToPreviousPeriod(
  filter: WidgetConfig['filter'],
  dateField: string,
): WidgetConfig['filter'] | null {
  if (!filter) return null;
  const now = new Date();
  const clone = JSON.parse(JSON.stringify(filter)) as NonNullable<WidgetConfig['filter']>;
  let changed = false;

  const walk = (group: NonNullable<WidgetConfig['filter']>): void => {
    for (const node of group.conditions) {
      if ('conditions' in node) { walk(node as NonNullable<WidgetConfig['filter']>); continue; }
      const cond = node as { field: string; operator: string; value?: unknown; value2?: unknown };
      if (cond.field !== dateField) continue;
      switch (cond.operator) {
        case 'this_month': {
          const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const end = new Date(now.getFullYear(), now.getMonth(), 1);
          cond.operator = 'between';
          cond.value = start.toISOString();
          cond.value2 = end.toISOString();
          changed = true;
          break;
        }
        case 'this_week': {
          const day = (now.getDay() + 6) % 7;
          const startThis = new Date(now); startThis.setHours(0, 0, 0, 0); startThis.setDate(startThis.getDate() - day);
          const start = new Date(startThis); start.setDate(start.getDate() - 7);
          cond.operator = 'between';
          cond.value = start.toISOString();
          cond.value2 = startThis.toISOString();
          changed = true;
          break;
        }
        case 'this_quarter': {
          const q = Math.floor(now.getMonth() / 3);
          const start = new Date(now.getFullYear(), (q - 1) * 3, 1);
          const end = new Date(now.getFullYear(), q * 3, 1);
          cond.operator = 'between';
          cond.value = start.toISOString();
          cond.value2 = end.toISOString();
          changed = true;
          break;
        }
        case 'this_year': {
          cond.operator = 'between';
          cond.value = new Date(now.getFullYear() - 1, 0, 1).toISOString();
          cond.value2 = new Date(now.getFullYear(), 0, 1).toISOString();
          changed = true;
          break;
        }
        case 'last_n_days': {
          const n = Number(cond.value) || 0;
          const end = new Date(Date.now() - n * 86_400_000);
          const start = new Date(end.getTime() - n * 86_400_000);
          cond.operator = 'between';
          cond.value = start.toISOString();
          cond.value2 = end.toISOString();
          changed = true;
          break;
        }
        default:
          break;
      }
    }
  };
  walk(clone);
  return changed ? clone : null;
}

// ---------------------------------------------------------------------------

async function runGrouped(ctx: ScopeContext, config: WidgetConfig, conn: Tx, type: string): Promise<WidgetResult> {
  if (!config.module || !config.groupBy) throw new BadRequestError('grouped widget needs module and groupBy');
  const module = await registry.requireModule(config.module);
  const joins = new Map<string, string>();
  const grouped = await resolveFieldPath(module, config.groupBy, joins);
  const { from, where, params } = await baseQuery(ctx, config.module, config.filter, joins);

  const aggField = config.aggregateField ? module.fields.find((f) => f.name === config.aggregateField) : null;
  const expr = aggField ? fieldExpr(aggField) : null;
  const agg = config.aggregate ?? 'count';
  const limit = config.limit ?? 25;

  const res = await conn.query<{ key: string | null; value: number }>(
    `SELECT ${grouped.expr}::text AS key, ${aggregateExpr(agg, expr)} AS value
     ${from} ${where}
     GROUP BY 1
     ORDER BY 2 DESC
     LIMIT ${params.add(limit)}`,
    params.all(),
  );

  // Resolve labels: picklist labels, user names, or referenced record labels.
  const labels = await resolveGroupLabels(conn, grouped, res.rows.map((r) => r.key));

  const series = res.rows.map((r) => ({
    key: r.key ?? '',
    label: labels.get(r.key ?? '')?.label ?? (r.key || '(none)'),
    value: Number(r.value),
    color: labels.get(r.key ?? '')?.color ?? null,
  }));

  return {
    type,
    series,
    total: series.reduce((a, b) => a + b.value, 0),
    format: config.format ?? (aggField?.uitype === 'currency' ? 'currency' : 'number'),
  };
}

async function resolveGroupLabels(
  conn: Tx,
  grouped: Awaited<ReturnType<typeof resolveFieldPath>>,
  keys: (string | null)[],
): Promise<Map<string, { label: string; color?: string | null }>> {
  const out = new Map<string, { label: string; color?: string | null }>();
  const field = grouped.field;
  const clean = keys.filter((k): k is string => Boolean(k));

  if (field?.options?.length) {
    for (const o of field.options) out.set(o.value, { label: o.label, color: o.color });
    return out;
  }

  if (grouped.uitype === 'reference' || grouped.uitype === 'multireference') {
    if (!clean.length) return out;
    const res = await conn.query<{ id: string; label: string }>(
      `SELECT id, label FROM ipy_record WHERE id = ANY($1::uuid[])`, [clean],
    );
    for (const r of res.rows) out.set(r.id, { label: r.label });
    return out;
  }

  if (grouped.uitype === 'owner' || grouped.uitype === 'user') {
    if (!clean.length) return out;
    const [users, groups] = await Promise.all([
      conn.query<{ id: string; name: string }>(
        `SELECT id, trim(first_name || ' ' || last_name) AS name FROM ipy_user WHERE id = ANY($1::uuid[])`, [clean],
      ),
      conn.query<{ id: string; name: string }>(`SELECT id, name FROM ipy_group WHERE id = ANY($1::uuid[])`, [clean]),
    ]);
    for (const r of [...users.rows, ...groups.rows]) out.set(r.id, { label: r.name });
    return out;
  }

  return out;
}

// ---------------------------------------------------------------------------

async function runTimeSeries(ctx: ScopeContext, config: WidgetConfig, conn: Tx, type: string): Promise<WidgetResult> {
  if (!config.module) throw new BadRequestError('time series widget needs a module');
  const module = await registry.requireModule(config.module);
  const dateFieldName = config.dateField ?? 'created_at';
  const joins = new Map<string, string>();
  const dateResolved = await resolveFieldPath(module, dateFieldName, joins);
  const { from, where, params } = await baseQuery(ctx, config.module, config.filter, joins);

  const interval = config.interval ?? 'month';
  const allowed = ['day', 'week', 'month', 'quarter', 'year'];
  if (!allowed.includes(interval)) throw new BadRequestError(`Unsupported interval '${interval}'`);

  const aggField = config.aggregateField ? module.fields.find((f) => f.name === config.aggregateField) : null;
  const expr = aggField ? fieldExpr(aggField) : null;
  const agg = config.aggregate ?? 'count';
  const tzParam = params.add(ctx.user.timezone || 'Asia/Kolkata');

  const res = await conn.query<{ bucket: string; value: number }>(
    `SELECT date_trunc('${interval}', (${dateResolved.expr}) AT TIME ZONE ${tzParam})::date::text AS bucket,
            ${aggregateExpr(agg, expr)} AS value
     ${from} ${where} AND ${dateResolved.expr} IS NOT NULL
     GROUP BY 1
     ORDER BY 1 ASC`,
    params.all(),
  );

  const series = res.rows.map((r) => ({
    key: r.bucket,
    label: formatBucket(r.bucket, interval),
    value: Number(r.value),
  }));

  return {
    type, series,
    total: series.reduce((a, b) => a + b.value, 0),
    format: config.format ?? (aggField?.uitype === 'currency' ? 'currency' : 'number'),
    meta: { interval },
  };
}

function formatBucket(bucket: string, interval: string): string {
  const d = new Date(bucket);
  if (Number.isNaN(d.getTime())) return bucket;
  switch (interval) {
    case 'day': return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    case 'week': return `W/c ${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`;
    case 'month': return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    case 'quarter': return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
    case 'year': return String(d.getFullYear());
    default: return bucket;
  }
}

// ---------------------------------------------------------------------------

async function runFunnel(ctx: ScopeContext, config: WidgetConfig, conn: Tx): Promise<WidgetResult> {
  if (!config.module || !config.groupBy) throw new BadRequestError('funnel widget needs module and groupBy');
  const grouped = await runGrouped(ctx, { ...config, limit: 100 }, conn, 'funnel');
  const byKey = new Map((grouped.series ?? []).map((s) => [s.key, s]));

  const module = await registry.requireModule(config.module);
  const field = module.fields.find((f) => f.name === config.groupBy);
  const order = config.stages ?? field?.options?.map((o) => o.value) ?? (grouped.series ?? []).map((s) => s.key);

  // A funnel counts everything that reached a stage *or later*, otherwise the
  // "conversion" numbers are nonsense once records move on.
  const cumulative = order.map((key, i) => {
    const reached = order.slice(i).reduce((sum, k) => sum + (byKey.get(k)?.value ?? 0), 0);
    return { key, reached };
  });

  const first = cumulative[0]?.reached ?? 0;
  const stages = cumulative.map((s, i) => {
    const prev = i === 0 ? s.reached : cumulative[i - 1].reached;
    return {
      key: s.key,
      label: field?.options?.find((o) => o.value === s.key)?.label ?? s.key,
      value: s.reached,
      conversionFromPrevious: prev === 0 ? 0 : Math.round((s.reached / prev) * 1000) / 10,
      conversionFromFirst: first === 0 ? 0 : Math.round((s.reached / first) * 1000) / 10,
    };
  });

  return { type: 'funnel', stages, total: first };
}

// ---------------------------------------------------------------------------

async function runTable(ctx: ScopeContext, config: WidgetConfig, conn: Tx, type: string): Promise<WidgetResult> {
  if (!config.module) throw new BadRequestError('table widget needs a module');
  const { listRecords } = await import('../entity/recordService.js');
  const result = await listRecords(
    { ...ctx, source: 'widget' },
    config.module,
    {
      filter: config.filter,
      view: config.view,
      sortBy: config.sortBy,
      sortDir: config.sortDir,
      pageSize: config.limit ?? 10,
      page: 1,
      columns: config.columns,
    },
    { conn },
  );

  const columns = config.columns ?? [];
  const rows = result.rows.map((r) => ({
    id: r.id,
    module: r.module,
    label: r.label,
    recordNumber: r.recordNumber,
    ...Object.fromEntries(columns.map((c) => [c, r.values[c]])),
    __display: r.display,
  }));

  return { type, rows, columns, total: result.total };
}

// ---------------------------------------------------------------------------

/** Grouped counts split by a second dimension — inventory by project × status. */
async function runStacked(ctx: ScopeContext, config: WidgetConfig, conn: Tx): Promise<WidgetResult> {
  const stackBy = (config.stackBy as string) ?? 'status';
  if (!config.module || !config.groupBy) throw new BadRequestError('stacked widget needs module and groupBy');

  const module = await registry.requireModule(config.module);
  const joins = new Map<string, string>();
  const groupField = await resolveFieldPath(module, config.groupBy, joins);
  const stackField = await resolveFieldPath(module, stackBy, joins);
  const { from, where, params } = await baseQuery(ctx, config.module, config.filter, joins);

  const res = await conn.query<{ gkey: string | null; skey: string | null; value: number }>(
    `SELECT ${groupField.expr}::text AS gkey, ${stackField.expr}::text AS skey, COUNT(*)::numeric AS value
     ${from} ${where}
     GROUP BY 1, 2`,
    params.all(),
  );

  const groupLabels = await resolveGroupLabels(conn, groupField, [...new Set(res.rows.map((r) => r.gkey))]);
  const stackOptions = stackField.field?.options ?? [];
  const stackLabel = new Map(stackOptions.map((o) => [o.value, o]));

  const byGroup = new Map<string, { key: string; label: string; segments: { key: string; label: string; value: number; color?: string | null }[] }>();
  for (const row of res.rows) {
    const gkey = row.gkey ?? '';
    if (!byGroup.has(gkey)) {
      byGroup.set(gkey, { key: gkey, label: groupLabels.get(gkey)?.label ?? (gkey || '(none)'), segments: [] });
    }
    const skey = row.skey ?? '';
    byGroup.get(gkey)!.segments.push({
      key: skey,
      label: stackLabel.get(skey)?.label ?? (skey || '(none)'),
      value: Number(row.value),
      color: stackLabel.get(skey)?.color ?? null,
    });
  }

  const stacked = [...byGroup.values()]
    .sort((a, b) =>
      b.segments.reduce((s, x) => s + x.value, 0) - a.segments.reduce((s, x) => s + x.value, 0))
    .slice(0, config.limit ?? 10);

  return { type: 'inventory_status', stacked };
}

// ---------------------------------------------------------------------------

/** Weighted pipeline: sum(amount × probability) bucketed by expected close month. */
async function runForecast(ctx: ScopeContext, config: WidgetConfig, conn: Tx): Promise<WidgetResult> {
  const moduleName = config.module ?? 'deals';
  const module = await registry.requireModule(moduleName);
  const amountField = module.fields.find((f) => f.name === (config.aggregateField ?? 'amount'));
  const probField = module.fields.find((f) => f.name === 'probability');
  const closeField = module.fields.find((f) => f.name === (config.dateField ?? 'expected_close_date'));
  if (!amountField || !closeField) throw new BadRequestError('forecast widget needs amount and close date fields');

  const joins = new Map<string, string>();
  const { from, where, params } = await baseQuery(ctx, moduleName, config.filter, joins);
  const tzParam = params.add(ctx.user.timezone || 'Asia/Kolkata');
  const weighted = probField
    ? `SUM(${fieldExpr(amountField)} * COALESCE(${fieldExpr(probField)},0) / 100.0)`
    : `SUM(${fieldExpr(amountField)})`;

  const res = await conn.query<{ bucket: string; weighted: number; gross: number; deals: number }>(
    `SELECT date_trunc('month', (${fieldExpr(closeField)})::timestamptz AT TIME ZONE ${tzParam})::date::text AS bucket,
            COALESCE(${weighted},0)::numeric AS weighted,
            COALESCE(SUM(${fieldExpr(amountField)}),0)::numeric AS gross,
            COUNT(*)::int AS deals
     ${from} ${where} AND ${fieldExpr(closeField)} IS NOT NULL
     GROUP BY 1 ORDER BY 1 ASC LIMIT 12`,
    params.all(),
  );

  return {
    type: 'pipeline_forecast',
    series: res.rows.map((r) => ({
      key: r.bucket,
      label: formatBucket(r.bucket, 'month'),
      value: Math.round(Number(r.weighted)),
      secondary: Math.round(Number(r.gross)),
    })),
    format: 'currency',
    meta: { note: 'Value is probability-weighted; secondary is gross pipeline.' },
  };
}

// ---------------------------------------------------------------------------

/** Day-of-week × hour density — used for "best time to call". */
async function runHeatmap(ctx: ScopeContext, config: WidgetConfig, conn: Tx): Promise<WidgetResult> {
  if (!config.module) throw new BadRequestError('heatmap widget needs a module');
  const module = await registry.requireModule(config.module);
  const dateFieldName = config.dateField ?? 'created_at';
  const joins = new Map<string, string>();
  const dateResolved = await resolveFieldPath(module, dateFieldName, joins);
  const { from, where, params } = await baseQuery(ctx, config.module, config.filter, joins);
  const tzParam = params.add(ctx.user.timezone || 'Asia/Kolkata');

  const res = await conn.query<{ dow: number; hour: number; value: number }>(
    `SELECT EXTRACT(DOW FROM (${dateResolved.expr}) AT TIME ZONE ${tzParam})::int AS dow,
            EXTRACT(HOUR FROM (${dateResolved.expr}) AT TIME ZONE ${tzParam})::int AS hour,
            COUNT(*)::numeric AS value
     ${from} ${where} AND ${dateResolved.expr} IS NOT NULL
     GROUP BY 1,2`,
    params.all(),
  );

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    type: 'heatmap',
    series: res.rows.map((r) => ({
      key: `${r.dow}-${r.hour}`,
      label: `${days[r.dow]} ${String(r.hour).padStart(2, '0')}:00`,
      value: Number(r.value),
    })),
    meta: { dimensions: ['dayOfWeek', 'hour'] },
  };
}

// ---------------------------------------------------------------------------
// Report runner (tabular / summary / matrix) reuses the same primitives.
// ---------------------------------------------------------------------------

export interface ReportSpec {
  module: string;
  type: 'tabular' | 'summary' | 'matrix' | 'chart';
  columns: string[];
  groupBy: string[];
  aggregates: { field: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; label?: string }[];
  filter?: WidgetConfig['filter'];
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
}

export async function runReport(ctx: ScopeContext, spec: ReportSpec, conn: Tx = db): Promise<{
  rows: Record<string, unknown>[];
  columns: string[];
  totals?: Record<string, number>;
}> {
  const module = await registry.requireModule(spec.module);

  if (spec.type === 'tabular') {
    const { listRecords } = await import('../entity/recordService.js');
    const res = await listRecords(
      { ...ctx, source: 'report' },
      spec.module,
      { filter: spec.filter, sortBy: spec.sortBy, sortDir: spec.sortDir, pageSize: Math.min(spec.limit ?? 1000, 5000), page: 1 },
      { conn },
    );
    return {
      columns: spec.columns,
      rows: res.rows.map((r) => ({
        id: r.id,
        ...Object.fromEntries(spec.columns.map((c) => [c, r.display?.[c] ?? r.values[c]])),
      })),
    };
  }

  // summary / matrix: GROUP BY the requested dimensions with the aggregates.
  const joins = new Map<string, string>();
  const groupExprs: string[] = [];
  for (const g of spec.groupBy) {
    const resolved = await resolveFieldPath(module, g, joins);
    groupExprs.push(`${resolved.expr}::text`);
  }
  const { from, where, params } = await baseQuery(ctx, spec.module, spec.filter, joins);

  const aggSelects = spec.aggregates.map((a, i) => {
    const f = module.fields.find((x) => x.name === a.field);
    return `${aggregateExpr(a.fn, f ? fieldExpr(f) : null)} AS agg_${i}`;
  });

  const selectParts = [
    ...groupExprs.map((e, i) => `${e} AS grp_${i}`),
    ...(aggSelects.length ? aggSelects : ['COUNT(*)::numeric AS agg_0']),
  ];

  const res = await conn.query<Record<string, unknown>>(
    `SELECT ${selectParts.join(', ')}
     ${from} ${where}
     ${groupExprs.length ? `GROUP BY ${groupExprs.map((_, i) => i + 1).join(', ')}` : ''}
     ORDER BY ${groupExprs.length ? '1 ASC' : '1 DESC'}
     LIMIT ${params.add(spec.limit ?? 1000)}`,
    params.all(),
  );

  const columns = [
    ...spec.groupBy,
    ...spec.aggregates.map((a) => a.label ?? `${a.fn}(${a.field})`),
  ];

  const rows = res.rows.map((r) => {
    const out: Record<string, unknown> = {};
    spec.groupBy.forEach((g, i) => { out[g] = r[`grp_${i}`]; });
    spec.aggregates.forEach((a, i) => { out[a.label ?? `${a.fn}(${a.field})`] = Number(r[`agg_${i}`] ?? 0); });
    if (!spec.aggregates.length) out.count = Number(r.agg_0 ?? 0);
    return out;
  });

  const totals: Record<string, number> = {};
  for (const a of spec.aggregates) {
    const key = a.label ?? `${a.fn}(${a.field})`;
    if (a.fn === 'sum' || a.fn === 'count') {
      totals[key] = rows.reduce((sum, r) => sum + Number(r[key] ?? 0), 0);
    }
  }

  return { rows, columns, totals };
}
