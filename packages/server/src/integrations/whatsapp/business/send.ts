/**
 * Sending on the business number, from inside the CRM.
 *
 * The row is written *before* the provider is called, in 'queued', and moved
 * to 'sent' when it answers. The other order looks tidier and loses messages:
 * a provider that accepts and then times out on the reply leaves a customer
 * with a message and the CRM with no record of it.
 *
 * Two rules the caller does not have to know about:
 *
 *  * **The 24-hour window.** Outside it WhatsApp only carries an approved
 *    template, so a free-text send is refused *here*, with the reason, rather
 *    than by the provider after a rep has typed a paragraph.
 *  * **Opt-out is final.** Somebody who asked not to be messaged is not
 *    messaged, whoever is asking and whatever the template says.
 */
import { db, onCommit, transaction } from '../../../db/pool.js';
import { bus } from '../../../core/events/bus.js';
import { BadRequestError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { requireCapability } from '../providers/types.js';
import { matchKey } from '../agent/matchContact.js';
import { activeBusinessProvider } from './registry.js';

const MODULE = 'leads';

export interface BusinessSendInput {
  userId: string;
  to: string;
  /** A free reply, only allowed while the window is open. */
  text?: string;
  /** An approved template, allowed at any time. */
  template?: { name: string; language: string; params: string[]; headerMedia?: { link: string; filename?: string } };
  recordId?: string | null;
}

export interface BusinessSendResult {
  messageId: string;
  conversationId: string;
  providerMessageId: string;
  status: 'queued' | 'sent';
}

/** Has this person asked not to be messaged on WhatsApp? */
async function optedOut(handle: string): Promise<boolean> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_channel_optout
      WHERE channel = 'whatsapp' AND right(regexp_replace(handle, '\\D', '', 'g'), 10) = right($1, 10)
      LIMIT 1`,
    [handle],
  );
  return Boolean(row);
}

/** The business thread for this number, created on first contact from our side. */
async function conversationFor(handle: string, recordId: string | null, userId: string): Promise<{
  id: string; windowOpen: boolean;
}> {
  const existing = await db.queryOne<{ id: string; window_expires_at: string | null }>(
    `SELECT id, window_expires_at FROM ipy_conversation
      WHERE channel = 'whatsapp' AND handle = $1 AND wa_account_id IS NULL LIMIT 1`,
    [handle],
  );
  if (existing) {
    return {
      id: existing.id,
      windowOpen: Boolean(existing.window_expires_at && new Date(existing.window_expires_at) > new Date()),
    };
  }
  const created = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, record_id, record_module, assigned_to)
     VALUES ('whatsapp', $1, $2, $3, $4)
     RETURNING id`,
    [handle, recordId, recordId ? MODULE : null, userId],
  );
  // Nobody has written to us, so there is no window: only a template may go.
  return { id: created!.id, windowOpen: false };
}

export async function sendOnBusinessNumber(input: BusinessSendInput): Promise<BusinessSendResult> {
  const provider = activeBusinessProvider();
  if (!provider) throw new BadRequestError('No official WhatsApp provider is switched on.');

  const handle = matchKey(input.to);
  if (!handle) throw new BadRequestError('That is not a number WhatsApp can reach.');
  if (await optedOut(handle)) {
    throw new BadRequestError('This person has opted out of WhatsApp messages.');
  }

  const conversation = await conversationFor(handle, input.recordId ?? null, input.userId);

  if (input.template) requireCapability(provider, 'templates');
  if (!input.template) {
    requireCapability(provider, 'text');
    if (!conversation.windowOpen) {
      throw new BadRequestError(
        'This chat is outside WhatsApp\'s 24-hour window, so only an approved template can be sent.',
      );
    }
  }

  const body = input.template
    ? `[template: ${input.template.name}]`
    : input.text ?? '';

  // Written first, on purpose: a provider that accepts and then times out on
  // the answer must not leave the customer holding a message the CRM never
  // heard of.
  const queued = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_message
       (conversation_id, direction, channel, type, body, status, provider, route, sent_by,
        template_name, template_params)
     VALUES ($1, 'outbound', 'whatsapp', $2, $3, 'queued', $4, 'business', $5, $6, $7)
     RETURNING id`,
    [
      conversation.id,
      input.template ? 'template' : 'text',
      body,
      provider.name,
      input.userId,
      input.template?.name ?? null,
      input.template ? JSON.stringify(input.template.params) : null,
    ],
  );

  try {
    const outcome = input.template
      ? await provider.sendTemplate({
        to: handle,
        templateName: input.template.name,
        language: input.template.language,
        params: input.template.params,
        headerMedia: input.template.headerMedia ?? null,
      })
      : await provider.sendMessage({ accountId: null, to: handle, text: input.text ?? '' });

    await transaction(async (conn) => {
      await conn.query(
        `UPDATE ipy_message SET status = $2, provider_message_id = $3 WHERE id = $1`,
        [queued!.id, outcome.status === 'sent' ? 'sent' : 'queued', outcome.providerMessageId || null],
      );
      await conn.query(
        `UPDATE ipy_conversation
            SET last_message_at = now(), last_message_preview = $2
          WHERE id = $1`,
        [conversation.id, body.slice(0, 200)],
      );
      onCommit(conn, async () => {
        bus.emit('message.sent', {
          conversationId: conversation.id,
          messageId: queued!.id,
          direction: 'outbound',
          channel: 'whatsapp',
          body,
          handle,
          recordId: input.recordId ?? null,
        });
      });
    });

    return {
      messageId: queued!.id,
      conversationId: conversation.id,
      providerMessageId: outcome.providerMessageId,
      status: outcome.status,
    };
  } catch (err) {
    // The failure is on the message, where a rep can see it and press Retry —
    // not only in a log nobody reads.
    await db.query(
      `UPDATE ipy_message SET status = 'failed', error_message = $2 WHERE id = $1`,
      [queued!.id, (err as Error).message.slice(0, 500)],
    );
    logger.warn({ err, provider: provider.name }, 'WhatsApp business send failed');
    throw err;
  }
}
