/**
 * The two things the chat panel can do with an OpenWA conversation that the
 * ordinary inbox does not: turn a stranger's chat into a lead, and show a file
 * they sent.
 *
 * **Creating a lead is a person's decision, one chat at a time.** An unknown
 * number never becomes a contact on its own (the owner's rule, and the reason
 * `receiveInbound` files it as an unmatched conversation instead). When a rep
 * presses the button the name comes from the only place we are entitled to
 * read it — what the person calls themselves on WhatsApp, which OpenWA hands
 * over with their message — and the number from the chat itself. Nothing is
 * looked up anywhere else.
 */
import { splitPhone } from '@ipropy/shared';
import { db } from '../../../db/pool.js';
import { getModule } from '../../../core/metadata/registry.js';
import { recordService } from '../../../core/entity/recordService.js';
import { BadRequestError, NotFoundError } from '../../../utils/errors.js';
import { matchContact } from '../matchContact.js';
import { readableConversation } from './inbox.js';
import { fetchOpenWaMedia, toWaDigits } from './openwa.js';
import type { ScopeContext } from '../../../core/permissions/index.js';

/** A dash-and-digits name nobody chose is better than a blank one: `full_name` is mandatory. */
function fallbackName(digits: string): string {
  return `WhatsApp +${digits}`;
}

export async function createLeadFromChat(
  scope: ScopeContext & { source: string }, userId: string, isAdmin: boolean, conversationId: string,
): Promise<{ recordId: string; linkedExisting: boolean }> {
  const convo = await readableConversation(userId, isAdmin, conversationId);
  if (convo.recordId) throw new BadRequestError('This chat already belongs to a contact.');

  const row = await db.queryOne<{ contact_name: string | null; wa_id: string | null }>(
    `SELECT contact_name, wa_id FROM ipy_conversation WHERE id = $1`, [conversationId],
  );
  if (!row) throw new NotFoundError('That conversation is gone.');

  // Never a second "Ravi": if the number is already a contact, link to it.
  const match = await matchContact('leads', convo.handle);
  if (match.kind === 'ambiguous') {
    throw new BadRequestError('More than one contact has this number, so the CRM will not choose. Open the right one and send from there.');
  }
  if (match.kind === 'one') {
    await link(conversationId, match.recordId, userId);
    return { recordId: match.recordId, linkedExisting: true };
  }

  const digits = toWaDigits(row.wa_id ?? convo.handle, '');
  const phone = splitPhone(digits ? `+${digits}` : convo.handle);
  if (!phone) throw new BadRequestError('The CRM could not read a phone number from this chat.');

  const leads = await getModule('leads');
  const sourceField = leads?.fields.find((f) => ['source', 'lead_source'].includes(f.name) && f.isActive);
  const whatsAppSource = sourceField?.options?.find((o) => [o.value, o.label].some((v) => /^whatsapp$/i.test(v.trim())));

  const values: Record<string, unknown> = {
    full_name: row.contact_name?.trim() || fallbackName(digits ?? convo.handle),
    country_code: phone.countryCode,
    mobile: phone.national,
    owner_id: userId,
  };
  if (sourceField && whatsAppSource) values[sourceField.name] = whatsAppSource.value;

  const record = await recordService.createRecord(scope, 'leads', values);
  await link(conversationId, record.id, userId);
  return { recordId: record.id, linkedExisting: false };
}

async function link(conversationId: string, recordId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE ipy_conversation
        SET record_id = $2, record_module = 'leads', assigned_to = COALESCE(assigned_to, $3)
      WHERE id = $1 AND record_id IS NULL`,
    [conversationId, recordId, userId],
  );
}

/** One received file, fetched from OpenWA now and passed straight through. */
export async function loadMessageFile(
  userId: string, isAdmin: boolean, messageId: string,
): Promise<{ data: Buffer; mimeType: string; fileName: string }> {
  const msg = await db.queryOne<{
    conversation_id: string; provider_message_id: string | null; media: { filename?: string; mimeType?: string } | null;
  }>(
    `SELECT conversation_id, provider_message_id, media FROM ipy_message WHERE id = $1`, [messageId],
  );
  if (!msg?.provider_message_id || !msg.media) throw new NotFoundError('That message has no file.');
  await readableConversation(userId, isAdmin, msg.conversation_id);
  const convo = await db.queryOne<{ wa_id: string | null; handle: string }>(
    `SELECT wa_id, handle FROM ipy_conversation WHERE id = $1`, [msg.conversation_id],
  );
  const digits = toWaDigits(convo?.wa_id ?? convo?.handle ?? '', '');
  if (!digits) throw new BadRequestError('The CRM does not know this chat\'s full number, so it cannot ask OpenWA for the file.');
  const file = await fetchOpenWaMedia(digits, msg.provider_message_id);
  return {
    data: file.data,
    mimeType: msg.media.mimeType || file.mimeType,
    fileName: msg.media.filename || 'whatsapp-file',
  };
}
