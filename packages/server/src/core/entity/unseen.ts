/**
 * "New since you last looked" — the CRM's equivalent of an unread email.
 *
 * Gmail-style for every module, leads included: a record is bold while it was
 * created after the user's module watermark and the user has never opened it.
 * Opening the record (any GET of its detail writes `ipy_recent_view`) clears
 * the highlight, the same as reading an email clears its bold.
 *
 * Deliberately *not* part of listRecords. The list engine is shared by exports,
 * widgets and the portal, none of which have a "who is reading this"
 * notion, and threading a per-user join through it would put a correlated
 * subquery on every one of those paths.
 */
import { db, type Tx } from '../../db/pool.js';
import { registry } from '../metadata/registry.js';
import { recordScopeSql, type ScopeContext } from '../permissions/index.js';
import { SqlParams } from '../query/builder.js';

/**
 * Which of `ids` this user has not seen yet.
 *
 * Takes ids rather than a filter so it can piggyback on whatever the list view
 * already fetched — the caller has by definition already passed permission
 * checks to obtain them.
 */
export async function filterUnseen(
  userId: string,
  moduleName: string,
  ids: string[],
  conn: Tx = db,
): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await conn.query<{ id: string }>(
    `SELECT r.id
     FROM ipy_record r
     JOIN ipy_user u ON u.id = $1
     LEFT JOIN ipy_module_seen ms ON ms.user_id = $1 AND ms.module_name = $3
     WHERE r.id = ANY($2::uuid[])
       AND r.is_deleted = false
       AND r.module_name = $3
       AND r.created_at > COALESCE(ms.seen_at, u.created_at)
       AND NOT EXISTS (
         SELECT 1 FROM ipy_recent_view rv WHERE rv.user_id = $1 AND rv.record_id = r.id
       )`,
    [userId, ids, moduleName],
  );
  return rows.rows.map((r) => r.id);
}

/**
 * Unseen counts per module for the sidebar badges.
 *
 * Scoped through recordScopeSql, so a salesperson's badge counts only the
 * records they can actually open — a count that includes invisible records is
 * a permission leak dressed up as a number, and sends people hunting for rows
 * that are not there.
 */
export async function unseenCounts(ctx: ScopeContext, conn: Tx = db): Promise<Record<string, number>> {
  const modules = await registry.getModules({ entityOnly: true });
  const counts: Record<string, number> = {};

  for (const module of modules) {
    const params = new SqlParams();
    const userParam = params.add(ctx.user.id);
    const moduleParam = params.add(module.id);
    const nameParam = params.add(module.name);

    const clauses = [
      `r.module_id = ${moduleParam}::uuid`,
      `r.is_deleted = false`,
      `r.created_at > COALESCE(ms.seen_at, u.created_at)`,
      `NOT EXISTS (SELECT 1 FROM ipy_recent_view rv WHERE rv.user_id = ${userParam} AND rv.record_id = r.id)`,
    ];

    // recordScopeSql writes predicates against the `r` alias, which is why the
    // aliases here have to match the ones the analytics queries use.
    const scope = await recordScopeSql(ctx, module.name, params);
    if (scope) clauses.push(scope);

    const row = await conn.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM ipy_record r
       JOIN ipy_user u ON u.id = ${userParam}
       LEFT JOIN ipy_module_seen ms ON ms.user_id = ${userParam} AND ms.module_name = ${nameParam}
       WHERE ${clauses.join(' AND ')}`,
      params.all(),
    ).catch(() => null);

    if (row?.count) counts[module.name] = row.count;
  }

  return counts;
}

/** Move the watermark to now — "mark everything in this module as seen". */
export async function markModuleSeen(userId: string, moduleName: string, conn: Tx = db): Promise<void> {
  await conn.query(
    `INSERT INTO ipy_module_seen (user_id, module_name, seen_at) VALUES ($1,$2,now())
     ON CONFLICT (user_id, module_name) DO UPDATE SET seen_at = now()`,
    [userId, moduleName],
  );
}
