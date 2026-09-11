/**
 * Device sends — WhatsApp without a WhatsApp Business account.
 *
 * `https://wa.me/<number>?text=<message>` opens WhatsApp with the message
 * already typed. No Meta account, no business verification, no template
 * approval, no 24-hour window, no per-message fee, and no way to get the
 * number restricted for messaging the wrong person — because a human presses
 * send.
 *
 * That last part is the whole trade. The CRM does the thinking (who to message,
 * what to say, with their name and their unit in it) and a person does the
 * sending, so this is one tap per recipient rather than none. For a desk doing
 * tens of follow-ups a day that difference is small; for the eight months it
 * takes to decide you want a Business account, it is the difference between
 * having the feature and not.
 *
 * Everything is recorded the same way an API send is, so the timeline, the
 * lead's last-contacted date and the reporting do not care which path was
 * used — with one honest exception: a device message is marked `handed_off`,
 * never `delivered`, because nothing here can observe what the phone did next.
 * Claiming delivery we cannot see would make the reporting a lie.
 */
import { renderTemplate, toE164 } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { withNameParts } from '../../core/entity/nameParts.js';
import { BadRequestError } from '../../utils/errors.js';
import { touchActivity } from '../../core/entity/recordService.js';
import { getOrCreateConversation, resolveHandle } from './service.js';
import { isOptedOut } from './consent.js';
import { markContacted } from '../../core/entity/payloadColumns.js';

/**
 * WhatsApp truncates a prefilled message somewhere north of this, and a long
 * opener performs badly anyway. Enforced here rather than in the UI so a
 * sequence step or an AI draft cannot quietly produce a truncated message.
 */
const MAX_PREFILL = 1500;

export interface DeviceSendInput {
  handle: string;
  body: string;
  recordId?: string | null;
  module?: string | null;
  name?: string | null;
  reason?: string | null;
  broadcastId?: string | null;
  sequenceId?: string | null;
  assignedTo?: string | null;
}

/**
 * Build the deep link.
 *
 * `wa.me` needs digits only — no `+`, no spaces. `encodeURIComponent` rather
 * than URLSearchParams because the latter encodes spaces as `+`, which WhatsApp
 * renders literally as plus signs in the message body.
 */
export function buildWaLink(handle: string, body: string): string {
  const digits = (toE164(handle) ?? handle).replace(/\D/g, '');
  if (!digits) throw new BadRequestError('That number cannot be dialled on WhatsApp');
  const text = body.slice(0, MAX_PREFILL);
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * Queue one message for a human to send.
 *
 * Consent is checked here as well as on the API path. A device send cannot get
 * the business number banned, but "we messaged someone who told us to stop" is
 * the same broken promise however the message travelled.
 */
export async function queueDeviceSend(input: DeviceSendInput, conn: Tx = db): Promise<{ id: string; skipped?: string }> {
  const handle = toE164(input.handle) ?? input.handle.trim();
  if (!handle) throw new BadRequestError('A recipient number is required');

  if (await isOptedOut(handle, conn)) {
    return { id: '', skipped: 'This number has opted out of WhatsApp messages.' };
  }

  const resolved = input.recordId
    ? null
    : await resolveHandle(handle, conn);

  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_device_send
      (record_id, module_name, handle, name, body, reason, broadcast_id, sequence_id, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      input.recordId ?? resolved?.recordId ?? null,
      input.module ?? resolved?.module ?? null,
      handle,
      input.name ?? resolved?.name ?? null,
      input.body.slice(0, MAX_PREFILL),
      input.reason ?? null,
      input.broadcastId ?? null,
      input.sequenceId ?? null,
      input.assignedTo ?? resolved?.ownerId ?? null,
    ],
  );
  return { id: row!.id };
}

export interface PendingDeviceSend {
  id: string;
  handle: string;
  name: string | null;
  body: string;
  reason: string | null;
  recordId: string | null;
  module: string | null;
  link: string;
  createdAt: string;
}

/** The columns every queue read selects, in the shape the API hands out. */
interface QueueRow {
  id: string; handle: string; name: string | null; body: string; reason: string | null;
  record_id: string | null; module_name: string | null; created_at: string;
}

const QUEUE_COLUMNS =
  // A row enqueued before the name was stored (or by a path that never knew
  // it) still shows the lead's name: the record's display label is the same
  // fact, one join away.
  'd.id, d.handle, COALESCE(d.name, r.label) AS name, d.body, d.reason, d.record_id, d.module_name, d.created_at';

function toPending(r: QueueRow): PendingDeviceSend {
  return {
    id: r.id,
    handle: r.handle,
    name: r.name,
    body: r.body,
    reason: r.reason,
    recordId: r.record_id,
    module: r.module_name,
    link: buildWaLink(r.handle, r.body),
    createdAt: r.created_at,
  };
}

