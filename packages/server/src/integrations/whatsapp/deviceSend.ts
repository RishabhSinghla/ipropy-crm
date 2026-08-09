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
import { BadRequestError } from '../../utils/errors.js';
import { touchActivity } from '../../core/entity/recordService.js';
import { getOrCreateConversation, resolveHandle } from './service.js';
import { isOptedOut } from './consent.js';

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

/**
 * The queue a rep works through.
 *
 * Unassigned rows are included for everyone: a follow-up nobody owns is still
 * a follow-up, and the failure mode of it sitting invisible is worse than two
 * people seeing it.
 */
export async function listPending(userId: string, limit = 100): Promise<PendingDeviceSend[]> {
  const rows = await db.query<{
    id: string; handle: string; name: string | null; body: string; reason: string | null;
    record_id: string | null; module_name: string | null; created_at: string;
  }>(
    `SELECT id, handle, name, body, reason, record_id, module_name, created_at
     FROM ipy_device_send
     WHERE status IN ('pending','opened')
       AND (assigned_to = $1 OR assigned_to IS NULL)
     ORDER BY created_at
     LIMIT $2`,
    [userId, limit],
  );

  return rows.rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    name: r.name,
    body: r.body,
    reason: r.reason,
    recordId: r.record_id,
    module: r.module_name,
    link: buildWaLink(r.handle, r.body),
    createdAt: r.created_at,
  }));
}

/**
 * Confirm a queued message was sent, and mirror it into the conversation.
 *
 * Called after the rep comes back from WhatsApp. We cannot detect that they
 * actually pressed send — this is their word for it, which is exactly what a
 * manually logged call has always been.
 */
export async function markSent(id: string, userId: string): Promise<{ messageId: string | null }> {
  const row = await db.queryOne<{
    handle: string; body: string; record_id: string | null; status: string;
  }>(
    `UPDATE ipy_device_send SET status = 'sent', completed_at = now()
     WHERE id = $1 AND status IN ('pending','opened')
     RETURNING handle, body, record_id, status`,
    [id],
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

export async function markOpened(id: string): Promise<void> {
  await db.query(
    `UPDATE ipy_device_send SET status = 'opened', opened_at = COALESCE(opened_at, now())
     WHERE id = $1 AND status = 'pending'`,
    [id],
  );
}

export async function skip(id: string, reason?: string): Promise<void> {
  await db.query(
    `UPDATE ipy_device_send SET status = 'skipped', completed_at = now(),
            reason = COALESCE($2, reason)
     WHERE id = $1 AND status IN ('pending','opened')`,
    [id, reason ?? null],
  );
}

/**
 * Write a device-sent message onto the conversation timeline.
 *
 * Exported because the record page sends directly without ever queuing —
 * pressing "WhatsApp" on a lead should not require a queue round-trip.
 */
export async function logDeviceMessage(input: {
  handle: string;
  body: string;
  recordId?: string | null;
  sentBy: string;
  broadcastId?: string | null;
}): Promise<string | null> {
  try {
    const conversationId = await getOrCreateConversation(input.handle);

    const message = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_message
        (conversation_id, direction, channel, type, body, status, provider, sent_via, sent_by)
       VALUES ($1,'outbound','whatsapp','text',$2,'handed_off','device','device',$3)
       RETURNING id`,
      [conversationId, input.body, input.sentBy],
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
      await db.query(
        `UPDATE ipy_e_leads
         SET last_contacted_at = now(),
             status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END
         WHERE record_id = $1`,
        [input.recordId],
      );
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
    return renderTemplate(body, {
      ...(await orgScope()),
      ...row,
      // The commonest token in every message anyone writes, and the one most
      // likely to be blank on an imported record — fall back to the label so a
      // greeting never reads "Hi ,".
      first_name: row.first_name || label.split(' ')[0] || 'there',
      name: label,
    });
  } catch (err) {
    logger.debug({ err, recordId }, 'merge render fell back to org scope');
    return renderTemplate(body, await orgScope());
  }
}

async function orgScope(): Promise<Record<string, unknown>> {
  const org = await db.queryOne<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.name'`,
  );
  return { org_name: org?.value ?? 'iPropy', first_name: 'there', name: 'there' };
}
