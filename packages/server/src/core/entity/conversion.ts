/**
 * Lifecycle advancement and record merging.
 *
 * This file used to own lead *conversion* — turning a lead into an Organisation
 * plus a Deal. Both modules are gone (migration 030), and with nothing to
 * convert to, conversion went with them.
 *
 * What remains is the part that was never about Deals:
 *
 *  * `advanceLifecycle` moves a lead along Lead → Prospect → Customer. That
 *    sequence is the spine of the whole CRM and is unaffected by which modules
 *    exist around it.
 *  * `mergeRecords` folds a duplicate into the record it duplicates, keeping
 *    the timeline, conversations and files on one id.
 */
import { onCommit, transaction, type Tx } from '../../db/pool.js';
import { BadRequestError, ConflictError } from '../../utils/errors.js';
import { emit } from '../events/bus.js';
import { registry } from '../metadata/registry.js';
import { createRecord, getRecord, updateRecord, type ServiceContext } from './recordService.js';

/** Lead → Prospect → Customer → Past Customer. Only ever moves forward. */
const STAGE_ORDER = ['Lead', 'Prospect', 'Customer', 'Past Customer'];

export async function advanceLifecycle(
  ctx: ServiceContext,
  recordId: string,
  target: 'Lead' | 'Prospect' | 'Customer' | 'Past Customer',
  conn?: Tx,
): Promise<void> {
  const current = await (conn ?? (await import('../../db/pool.js')).db).queryOne<{ lifecycle_stage: string }>(
    `SELECT lifecycle_stage FROM ipy_e_leads WHERE record_id = $1`,
    [recordId],
  );
  if (!current) return;

  const from = STAGE_ORDER.indexOf(current.lifecycle_stage);
  const to = STAGE_ORDER.indexOf(target);
  if (to <= from) return;

  await updateRecord(
    { ...ctx, system: true, source: 'lifecycle' },
    'leads', recordId, { lifecycle_stage: target },
    { conn, skipWorkflow: true },
  );
}

/**
 * Merge duplicate records: keep `primaryId`, fold the others' non-empty values
 * and history into it, then soft-delete the losers.
 */
export async function mergeRecords(
  ctx: ServiceContext,
  moduleName: string,
  primaryId: string,
  duplicateIds: string[],
  fieldChoices: Record<string, string> = {},
): Promise<{ merged: number }> {
  if (duplicateIds.includes(primaryId)) {
    throw new BadRequestError('The primary record cannot also be listed as a duplicate');
  }
  const module = await registry.requireModule(moduleName);

  return transaction(async (tx) => {
    const sysCtx: ServiceContext = { ...ctx, system: true, source: 'merge' };
    const primary = await getRecord(sysCtx, moduleName, primaryId, { conn: tx, withDisplay: false });
    const updates: Record<string, unknown> = {};

    for (const dupId of duplicateIds) {
      const dup = await getRecord(sysCtx, moduleName, dupId, { conn: tx, withDisplay: false });

      for (const field of module.fields) {
        if (!field.isActive || field.isReadonly) continue;
        const chosen = fieldChoices[field.name];
        // Explicit choice wins; otherwise fill only what the primary is missing.
        if (chosen === dupId) {
          updates[field.name] = dup.values[field.name];
        } else if (!chosen) {
          const current = updates[field.name] ?? primary.values[field.name];
          const isBlank = current === null || current === undefined || current === ''
            || (Array.isArray(current) && current.length === 0);
          if (isBlank && dup.values[field.name]) updates[field.name] = dup.values[field.name];
        }
      }

      // Move every child artefact onto the survivor.
      await tx.query(`UPDATE ipy_comment SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_attachment SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_call SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_email_log SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      await tx.query(`UPDATE ipy_ai_insight SET record_id = $1 WHERE record_id = $2`, [primaryId, dupId]);
      // Deals, bookings and payments all reference the party record.
      // A conversation is keyed on (channel, handle); if the survivor already has
      // one for that handle, drop the duplicate's rather than violating the unique key.
      await tx.query(
        `UPDATE ipy_conversation c SET record_id = $1
         WHERE c.record_id = $2
           AND NOT EXISTS (SELECT 1 FROM ipy_conversation o WHERE o.channel = c.channel AND o.handle = c.handle AND o.record_id = $1)`,
        [primaryId, dupId],
      );

      await tx.query(
        `UPDATE ipy_record SET is_deleted = true, deleted_at = now(), deleted_by = $2 WHERE id = $1`,
        [dupId, ctx.user.id],
      );
      await tx.query(
        `INSERT INTO ipy_audit (record_id, module_name, user_id, action, changes, source)
         VALUES ($1,$2,$3,'merge',$4,'app')`,
        [primaryId, moduleName, ctx.user.id, JSON.stringify([{ mergedFrom: dupId, label: dup.label }])],
      );
    }

    if (Object.keys(updates).length) {
      await updateRecord(sysCtx, moduleName, primaryId, updates, { conn: tx, skipDuplicateCheck: true });
    }

    return { merged: duplicateIds.length };
  });
}
