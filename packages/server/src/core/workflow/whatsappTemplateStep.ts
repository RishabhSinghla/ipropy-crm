/**
 * The workflow step "Send a WhatsApp template".
 *
 * `send_whatsapp` was removed on 17 September 2026 after a daily rule with an
 * emptied condition list queued 40,515 messages. This step is the safe way
 * back, and its safety lives here, in one place, not in how a rule is set up:
 *
 *  - an approved template only — WhatsApp allows nothing else to a stranger;
 *  - the one send path (`sendOnBusinessNumber`), which already refuses an
 *    opted-out person and a number it cannot dial;
 *  - the same person never gets the same template twice from the CRM;
 *  - a blank the template needs but the record lacks is named, never sent.
 *
 * A quiet refusal (already sent, opted out) returns; anything somebody must
 * look at throws, so the failure shows in the workflow's own log.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { loadUser } from '../../middleware/auth.js';
import { buildScopeContext } from '../permissions/index.js';
import { organisationName, resolveTemplate } from '../../integrations/whatsapp/business/templates.js';
import { sendOnBusinessNumber } from '../../integrations/whatsapp/business/send.js';
import { activeBusinessProvider } from '../../integrations/whatsapp/business/registry.js';
import type { TaskContext } from './tasks.js';

/** The record's owner, else the first active admin — somebody real to read and send as. */
async function whoSends(ctx: TaskContext): Promise<string | null> {
  const owner = typeof ctx.record.owner_id === 'string' ? ctx.record.owner_id : null;
  if (owner) {
    const active = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE id = $1 AND is_active`, [owner],
    );
    if (active) return active.id;
  }
  const admin = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_user WHERE is_admin AND is_active ORDER BY created_at LIMIT 1`,
  );
  return admin?.id ?? null;
}

async function alreadySent(recordId: string, templateName: string): Promise<boolean> {
  const row = await db.queryOne<{ one: number }>(
    `SELECT 1 AS one
       FROM ipy_message m
       JOIN ipy_conversation c ON c.id = m.conversation_id
      WHERE c.record_id = $1 AND m.direction = 'outbound'
        AND m.template_name = $2 AND m.status <> 'failed'
      LIMIT 1`,
    [recordId, templateName],
  );
  return Boolean(row);
}

export async function sendWhatsAppTemplate(config: Record<string, unknown>, ctx: TaskContext): Promise<void> {
  const templateId = String(config.templateId ?? '');
  if (!templateId) throw new Error('Choose which WhatsApp template this step sends.');
  if (!activeBusinessProvider()) throw new Error('No official WhatsApp provider is switched on.');

  const senderId = await whoSends(ctx);
  if (!senderId) throw new Error('There is no active user to send this WhatsApp message as.');
  const sender = await loadUser(senderId);
  if (!sender) throw new Error('The user this WhatsApp message would be sent as no longer exists.');
  const scope = await buildScopeContext(sender);

  const filled = await resolveTemplate({
    ctx: scope,
    templateId,
    module: ctx.module,
    recordId: ctx.recordId,
    agentName: sender.fullName ?? '',
    orgName: await organisationName(),
  });
  if (filled.missing.length) {
    const gaps = filled.missing.map((gap) => `{{${gap.slot}}} ${gap.reason}`).join('; ');
    throw new Error(`WhatsApp template "${filled.name}" was not sent: ${gaps}.`);
  }

  if (await alreadySent(ctx.recordId, filled.name)) {
    logger.info({ recordId: ctx.recordId, template: filled.name }, 'WhatsApp template already sent to this record — skipped');
    return;
  }

  const mobile = String(ctx.record.mobile ?? '').trim();
  if (!mobile) throw new Error('This record has no mobile number to send the WhatsApp template to.');

  try {
    await sendOnBusinessNumber({
      userId: senderId,
      to: mobile,
      recordId: ctx.recordId,
      template: { name: filled.name, language: filled.language, params: filled.params },
    });
  } catch (err) {
    // Someone who opted out asked not to be messaged. That is the answer, not a fault.
    if (/opted out/i.test((err as Error).message)) {
      logger.info({ recordId: ctx.recordId }, 'WhatsApp template not sent — the person opted out');
      return;
    }
    throw err;
  }
}
