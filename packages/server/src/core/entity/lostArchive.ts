import { isLostStatus, picklistOptionForValue, statusFieldOf, type ModuleMeta } from '@ipropy/shared';
import { transaction, type Tx } from '../../db/pool.js';
import { registry } from '../metadata/registry.js';
import { quoteIdent } from '../query/builder.js';
import { broadcastModuleChange } from '../../realtime.js';

export function hasLostStage(module: ModuleMeta, values: Record<string, unknown>): boolean {
  const field = statusFieldOf(module.fields);
  if (!field || !field.isActive) return false;
  const value = values[field.name];
  return isLostStatus(value) || isLostStatus(picklistOptionForValue(field.options, value)?.label);
}

/** Same transaction/row lock as the status save, so changing back cancels safely. */
export async function updateLostArchiveDue(conn: Tx, module: ModuleMeta, id: string,
  before: Record<string, unknown> | null, after: Record<string, unknown>): Promise<void> {
  const wasLost = before !== null && hasLostStage(module, before);
  const lost = hasLostStage(module, after);
  if (lost && !wasLost) {
    await conn.query('UPDATE ipy_record SET lost_archive_due_at = now() + interval \'12 hours\' WHERE id = $1', [id]);
  } else if (!lost) {
    await conn.query('UPDATE ipy_record SET lost_archive_due_at = NULL, archived_at = NULL WHERE id = $1', [id]);
  }
}

/** Idempotent across workers. Direct communication keeps the usual record permissions. */
export async function archiveDueLostRecords(): Promise<number> {
  // Existing Lost records get a full grace period when this feature is enabled.
  for (const module of await registry.getModules({ activeOnly: true, entityOnly: true })) {
    const status = statusFieldOf(module.fields);
    if (!status || !status.isActive) continue;
    const lost = status.options?.filter(option => isLostStatus(option.value) || isLostStatus(option.label)).map(option => option.value) ?? [];
    if (!lost.length) continue;
    await transaction(conn => conn.query(`UPDATE ipy_record r SET lost_archive_due_at=now()+interval '12 hours'
      FROM ${quoteIdent(module.tableName)} e WHERE e.record_id=r.id AND r.module_id=$1
      AND r.is_deleted=false AND r.archived_at IS NULL AND r.lost_archive_due_at IS NULL
      AND e.${quoteIdent(status.columnName)}::text = ANY($2::text[])`, [module.id, lost]));
  }
  const changed = new Set<string>();
  const count = await transaction(async conn => {
    const due = await conn.query<{ id: string; module_name: string }>(
      `SELECT id, module_name FROM ipy_record WHERE is_deleted = false AND archived_at IS NULL
       AND lost_archive_due_at <= now() ORDER BY lost_archive_due_at LIMIT 200 FOR UPDATE SKIP LOCKED`);
    let count = 0;
    for (const row of due.rows) {
      const module = await registry.requireModule(row.module_name);
      const status = statusFieldOf(module.fields);
      if (!status) continue;
      const values = await conn.queryOne<Record<string, unknown>>(
        `SELECT ${quoteIdent(status.columnName)} AS status FROM ${quoteIdent(module.tableName)} WHERE record_id=$1`, [row.id]);
      if (!hasLostStage(module, { [status.name]: values?.status })) {
        await conn.query('UPDATE ipy_record SET lost_archive_due_at=NULL WHERE id=$1', [row.id]);
        continue;
      }
      await conn.query('UPDATE ipy_record SET archived_at=now(), lost_archive_due_at=NULL WHERE id=$1', [row.id]);
      await conn.query(`INSERT INTO ipy_audit(record_id,module_name,user_id,action,changes,source)
        VALUES($1,$2,NULL,'archive',$3,'lost-archive')`, [row.id, module.name,
        JSON.stringify([{ field: 'archived_at', label: 'Archive', from: null, to: 'Archived after 12 hours in Lost' }])]);
      count++;
      changed.add(module.name);
    }
    return count;
  });
  for (const module of changed) broadcastModuleChange(module);
  return count;
}
