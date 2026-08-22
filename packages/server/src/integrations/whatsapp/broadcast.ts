/**
 * Broadcasts — one send to many people, recorded.
 *
 * The old `broadcast()` looped over recipients and reported two numbers at the
 * end. That is fine right up to the first time someone asks "did Sharma-ji get
 * it?", which is the only question anyone ever actually asks.
 *
 * So the audience is frozen into rows before anything sends. Every recipient
 * carries its own status, its own merge values and its own error. A broadcast
 * can be paused, resumed after a restart, and explained a month later.
 *
 * Two modes, and they are the point of this file:
 *
 *  * `api` sends through the Cloud API. Needs a WhatsApp Business account and,
 *    outside a 24-hour window, an approved template.
 *  * `device` writes a hand-off queue instead. No account, no approval, no
 *    template — the operator works the list on their phone. Same audience, same
 *    merge fields, same reporting.
 *
 * Everything above this file is written against `startBroadcast`, so which of
 * the two is in use is a setting, not a rewrite.
 */
import { db } from '../../db/pool.js';
import { toInternational } from '@ipropy/shared';
import { logger } from '../../utils/logger.js';
import { withNameParts } from '../../core/entity/nameParts.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { notify } from '../../core/notifications/index.js';
import { filterOptedOut } from './consent.js';
import { sendMessage, bindTemplateParams } from './service.js';
import { queueDeviceSend, renderForValues } from './deviceSend.js';
import * as provider from './provider.js';
import type { RecordEnvelope } from '@ipropy/shared';

export type ChannelMode = 'api' | 'device';

export interface CreateBroadcastInput {
  name: string;
  channelMode: ChannelMode;
  templateName?: string | null;
  bodyText?: string | null;
  module?: string;
  /** Already permission-filtered by recordService at the HTTP boundary. */
  records: RecordEnvelope[];
  audience?: Record<string, unknown>;
  scheduledAt?: string | null;
  ratePerSecond?: number;
  createdBy: string;
}

/**
 * Resolve the audience and freeze it.
 *
 * Skips are recorded as rows rather than dropped, because "why did only 180 of
 * my 200 leads get this?" needs an answer per person, not a count.
 */
export async function createBroadcast(input: CreateBroadcastInput): Promise<{ id: string; total: number; skipped: number }> {
  if (input.channelMode === 'api' && !input.templateName && !input.bodyText) {
    throw new BadRequestError('Choose a template or write a message before creating a broadcast');
  }
  if (input.channelMode === 'device' && !input.bodyText) {
    throw new BadRequestError('Device sends need message text — there is no template to fall back on');
  }

  const module = input.module ?? 'leads';
  const { registry } = await import('../../core/metadata/registry.js');
  await registry.requireModule(module);

  const broadcast = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_broadcast
      (name, channel_mode, template_name, body_text, module_name, audience,
       status, scheduled_at, rate_per_second, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.name, input.channelMode, input.templateName ?? null, input.bodyText ?? null,
      module, JSON.stringify(input.audience ?? { records: input.records.length, module }),
      input.scheduledAt ? 'scheduled' : 'draft',
      input.scheduledAt ?? null,
      input.ratePerSecond ?? 10,
      input.createdBy,
    ],
  );
  const broadcastId = broadcast!.id;

  const candidates: { recordId: string; handle: string; name: string; row: Record<string, unknown> }[] = [];
  const skips: { recordId: string; handle: string; name: string; reason: string }[] = [];

  for (const record of input.records) {
    const row = record.values;
    const recordId = record.id;
    const name = record.label;
    // Leads store ten bare digits; a broadcast needs the dialable form.
    const handle = toInternational(null, String(row.whatsapp_number ?? row.mobile ?? '')) ?? '';

    if (!handle) {
      skips.push({ recordId, handle: '', name, reason: 'No WhatsApp number on the record' });
      continue;
    }
    if (row.do_not_whatsapp === true) {
      skips.push({ recordId, handle, name, reason: 'Marked do-not-WhatsApp' });
      continue;
    }
    candidates.push({ recordId, handle, name, row });
  }

  // Consent, in one query for the whole list. Compared on the last ten digits
  // for the same reason every other number lookup here is: the same person
  // exists as "98123 45678", "+919812345678" and "09812345678" across imports,
  // and an opt-out that only matches one of those formats is not an opt-out.
  const optedOut = await filterOptedOut(candidates.map((c) => c.handle));
  const optedOutTails = new Set([...optedOut].map((h) => h.replace(/\D/g, '').slice(-10)));

  let total = 0;
  for (const c of candidates) {
    if (optedOutTails.has(c.handle.replace(/\D/g, '').slice(-10))) {
      skips.push({ ...c, reason: 'Opted out of WhatsApp messages' });
      continue;
    }

    const params = input.templateName
      ? await bindTemplateParams(input.templateName, withNameParts({ ...c.row, label: c.name }))
      : {};

    const rendered = input.bodyText
      ? await renderForValues(input.bodyText, c.row, c.name)
      : null;

    await db.query(
      `INSERT INTO ipy_broadcast_recipient (broadcast_id, record_id, handle, name, params, rendered_text)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (broadcast_id, handle) DO NOTHING`,
      [broadcastId, c.recordId, c.handle, c.name, JSON.stringify(params), rendered],
    );
    total++;
  }

  for (const s of skips) {
    await db.query(
      `INSERT INTO ipy_broadcast_recipient (broadcast_id, record_id, handle, name, status, error)
       VALUES ($1,$2,$3,$4,'skipped',$5)
       ON CONFLICT (broadcast_id, handle) DO NOTHING`,
      [broadcastId, s.recordId, s.handle || `no-number:${s.recordId}`, s.name, s.reason],
    );
  }

  await db.query(
    `UPDATE ipy_broadcast SET total_count = $2, blocked_count = $3 WHERE id = $1`,
    [broadcastId, total, skips.length],
  );

  return { id: broadcastId, total, skipped: skips.length };
}

