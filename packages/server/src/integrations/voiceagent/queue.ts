import { syncSarvamInbound } from './inbound.js';
import { readSarvamPolicy, sarvamCallingAllowed } from './policy.js';
import { isOptedOut } from '../../core/consent/index.js';
import { db, transaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { loadUser } from '../../middleware/auth.js';
import { assertCapability, buildScopeContext } from '../../core/permissions/index.js';
import { recordService } from '../../core/entity/recordService.js';
import { logger } from '../../utils/logger.js';
import { placeAgentCall } from './sarvam.js';
import { reconcileAndRemember } from './reconcile.js';

/** Claim and dispatch under a cross-process advisory lock. Never redial a lost response. */
export async function tickSarvamQueue(): Promise<void> {
  const claim = await transaction(async (tx) => {
    const lock = await tx.queryOne<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(731904218) AS locked');
    if (!lock?.locked) return;
    await tx.query(`UPDATE ipy_sarvam_queue q SET status = CASE WHEN c.status = 'canceled' THEN 'failed' ELSE c.status END,
      error = c.notes, updated_at = now() FROM ipy_call c
      WHERE q.attempt_id = c.provider_call_id AND c.source = 'sarvam'
      AND q.status IN ('waiting','unknown') AND c.status IN ('completed','busy','no_answer','failed','canceled')`);
    await tx.query(`UPDATE ipy_sarvam_queue SET status = 'unknown', error = 'No confirmed result. Check Sarvam before retrying.', updated_at = now()
      WHERE (status = 'submitting' AND updated_at < now() - interval '1 minute')
         OR (status = 'waiting' AND updated_at < now() - interval '15 minutes')`);
    await tx.query(`UPDATE ipy_sarvam_batch b SET status = 'paused', message = 'Call outcome is unknown. Remaining calls are paused to prevent overlapping calls.'
      WHERE status = 'running' AND EXISTS (SELECT 1 FROM ipy_sarvam_queue q WHERE q.batch_id = b.id AND q.status = 'unknown')`);
    await tx.query(`UPDATE ipy_sarvam_batch b SET status = 'done', message = NULL WHERE status = 'running'
      AND NOT EXISTS (SELECT 1 FROM ipy_sarvam_queue q WHERE q.batch_id = b.id AND q.status IN ('pending','submitting','waiting','unknown'))`);
    const policy = readSarvamPolicy();
    if (!sarvamCallingAllowed(policy)) {
      await tx.query(`UPDATE ipy_sarvam_batch SET message=$1 WHERE status='running' AND message IS DISTINCT FROM $1`,
        [`Waiting for calling hours ${policy.callStart}–${policy.callEnd} India time. Remaining contacts are saved.`]);
      return;
    }
    await tx.query(`UPDATE ipy_sarvam_batch SET message=NULL WHERE status='running' AND message LIKE 'Waiting for calling hours%'`);
    // One phone conversation at a time across CRM queues. A missing callback blocks new dialing.
    const active = await tx.queryOne(`SELECT id FROM ipy_sarvam_queue WHERE status IN ('submitting','waiting','unknown') LIMIT 1`);
    if (active) return;
    const item = await tx.queryOne<{ id: string; batch_id: string; record_id: string; phone: string; module: string; user_id: string }>(
      `SELECT q.*, b.module, b.user_id FROM ipy_sarvam_queue q JOIN ipy_sarvam_batch b ON b.id = q.batch_id
       WHERE b.status = 'running' AND q.status = 'pending' ORDER BY b.created_at, q.position LIMIT 1 FOR UPDATE OF b, q SKIP LOCKED`);
    if (!item) return;
    // Recheck access and do-not-call at dispatch, not just when the batch was prepared.
    try {
      const user = await loadUser(item.user_id);
      if (!user?.isActive) throw new Error('The queue owner is inactive.');
      await assertCapability(user, 'telephony.call');
      const record = await recordService.getRecord(await buildScopeContext(user), item.module, item.record_id);
      if (record.values.do_not_call === true || await isOptedOut(item.phone, 'call', tx)) throw new Error('Do not call is enabled for this contact.');
    } catch (error) {
      await tx.query(`UPDATE ipy_sarvam_queue SET status = 'skipped', error = $2, updated_at = now() WHERE id = $1`, [item.id, (error as Error).message]);
      return;
    }
    // Commit before contacting the provider. Stop acknowledges that this one call is already claimed.
    await tx.query(`UPDATE ipy_sarvam_queue SET status = 'submitting', updated_at = now() WHERE id = $1`, [item.id]);
    return item;
  });
  if (!claim) return;
  try {
    const result = await placeAgentCall({ toNumber: claim.phone, publicBaseUrl: config.appUrl.split(',')[0]!.trim(),
      recordId: claim.record_id, recordModule: claim.module, userId: claim.user_id, batchId: claim.batch_id });
    if (!result.ok && result.outsideWindow) {
      await db.query(`UPDATE ipy_sarvam_queue SET status='pending', updated_at=now() WHERE id=$1`, [claim.id]);
      await db.query(`UPDATE ipy_sarvam_batch SET message=$2 WHERE id=$1`, [claim.batch_id, result.message]);
      return;
    }
    await db.query(`UPDATE ipy_sarvam_queue SET status = $2, attempt_id = $3, error = $4, updated_at = now() WHERE id = $1`,
      [claim.id, result.ok ? 'waiting' : result.uncertain ? 'unknown' : 'failed', result.ok ? result.attemptId : null, result.ok ? null : result.message]);
    if (!result.ok) await db.query(`UPDATE ipy_sarvam_batch SET status = 'paused', message = $2 WHERE id = $1`, [claim.batch_id, result.message]);
  } catch (error) {
    await db.query(`UPDATE ipy_sarvam_queue SET status = 'unknown', error = 'Submission result unknown. Verify with Sarvam before retrying.', updated_at = now() WHERE id = $1`, [claim.id]);
    await db.query(`UPDATE ipy_sarvam_batch SET status = 'paused', message = 'Submission result unknown; dialing paused.' WHERE id = $1`, [claim.batch_id]);
    logger.error({ err: error }, 'Sarvam queue submission could not be confirmed');
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let inboundBusy = false;
let lastInboundCheck = 0;
let reconcileBusy = false;
let lastReconcile = 0;
let reconciledOnce = false;
/** Sarvam is asked what happened to every recent call this often: a lost callback is found within minutes, not never. */
const RECONCILE_EVERY_MS = 10 * 60_000;
export function startSarvamQueue(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (!inboundBusy && Date.now() - lastInboundCheck >= 60_000) {
      inboundBusy = true; lastInboundCheck = Date.now();
      void syncSarvamInbound().catch((err) => logger.error({ err }, 'Sarvam inbound version sync failed')).finally(() => { inboundBusy = false; });
    }
    if (!reconcileBusy && Date.now() - lastReconcile >= (reconciledOnce ? RECONCILE_EVERY_MS : 60_000)) {
      reconcileBusy = true; lastReconcile = Date.now();
      // The first pass after a start looks back two weeks (it also gives older calls their outcome and recording); later ones a day.
      void reconcileAndRemember({ hours: reconciledOnce ? 24 : 14 * 24 }).then((report) => { reconciledOnce = true; if (report.completed || report.backfilled || report.enriched) logger.info(report, 'sarvam: reconciled with Sarvam'); })
        .catch((err) => logger.error({ err }, 'Sarvam reconciliation failed')).finally(() => { reconcileBusy = false; });
    }
    if (busy) return;
    busy = true;
    void tickSarvamQueue().catch((err) => logger.error({ err }, 'Sarvam queue tick failed')).finally(() => { busy = false; });
  }, 3000);
  timer.unref();
}
export function stopSarvamQueue(): void { if (timer) clearInterval(timer); timer = undefined; }