/**
 * The queue a rep works through.
 *
 * Unassigned rows are included for everyone: a follow-up nobody owns is still
 * a follow-up, and the failure mode of it sitting invisible is worse than two
 * people seeing it.
 *
 * Deleted records are not. Deleting a lead is a soft delete — the row stays in
 * `ipy_record` with `is_deleted`, so the FK never fires and the queued message
 * outlived the person it was addressed to. A rep who has just deleted somebody
 * and then finds the CRM still asking them to WhatsApp them has been told the
 * delete did not work. Filtered rather than cancelled on delete, so restoring
 * from the recycle bin brings the queue back with the record.
 */
export async function listPending(userId: string, limit = 100): Promise<PendingDeviceSend[]> {
  const rows = await db.query<QueueRow>(
    `SELECT ${QUEUE_COLUMNS}
     FROM ipy_device_send d
     LEFT JOIN ipy_record r ON r.id = d.record_id
     WHERE d.status IN ('pending','opened')
       AND (d.assigned_to = $1 OR d.assigned_to IS NULL)
       AND (d.record_id IS NULL OR r.is_deleted = false)
     ORDER BY d.created_at
     LIMIT $2`,
    [userId, limit],
  );
  return rows.rows.map(toPending);
}

/**
 * Confirm a queued message was sent, and mirror it into the conversation.
 *
 * Called after the rep comes back from WhatsApp. We cannot detect that they
 * actually pressed send — this is their word for it, which is exactly what a
 * manually logged call has always been.
 */
export async function markSent(id: string, userId: string, isAdmin = false): Promise<{ messageId: string | null }> {
  const row = await db.queryOne<{
    handle: string; body: string; record_id: string | null; status: string;
  }>(
    `UPDATE ipy_device_send
     SET status = 'sent', completed_at = now(), assigned_to = COALESCE(assigned_to, $2)
     WHERE id = $1 AND status IN ('pending','opened')
       AND (assigned_to = $2 OR assigned_to IS NULL OR $3)
     RETURNING handle, body, record_id, status`,
    [id, userId, isAdmin],
  );
  if (!row) return { messageId: null };

  const messageId = await logDeviceMessage({
    handle: row.handle,
    body: row.body,
    recordId: row.record_id,
    sentBy: userId,
  });
  return { messageId };
}

/** One waiting message, subject to the same assignment rules as the queue. */
export async function findPending(
  id: string,
  userId: string,
  isAdmin = false,
): Promise<PendingDeviceSend | null> {
  const row = await db.queryOne<QueueRow>(
    `SELECT ${QUEUE_COLUMNS}
     FROM ipy_device_send d
     LEFT JOIN ipy_record r ON r.id = d.record_id
     WHERE d.id = $1 AND d.status IN ('pending','opened')
       AND (d.assigned_to = $2 OR d.assigned_to IS NULL OR $3)
       AND (d.record_id IS NULL OR r.is_deleted = false)`,
    [id, userId, isAdmin],
  );
  return row ? toPending(row) : null;
}

/**
 * Reword a queued message before it goes out.
 *
 * The whole promise of the queue is that the CRM writes and a person sends, and
 * a person who cannot change a word before sending it is not really the author.
 * A generated opener is usually right and occasionally says something this
 * particular buyer would find odd — the choice was previously send it as
 * written or skip it entirely.
 *
 * Only while it is still waiting: editing something already marked sent would
 * rewrite history, since the body is what got copied onto the timeline.
 */
export async function editBody(
  id: string,
  body: string,
  userId: string,
  isAdmin = false,
): Promise<PendingDeviceSend | null> {
  const text = body.trim();
  if (!text) throw new BadRequestError('A message cannot be empty');

  const row = await db.queryOne<QueueRow>(
    `WITH updated AS (
       UPDATE ipy_device_send d SET body = $4
       WHERE d.id = $1 AND d.status IN ('pending','opened')
         AND (d.assigned_to = $2 OR d.assigned_to IS NULL OR $3)
       RETURNING d.id, d.handle, d.name, d.body, d.reason, d.record_id, d.module_name, d.created_at
     )
     SELECT u.id, u.handle, COALESCE(u.name, r.label) AS name, u.body, u.reason,
            u.record_id, u.module_name, u.created_at
     FROM updated u LEFT JOIN ipy_record r ON r.id = u.record_id`,
    [id, userId, isAdmin, text.slice(0, MAX_PREFILL)],
  );
  return row ? toPending(row) : null;
}