/**
 * Send. Resumable: only `pending` recipients are picked up, so a restart
 * mid-broadcast continues rather than starting over and double-messaging
 * everyone who already received it.
 */
export async function startBroadcast(broadcastId: string): Promise<void> {
  const broadcast = await db.queryOne<{
    id: string; channel_mode: ChannelMode; template_name: string | null; body_text: string | null;
    module_name: string; rate_per_second: number;
    created_by: string | null; status: string; name: string;
  }>(`SELECT * FROM ipy_broadcast WHERE id = $1`, [broadcastId]);
  if (!broadcast) throw new NotFoundError('Broadcast not found');
  if (broadcast.status === 'completed' || broadcast.status === 'cancelled') {
    throw new BadRequestError(`A ${broadcast.status} broadcast cannot be started again`);
  }

  if (broadcast.channel_mode === 'api' && !(await provider.isConfigured())) {
    throw new BadRequestError(
      'WhatsApp is not connected, so this cannot send through the API. Switch the broadcast to device mode and your team can send it from their own phones.',
      { canUseDevice: true },
    );
  }

  await db.query(
    `UPDATE ipy_broadcast SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE id = $1`,
    [broadcastId],
  );

  launchBroadcast(broadcastId);
}

/** Avoid duplicate loops inside one process; database claims handle other processes. */
const activeRuns = new Set<string>();

function launchBroadcast(broadcastId: string): void {
  if (activeRuns.has(broadcastId)) return;
  activeRuns.add(broadcastId);
  void runBroadcast(broadcastId).catch((err) => {
    logger.error({ err, broadcastId }, 'broadcast run failed');
    void db.query(`UPDATE ipy_broadcast SET status = 'paused', updated_at = now() WHERE id = $1`, [broadcastId]);
  }).finally(() => activeRuns.delete(broadcastId));
}

