/**
 * Remove one dropdown option and leave the field blank on every record that held it.
 *
 * The same steps as `DELETE /api/meta/picklists/:name/values?clear=true` (the admin's own
 * "delete this option"): records are cleared through `replaceValueInRecords`, the option is
 * deleted, and a tombstone keeps the seed from putting it back. Nothing else is touched.
 *
 *   DATABASE_URL='postgresql://…' npm run picklists:remove -- lost_reason "Plan Postponed"          # look only
 *   DATABASE_URL='postgresql://…' npm run picklists:remove -- lost_reason "Plan Postponed" --apply  # write
 *
 * One transaction, so a failure leaves the database exactly as it was. The running server keeps the
 * dropdown list in memory, so it needs a restart (a deploy does it) before the option leaves the screen.
 */
import { db, pool, transaction } from '../db/pool.js';
import {
  countRecordsWithValue, fieldsThatCannotBeCleared, fieldsUsingPicklist, matchExpr, replaceValueInRecords,
} from '../core/metadata/picklists.js';

async function main(): Promise<void> {
  const [name, value] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const apply = process.argv.includes('--apply');
  if (!name || !value) throw new Error('Usage: removePicklistValue <picklist> "<value>" [--apply]');

  const picklist = await db.queryOne<{ id: string }>(`SELECT id FROM ipy_picklist WHERE name = $1`, [name]);
  if (!picklist) throw new Error(`Unknown picklist '${name}'`);
  const option = await db.queryOne(`SELECT 1 FROM ipy_picklist_value WHERE picklist_id = $1 AND value = $2`, [picklist.id, value]);

  const usage = await countRecordsWithValue(name, value);
  console.log(`option exists: ${Boolean(option)}`);
  console.log(`records holding "${value}": ${usage.total}`);
  for (const row of usage.byField) console.log(`  ${row.module} → ${row.field}: ${row.count}`);

  const blocked = usage.total > 0 ? await fieldsThatCannotBeCleared(name) : [];
  if (blocked.length) throw new Error(`These fields cannot be left empty: ${blocked.map((b) => `${b.moduleLabel} → ${b.fieldLabel}`).join(', ')}`);
  if (!apply) { console.log('looked only. Add --apply to write.'); return; }

  await transaction(async (tx) => {
    // Which records had it, kept so this can be undone: a cleared value is otherwise gone for good.
    await tx.query(`CREATE TABLE IF NOT EXISTS ipy_cleared_picklist_value (
      picklist TEXT NOT NULL, value TEXT NOT NULL, module TEXT NOT NULL, field TEXT NOT NULL,
      record_id UUID NOT NULL, cleared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (picklist, value, field, record_id))`);
    for (const use of await fieldsUsingPicklist(name)) {
      await tx.query(
        `INSERT INTO ipy_cleared_picklist_value (picklist, value, module, field, record_id)
         SELECT $2, $1, $3, $4, record_id FROM ${use.tableName.replace(/[^A-Za-z0-9_]/g, '')} WHERE ${matchExpr(use)}
         ON CONFLICT DO NOTHING`,
        [value, name, use.module, use.field],
      );
    }
    if (usage.total > 0) await replaceValueInRecords(name, value, null, tx);
    await tx.query(`DELETE FROM ipy_picklist_value WHERE picklist_id = $1 AND value = $2`, [picklist.id, value]);
    await tx.query(
      `INSERT INTO ipy_picklist_tombstone (picklist_name, value, had_records, replaced_with)
       VALUES ($1,$2,$3,NULL)
       ON CONFLICT (picklist_name, value) DO UPDATE SET deleted_at = now(), had_records = EXCLUDED.had_records, replaced_with = NULL`,
      [name, value, usage.total],
    );
  });
  const after = await countRecordsWithValue(name, value);
  console.log(`done. records still holding it: ${after.total}`);
}

main().then(() => pool.end()).catch(async (err) => { console.error(err.message ?? err); await pool.end(); process.exit(1); });
