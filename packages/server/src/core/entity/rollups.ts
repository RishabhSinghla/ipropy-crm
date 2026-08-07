/**
 * Rollup aggregation engine for `uitype: 'rollup'` fields.
 *
 * A rollup field derives its value from the records hanging off a related list
 * (e.g. a project's available units = COUNT of properties where status is
 * "Available"). Values are computed on read, not stored, so they can never go
 * stale when the related records change independently.
 *
 * Config shape: { relation, aggregate, field?, filter? } — see uitypes.ts.
 */
import type { ModuleMeta } from '@ipropy/shared';
import { logger } from '../../utils/logger.js';
import { registry } from '../metadata/registry.js';
import {
  ENTITY_ALIAS,
  RECORD_ALIAS,
  SqlParams,
  buildWhere,
  fieldExpr,
  quoteIdent,
  type BuildContext,
} from '../query/builder.js';
import type { Tx } from '../../db/pool.js';

/**
 * Compute every active rollup field on `module` for a batch of source records
 * in a single query per field. Returns sourceId -> fieldName -> value.
 */
export async function computeRollups(
  conn: Tx,
  module: ModuleMeta,
  sourceIds: string[],
  ctx: BuildContext,
): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  if (!sourceIds.length) return result;
  const rollupFields = module.fields.filter(
    (f) => f.isActive && f.uitype === 'rollup' && f.config.rollup,
  );
  if (!rollupFields.length) return result;

  for (const field of rollupFields) {
    const cfg = field.config.rollup!;
    const relation = await registry.getRelation(module.name, cfg.relation);
    if (!relation) continue;
    const target = await registry.requireModule(relation.targetModule);

    const params = new SqlParams();
    const joins: string[] = [];
    const conds: string[] = [];
    let groupExpr: string;

    if (relation.type === 'many_to_many') {
      // Target rows reachable through the generic link table.
      groupExpr = 'l.source_id';
      joins.push(`JOIN ipy_record_link l ON l.target_id = ${RECORD_ALIAS}.id`);
      conds.push(`l.relation_id = ${params.add(relation.id)}::uuid`);
      conds.push(`l.source_id = ANY(${params.add(sourceIds)}::uuid[])`);
    } else {
      // one_to_many: the target row's lookup field points back at the source.
      const foreignField = relation.foreignField
        ? target.fields.find((f) => f.name === relation.foreignField)
        : undefined;
      if (!foreignField) continue;
      groupExpr = fieldExpr(foreignField);
      conds.push(`${groupExpr} = ANY(${params.add(sourceIds)}::uuid[])`);
    }
    conds.push(`${RECORD_ALIAS}.is_deleted = false`);

    if (cfg.filter) {
      const where = await buildWhere(target, cfg.filter, params, ctx);
      if (where.sql) conds.push(where.sql);
      joins.push(...where.joins);
    }

    let selectExpr: string;
    if (cfg.aggregate === 'count') {
      selectExpr = 'COUNT(*)::int';
    } else {
      const aggField = cfg.field ? target.fields.find((f) => f.name === cfg.field) : undefined;
      if (!aggField) continue;
      selectExpr = `COALESCE(${cfg.aggregate.toUpperCase()}(${fieldExpr(aggField)}), 0)`;
    }

    const sql = `SELECT ${groupExpr}::uuid AS source_id, ${selectExpr} AS v
      FROM ipy_record ${RECORD_ALIAS}
      JOIN ${quoteIdent(target.tableName)} ${ENTITY_ALIAS} ON ${ENTITY_ALIAS}.record_id = ${RECORD_ALIAS}.id
      ${joins.join('\n')}
      WHERE ${conds.join(' AND ')}
      GROUP BY 1`;

    let res: { rows: { source_id: string; v: string | number | null }[] };
    try {
      res = await conn.query<{ source_id: string; v: string | number | null }>(sql, params.all());
    } catch (err) {
      // A broken rollup must never take down the record read path.
      logger.warn({ err, module: module.name, field: field.name }, 'rollup query failed');
      continue;
    }
    for (const row of res.rows) {
      const per = result.get(row.source_id) ?? new Map<string, number>();
      per.set(field.name, Number(row.v ?? 0));
      result.set(row.source_id, per);
    }
  }

  return result;
}