async function runBroadcast(broadcastId: string): Promise<void> {
  const broadcast = await db.queryOne<{
    channel_mode: ChannelMode; template_name: string | null; body_text: string | null;
    module_name: string; rate_per_second: number;
    created_by: string | null; name: string;
  }>(`SELECT * FROM ipy_broadcast WHERE id = $1`, [broadcastId]);
  if (!broadcast) return;

  const delayMs = Math.max(0, 1000 / Math.max(1, Number(broadcast.rate_per_second)));
  for (;;) {
    // Re-read status each batch so Pause takes effect within a second or two
    // rather than at the end of a two-thousand-person send.
    const current = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_broadcast WHERE id = $1`, [broadcastId],
    );
    if (current?.status !== 'running') {
      logger.info({ broadcastId, status: current?.status }, 'broadcast stopped');
      return;
    }

    const batch = await db.query<{
      id: string; record_id: string | null; handle: string; name: string | null;
      params: Record<string, string>; rendered_text: string | null;
    }>(
      `UPDATE ipy_broadcast_recipient r
       SET status = 'processing', claimed_at = now()
       WHERE r.id IN (
         SELECT id FROM ipy_broadcast_recipient
         WHERE broadcast_id = $1
           AND (status = 'pending'
             OR (status = 'processing' AND claimed_at < now() - interval '15 minutes'))
         ORDER BY id LIMIT 25
         FOR UPDATE SKIP LOCKED
       )
       RETURNING r.id, r.record_id, r.handle, r.name, r.params, r.rendered_text`,
      [broadcastId],
    );
    if (!batch.rows.length) break;

    for (const r of batch.rows) {
      try {
        // The audience was resolved when the broadcast was built, which may
        // have been days ago for a scheduled one. Somebody deleted since then
        // is still a live row (deletion is soft) and would be messaged.
        if (r.record_id && await isDeleted(r.record_id)) {
          await db.query(
            `UPDATE ipy_broadcast_recipient
             SET status = 'skipped', error = 'Record was deleted', claimed_at = NULL WHERE id = $1`,
            [r.id],
          );
          continue;
        }

        if (broadcast.channel_mode === 'device') {
          const queued = await queueDeviceSend({
            handle: r.handle,
            body: r.rendered_text ?? broadcast.body_text ?? '',
            recordId: r.record_id,
            module: broadcast.module_name,
            name: r.name,
            reason: broadcast.name,
            broadcastId,
            assignedTo: broadcast.created_by,
          });
          await db.query(
            `UPDATE ipy_broadcast_recipient
             SET status = $2, error = $3, sent_at = now(), claimed_at = NULL WHERE id = $1`,
            [r.id, queued.skipped ? 'blocked' : 'handed_off', queued.skipped ?? null],
          );
        } else {
          const result = await sendMessage({
            to: r.handle,
            templateName: broadcast.template_name ?? undefined,
            templateParams: broadcast.template_name ? r.params : undefined,
            text: broadcast.template_name ? undefined : (r.rendered_text ?? broadcast.body_text ?? ''),
            isBroadcast: true,
            sentBy: broadcast.created_by,
          });
          await db.query(
            `UPDATE ipy_broadcast_recipient
             SET status = $2, error = $3, message_id = $4, sent_at = now(), claimed_at = NULL
             WHERE id = $1`,
            [
              r.id,
              result.status === 'sent' ? 'sent' : result.status === 'blocked' ? 'blocked' : 'failed',
              result.error ?? null,
              result.messageId || null,
            ],
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.query(
          `UPDATE ipy_broadcast_recipient
           SET status = 'failed', error = $2, claimed_at = NULL WHERE id = $1`,
          [r.id, message.slice(0, 500)],
        );
        logger.warn({ err, handle: r.handle }, 'broadcast recipient failed');
      }

      await db.query(
        `UPDATE ipy_broadcast
         SET sent_count = (SELECT count(*) FROM ipy_broadcast_recipient WHERE broadcast_id = $1 AND status IN ('sent','handed_off')),
             failed_count = (SELECT count(*) FROM ipy_broadcast_recipient WHERE broadcast_id = $1 AND status = 'failed'),
             blocked_count = (SELECT count(*) FROM ipy_broadcast_recipient WHERE broadcast_id = $1 AND status IN ('blocked','skipped')),
             updated_at = now()
         WHERE id = $1`,
        [broadcastId],
      );

      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const totals = await db.queryOne<{ sent: number; failed: number; blocked: number }>(
    `SELECT
       count(*) FILTER (WHERE status IN ('sent','handed_off'))::int AS sent,
       count(*) FILTER (WHERE status = 'failed')::int AS failed,
       count(*) FILTER (WHERE status IN ('blocked','skipped'))::int AS blocked
     FROM ipy_broadcast_recipient WHERE broadcast_id = $1`,
    [broadcastId],
  );
  await db.query(
    `UPDATE ipy_broadcast
     SET status = 'completed', completed_at = now(), sent_count = $2,
         failed_count = $3, blocked_count = $4, updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [broadcastId, totals?.sent ?? 0, totals?.failed ?? 0, totals?.blocked ?? 0],
  );

  if (broadcast.created_by) {
    const verb = broadcast.channel_mode === 'device' ? 'ready to send' : 'sent';
    await notify({
      userId: broadcast.created_by,
      kind: 'broadcast',
      title: `Broadcast "${broadcast.name}" finished`,
      body: `${totals?.sent ?? 0} ${verb}${totals?.failed ? `, ${totals.failed} could not be` : ''}.`,
      link: '/outreach',
    });
  }

  logger.info({ broadcastId, ...totals, mode: broadcast.channel_mode }, 'broadcast complete');
}

/**
 * Has this record been deleted since the audience was frozen?
 *
 * A missing row counts as deleted: a hard delete cascades the recipient away
 * anyway, but a race between the two should fail closed.
 */
async function isDeleted(recordId: string): Promise<boolean> {
  const row = await db.queryOne<{ is_deleted: boolean }>(
    `SELECT is_deleted FROM ipy_record WHERE id = $1`, [recordId],
  );
  return !row || row.is_deleted;
}

export async function pauseBroadcast(id: string): Promise<void> {
  await db.query(
    `UPDATE ipy_broadcast SET status = 'paused', updated_at = now() WHERE id = $1 AND status = 'running'`,
    [id],
  );
}

export async function cancelBroadcast(id: string): Promise<void> {
  await db.query(
    `UPDATE ipy_broadcast SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status <> 'completed'`,
    [id],
  );
}

/** Scheduled broadcasts whose time has come. Called from the scheduler tick. */
export async function runDueBroadcasts(): Promise<number> {
  const due = await db.query<{ id: string }>(
    `SELECT id FROM ipy_broadcast
     WHERE (status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now())
        OR status = 'running'
     ORDER BY created_at LIMIT 10`,
  );
  for (const row of due.rows) {
    await startBroadcast(row.id).catch((err) => logger.warn({ err, id: row.id }, 'scheduled broadcast failed to start'));
  }
  return due.rows.length;
}