export async function markOpened(id: string, userId: string, isAdmin = false): Promise<void> {
  await db.query(
    `UPDATE ipy_device_send
     SET status = 'opened', opened_at = COALESCE(opened_at, now()),
         assigned_to = COALESCE(assigned_to, $2)
     WHERE id = $1 AND status = 'pending'
       AND (assigned_to = $2 OR assigned_to IS NULL OR $3)`,
    [id, userId, isAdmin],
  );
}

export async function skip(id: string, userId: string, isAdmin = false, reason?: string): Promise<void> {
  await db.query(
    `UPDATE ipy_device_send SET status = 'skipped', completed_at = now(),
            reason = COALESCE($4, reason), assigned_to = COALESCE(assigned_to, $2)
     WHERE id = $1 AND status IN ('pending','opened')
       AND (assigned_to = $2 OR assigned_to IS NULL OR $3)`,
    [id, userId, isAdmin, reason ?? null],
  );
}

/**
 * Write a device-sent message onto the conversation timeline.
 *
 * Exported because the record page sends directly without ever queuing —
 * pressing "WhatsApp" on a lead should not require a queue round-trip.
 *
 * `via` decides the recorded status, and the distinction is not cosmetic. A
 * `wa.me` hand-off is marked `handed_off` because a person opened WhatsApp and
 * we cannot see what they did next; a linked phone reports back that the
 * message actually left, so that one is `sent`. Reporting both as sent would
 * make the reporting a lie in one direction, and reporting both as handed off
 * would throw away the one thing linking a phone buys us.
 */
export async function logDeviceMessage(input: {
  handle: string;
  body: string;
  recordId?: string | null;
  /** Null for an automated send with no person behind it. */
  sentBy?: string | null;
  broadcastId?: string | null;
  via?: 'device' | 'linked';
  providerMessageId?: string | null;
}): Promise<string | null> {
  try {
    const conversationId = await getOrCreateConversation(input.handle);
    const via = input.via ?? 'device';

    const message = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_message
        (conversation_id, direction, channel, type, body, status, provider, sent_via, sent_by,
         provider_message_id)
       VALUES ($1,'outbound','whatsapp','text',$2,$3,$4,$4,$5,$6)
       RETURNING id`,
      [
        conversationId,
        input.body,
        via === 'linked' ? 'sent' : 'handed_off',
        via,
        input.sentBy ?? null,
        input.providerMessageId ?? null,
      ],
    );

    await db.query(
      `UPDATE ipy_conversation
       SET last_message_at = now(), last_message_preview = $2, updated_at = now()
       WHERE id = $1`,
      [conversationId, input.body.slice(0, 200)],
    );

    // A device send is real contact — the lead should stop looking untouched.
    if (input.recordId) {
      await touchActivity(input.recordId);
      await markContacted(input.recordId);
    }

    return message?.id ?? null;
  } catch (err) {
    // The message has physically gone out by now; failing to file it is worth
    // a log, not an error thrown back at someone who already sent it.
    logger.warn({ err, handle: input.handle }, 'could not record device-sent WhatsApp message');
    return null;
  }
}

/**
 * Render a message for one record.
 *
 * Shares the `{{token}}` grammar with templates and workflows so the same
 * wording can move between an approved template and a device send without
 * being rewritten.
 */
export async function renderForRecord(
  body: string,
  recordId: string | null,
  module = 'leads',
): Promise<string> {
  if (!recordId) return renderTemplate(body, await orgScope());
  try {
    const { registry } = await import('../../core/metadata/registry.js');
    const meta = await registry.requireModule(module);
    const row = await db.queryOne<Record<string, unknown>>(
      `SELECT r.label, e.* FROM ipy_record r JOIN ${meta.tableName} e ON e.record_id = r.id WHERE r.id = $1`,
      [recordId],
    );
    if (!row) return renderTemplate(body, await orgScope());

    const label = String(row.label ?? '');
    // `first_name` / `last_name` are derived from `full_name` rather than
    // stored — see core/entity/nameParts.ts. `orgScope` supplies the "there"
    // fallback so a greeting never reads "Hi ,".
    return renderTemplate(body, {
      ...(await orgScope()),
      ...withNameParts({ ...row, label }),
    });
  } catch (err) {
    logger.debug({ err, recordId }, 'merge render fell back to org scope');
    return renderTemplate(body, await orgScope());
  }
}

/** Render from a permission-filtered record envelope supplied by an API route. */
export async function renderForValues(
  body: string,
  values: Record<string, unknown>,
  label: string,
): Promise<string> {
  return renderTemplate(body, {
    ...(await orgScope()),
    ...withNameParts({ ...values, label }),
  });
}

async function orgScope(): Promise<Record<string, unknown>> {
  const org = await db.queryOne<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.name'`,
  );
  return { org_name: org?.value ?? 'iPropy', first_name: 'there', name: 'there' };
}
