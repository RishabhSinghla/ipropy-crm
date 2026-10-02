/**
 * How many records each module holds, for the left toolbar.
 *
 * **2 October 2026, the owner:** *"all icon have their names also with record
 * counts and the unread feature disables from all modules's toolbar."* The
 * dock used to carry "not opened yet" badges; it carries the module's own size
 * now, which is the number a rep actually recognises.
 *
 * **Scoped, like everything else.** The count runs through `recordScopeSql`,
 * so a rep sees how many records *they* can open rather than how many the
 * business has. A toolbar that says 22,988 to somebody who may open 300 is a
 * number that teaches people to ignore the toolbar.
 */
import { db, type Tx } from '../../db/pool.js';
import { SqlParams } from '../query/builder.js';
import { registry } from '../metadata/registry.js';
import { recordScopeSql, type ScopeContext } from '../permissions/index.js';

export async function recordCounts(ctx: ScopeContext, conn: Tx = db): Promise<Record<string, number>> {
  const modules = await registry.getModules({ entityOnly: true });
  const counts: Record<string, number> = {};

  for (const module of modules) {
    const params = new SqlParams();
    const moduleParam = params.add(module.id);
    const clauses = [`r.module_id = ${moduleParam}::uuid`, 'r.is_deleted = false'];

    // `recordScopeSql` writes its predicates against the `r` alias, which is
    // why the alias here has to be `r` — the same contract `unseenCounts` and
    // the analytics queries hold to.
    const scope = await recordScopeSql(ctx, module.name, params);
    if (scope) clauses.push(scope);

    /*
      A module whose count fails is left out rather than failing the toolbar.
      This runs on every page; one bad module must not take the navigation
      down with it.
    */
    const row = await conn.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ipy_record r WHERE ${clauses.join(' AND ')}`,
      params.all(),
    ).catch(() => null);

    if (row) counts[module.name] = row.count;
  }

  return counts;
}
