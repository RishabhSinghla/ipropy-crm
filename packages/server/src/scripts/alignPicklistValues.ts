/**
 * Make every dropdown option store the words the admin typed.
 *
 * A dropdown option has two halves: the **label** shown on screen and the
 * **value** written on every record that chose it. They are allowed to differ,
 * and on this database they have come badly apart — Lead Status shows "Lead
 * Won" on records storing `Contacted`, and "Contacted" on records storing
 * `Converted`. Everywhere the raw value surfaces (the timeline, an export, a
 * workflow condition an admin reads back) it says something other than what the
 * screen says, which is indistinguishable from the CRM having got it wrong.
 *
 * This aligns the two: for every option whose value is not its label, the value
 * is renamed to the label, and every record, saved view, dashboard widget and
 * workflow that names the old value is rewritten with it — through
 * `replaceValueInRecords`, the same path the dropdown editor uses for a rename,
 * so nothing here re-implements the hard half.
 *
 *   DATABASE_URL='postgresql://…' npm run picklists:align            # dry run
 *   DATABASE_URL='postgresql://…' npm run picklists:align -- --apply # write
 *
 * **Two phases, because the renames collide.** `Converted` wants to become
 * "Contacted" while `Contacted` is still taken by the option that wants to
 * become "Lead Won"; a unique index on (picklist, value) refuses that, and any
 * single ordering can be defeated by a cycle. So every affected option is first
 * moved to a scratch value nothing else can hold, then to its final one.
 *
 * One transaction, so a failure anywhere leaves the database exactly as it was.
 *
 * What it deliberately does not touch: `ipy_audit`. Those rows are the record of
 * what happened at the time, and a note saying a status changed to `Converted`
 * was true when it was written. Old timeline entries therefore keep the old
 * wording; everything from here on reads correctly.
 */
import { db, pool, transaction, type Tx } from '../db/pool.js';
import { replaceValueInRecords } from '../core/metadata/picklists.js';
import { logger } from '../utils/logger.js';

interface Drifted {
  picklist: string;
  id: string;
  from: string;
  to: string;
}

/** Every option whose stored value is not the label sitting on top of it. */
async function findDrift(conn: Tx): Promise<Drifted[]> {
  const rows = await conn.query<{ id: string; picklist: string; value: string; label: string }>(`
    SELECT v.id, p.name AS picklist, v.value, v.label
      FROM ipy_picklist_value v
      JOIN ipy_picklist p ON p.id = v.picklist_id
     WHERE v.value IS DISTINCT FROM v.label
     ORDER BY p.name, v.sequence
  `);
  return rows.rows.map((r) => ({ picklist: r.picklist, id: r.id, from: r.value, to: r.label }));
}

/**
 * A target that two options both want is a rename this cannot make safely.
 *
 * It happens when an admin has typed the same label twice, or when a label
 * collides with a value that is staying put. Renaming either one would merge two
 * distinct answers into a single value on the records that chose them — data
 * lost quietly, which is worse than the confusion being fixed.
 */
async function findConflicts(conn: Tx, drift: Drifted[]): Promise<string[]> {
  const problems: string[] = [];
  const byList = new Map<string, Drifted[]>();
  for (const d of drift) byList.set(d.picklist, [...(byList.get(d.picklist) ?? []), d]);

  for (const [picklist, items] of byList) {
    const seen = new Map<string, string>();
    for (const item of items) {
      const clash = seen.get(item.to);
      if (clash) problems.push(`${picklist}: "${clash}" and "${item.from}" both want to become "${item.to}"`);
      seen.set(item.to, item.from);
    }

    // A label that matches a value not moving is the same collision, one step
    // removed: the option keeping that value would be overwritten.
    const staying = await conn.query<{ value: string }>(
      `SELECT v.value FROM ipy_picklist_value v JOIN ipy_picklist p ON p.id = v.picklist_id
        WHERE p.name = $1 AND v.value = v.label`,
      [picklist],
    );
    const fixed = new Set(staying.rows.map((r) => r.value));
    for (const item of items) {
      if (fixed.has(item.to)) problems.push(`${picklist}: "${item.from}" wants "${item.to}", which another option already stores and is not moving`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const drift = await findDrift(db);
  if (!drift.length) {
    logger.info('every dropdown option already stores its own label — nothing to do');
      return;
  }

  logger.info(`${drift.length} option(s) store something other than their label:`);
  for (const d of drift) logger.info(`  ${d.picklist}: "${d.from}" → "${d.to}"`);

  const conflicts = await findConflicts(db, drift);
  if (conflicts.length) {
    logger.error('refusing to run — these would merge two answers into one:');
    for (const c of conflicts) logger.error(`  ${c}`);
    process.exitCode = 1;
      return;
  }

  if (!apply) {
    logger.info('dry run — nothing written. Re-run with --apply to make the change.');
      return;
  }

  const totals = await transaction(async (tx) => {
    let records = 0;
    let filters = 0;

    // Phase one: out of the way. The scratch value carries the option's own id,
    // so it cannot collide with anything, including another scratch value.
    for (const d of drift) {
      const scratch = `__align_${d.id}`;
      const moved = await replaceValueInRecords(d.picklist, d.from, scratch, tx);
      records += moved.records;
      filters += moved.filters;
      await tx.query(`UPDATE ipy_picklist_value SET value = $2 WHERE id = $1`, [d.id, scratch]);
    }

    // Phase two: into place.
    for (const d of drift) {
      const scratch = `__align_${d.id}`;
      const moved = await replaceValueInRecords(d.picklist, scratch, d.to, tx);
      records += moved.records;
      filters += moved.filters;
      await tx.query(`UPDATE ipy_picklist_value SET value = $2 WHERE id = $1`, [d.id, d.to]);

      // A tombstone holds a deleted option down by name. Leaving it pointed at
      // the old value would let the seed resurrect the option under its former
      // name on the next cold start.
      await tx.query(
        `UPDATE ipy_picklist_tombstone SET value = $3
          WHERE picklist_name = $1 AND value = $2`,
        [d.picklist, d.from, d.to],
      );
    }

    return { records, filters };
  });

  logger.info(`done — ${totals.records} record write(s) and ${totals.filters} saved filter/widget/workflow write(s) across two phases`);
  logger.info('restart the CRM (or redeploy) so the metadata cache picks the new values up');
}

/*
  Close the pool, or the process never exits.

  `main` resolving is not the end of the program: every idle client the pool
  holds is an open socket keeping the event loop alive, so the script simply
  sits there — which on a runner reads as a hung job and gets killed at the
  timeout, long after the work was done.
*/
main()
  .then(async () => { await pool.end(); })
  .catch(async (err) => {
    logger.error({ err }, 'aligning dropdown values failed — nothing was written');
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
