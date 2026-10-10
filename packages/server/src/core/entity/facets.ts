/**
 * What a quick filter needs to draw itself: a field's most common values, and
 * the lowest and highest number it holds.
 *
 * Both are answered by the reporting engine (`runWidget`), not by a query of
 * their own — the same permission-scoped SQL a dashboard tile runs — so a rep
 * is only ever counted the records they are allowed to see, and a field their
 * profile hides is refused rather than summarised.
 */
import type { FilterGroup, ListQuery } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { prepareList } from './recordService.js';
import { runWidget } from '../analytics/widgets.js';
import { registry } from '../metadata/registry.js';
import { isSystemField } from '../query/builder.js';
import { getFieldPermissions, type ScopeContext } from '../permissions/index.js';
import { BadRequestError, ForbiddenError } from '../../utils/errors.js';

export interface FacetValue {
  value: string;
  label: string;
  count: number;
  color: string | null;
}

/** The field, provided this person may read it. */
async function readableField(ctx: ScopeContext, moduleName: string, fieldName: string): Promise<void> {
  const module = await registry.requireModule(moduleName);
  const field = module.fields.find((candidate) => candidate.name === fieldName);
  // The record-level ideas every module has — who it is assigned to, how the
  // last call went — are counted too; no profile hides them.
  if (!field && isSystemField(fieldName)) return;
  if (!field) throw new BadRequestError(`${moduleName} has no field called ${fieldName}`);
  if (!ctx.user.isAdmin) {
    const permissions = await getFieldPermissions(ctx.user, moduleName);
    if (permissions.get(fieldName) === 'hidden') throw new ForbiddenError('That field is hidden from you');
  }
}

/**
 * The most common values of one field, most common first.
 *
 * `search` narrows to values containing the words typed — the way into a
 * field with a thousand localities, where only the top five are listed.
 * `blank` is how many records hold no value at all — "Never called", for the
 * call outcome.
 */
export async function fieldFacets(
  ctx: ScopeContext,
  moduleName: string,
  fieldName: string,
  options: { search?: string; limit?: number; context?: ListQuery } = {},
  conn: Tx = db,
): Promise<{ values: FacetValue[]; blank: number }> {
  if (fieldName === 'record_tags') {
    const { from, params } = await prepareList(ctx, moduleName, options.context ?? {}, conn);
    // One scoped snapshot, including untagged records. A tag can be on many
    // records, and a record can have many tags; blank is NOT total minus links.
    const result = await conn.queryOne<{ values: FacetValue[]; blank: number }>(
      `WITH visible AS MATERIALIZED (SELECT r.id ${from}),
       tagged AS (
         SELECT t.name AS value, t.name AS label, t.color,
                count(DISTINCT v.id)::int AS count
         FROM visible v JOIN ipy_tag_link l ON l.record_id=v.id JOIN ipy_tag t ON t.id=l.tag_id
         GROUP BY t.id
       )
       SELECT COALESCE((SELECT jsonb_agg(tagged ORDER BY count DESC, label) FROM tagged), '[]'::jsonb) AS values,
       (SELECT count(*)::int FROM visible v WHERE NOT EXISTS
         (SELECT 1 FROM ipy_tag_link l WHERE l.record_id=v.id)) AS blank`, params.all());
    return result ?? { values: [], blank: 0 };
  }
  await readableField(ctx, moduleName, fieldName);
  const search = options.search?.trim();
  const valueFilter: FilterGroup | undefined = search
    ? { logic: 'AND', conditions: [{ field: fieldName, operator: 'contains', value: search }] }
    : undefined;
  const scope = options.context ? await prepareList(ctx, moduleName, options.context, conn) : undefined;
  const filters = [scope?.effectiveFilter, valueFilter].filter((item): item is FilterGroup => Boolean(item));
  const filter: FilterGroup | undefined = filters.length ? { logic: 'AND', conditions: filters } : undefined;
  const result = await runWidget(ctx, 'bar', {
    module: moduleName,
    groupBy: fieldName,
    aggregate: 'count',
    limit: Math.min(Math.max(options.limit ?? 5, 1), 50),
    filter,
    search: options.context?.search,
  }, conn);
  const series = result.series ?? [];
  return {
    values: series
      .filter((row) => row.key !== '')
      .map((row) => ({ value: row.key, label: row.label, count: row.value, color: row.color ?? null })),
    blank: series.find((row) => row.key === '')?.value ?? 0,
  };
}

/** The lowest and highest value a number field holds — the ends of its slider. */
export async function fieldRange(
  ctx: ScopeContext,
  moduleName: string,
  fieldName: string,
): Promise<{ min: number | null; max: number | null }> {
  await readableField(ctx, moduleName, fieldName);
  const [low, high] = await Promise.all([
    runWidget(ctx, 'metric', { module: moduleName, aggregate: 'min', aggregateField: fieldName }),
    runWidget(ctx, 'metric', { module: moduleName, aggregate: 'max', aggregateField: fieldName }),
  ]);
  const min = low.value ?? null;
  const max = high.value ?? null;
  // No records with a value reads as 0 from an aggregate over nothing.
  return min === 0 && max === 0 ? { min: null, max: null } : { min, max };
}
