import { db, transaction } from '../../../db/pool.js';
import { recordService, type ServiceContext } from '../../../core/entity/recordService.js';
import { matchContact } from './matchContact.js';

/**
 * What happens to a WhatsApp conversation nobody recognises.
 *
 * The specification's rule is blunt and right: never silently create a second
 * contact. So an unknown number is not guessed at and not quietly turned into a
 * lead — it waits here, visible, until a person says which of three things it
 * is. Somebody new, somebody we already have, or nothing.
 *
 * "Nothing" matters as much as the other two. Wrong numbers, delivery drivers
 * and one-word spam all reach a rep's WhatsApp, and without a way to dismiss
 * them the unmatched list becomes a thing nobody opens — at which point a real
 * enquiry sits in it unread.
 */

const MODULE = 'leads';

export interface UnmatchedConversation {
  conversationId: string;
  handle: string;
  contactName: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  /** Records already holding this number, when there is more than one. */
  candidates: { recordId: string; label: string }[];
}

/**
 * The conversations on this agent's own account that are not on a contact.
 *
 * Scoped to the agent, like everything else here: an unmatched conversation is
 * somebody messaging *their* number, and it is theirs to resolve.
 */
export async function listUnmatched(userId: string): Promise<UnmatchedConversation[]> {
  const { rows } = await db.query<{
    id: string; handle: string; contact_name: string | null;
    last_message_at: string | null; last_message_preview: string | null; unread_count: number;
  }>(
    `SELECT c.id, c.handle, c.contact_name, c.last_message_at, c.last_message_preview, c.unread_count
       FROM ipy_conversation c
       JOIN ipy_wa_account a ON a.id = c.wa_account_id
      WHERE a.user_id = $1
        AND c.channel = 'whatsapp'
        AND c.record_id IS NULL
        AND c.status <> 'resolved'
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 100`,
    [userId],
  );

  return Promise.all(rows.map(async (row) => {
    /*
      The candidates are recomputed rather than stored. A number that matched
      nobody last week may match somebody today — because a colleague added
      them, or an import landed — and offering that is the difference between
      one click and retyping a contact that already exists.
    */
    const match = await matchContact(MODULE, row.handle);
    return {
      conversationId: row.id,
      handle: row.handle,
      contactName: row.contact_name,
      lastMessageAt: row.last_message_at,
      lastMessagePreview: row.last_message_preview,
      unreadCount: row.unread_count,
      candidates: match.kind === 'ambiguous'
        ? match.candidates
        : match.kind === 'one'
          ? [{ recordId: match.recordId, label: match.label }]
          : [],
    };
  }));
}

/** The agent's own conversation, or nothing. Never somebody else's. */
async function ownConversation(userId: string, conversationId: string): Promise<{ id: string; handle: string } | null> {
  return db.queryOne<{ id: string; handle: string }>(
    `SELECT c.id, c.handle
       FROM ipy_conversation c
       JOIN ipy_wa_account a ON a.id = c.wa_account_id
      WHERE c.id = $1 AND a.user_id = $2`,
    [conversationId, userId],
  );
}

/**
 * Attach a conversation to a contact that already exists.
 *
 * Everything already said comes with it — the messages are rows on the
 * conversation, so the contact's WhatsApp tab and timeline fill in at once.
 */
export async function linkExisting(userId: string, conversationId: string, recordId: string): Promise<void> {
  const conversation = await ownConversation(userId, conversationId);
  if (!conversation) throw new Error('That conversation is not on your WhatsApp account.');

  const exists = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [recordId],
  );
  if (!exists) throw new Error('That contact no longer exists.');

  await db.query(
    `UPDATE ipy_conversation SET record_id = $2, record_module = $3, status = 'open' WHERE id = $1`,
    [conversationId, recordId, MODULE],
  );
}

/**
 * Make a contact from a conversation, and attach it.
 *
 * Through `recordService`, not a hand-written INSERT — so validation, the
 * duplicate check, assignment rules, workflows and the audit trail all apply
 * exactly as they do when somebody types the person in. A lead created from
 * WhatsApp is not a second class of lead.
 */
export async function createContact(
  ctx: ServiceContext,
  conversationId: string,
  values: Record<string, unknown>,
): Promise<{ recordId: string }> {
  const conversation = await ownConversation(ctx.user.id, conversationId);
  if (!conversation) throw new Error('That conversation is not on your WhatsApp account.');

  const created = await recordService.createRecord(ctx, MODULE, {
    ...values,
    // The number is the one fact the conversation is certain of, so it is not
    // left to be retyped — and not overridden if the form offered another.
    mobile: values.mobile ?? conversation.handle.replace(/\D/g, '').slice(-10),
  });

  await db.query(
    `UPDATE ipy_conversation SET record_id = $2, record_module = $3, status = 'open' WHERE id = $1`,
    [conversationId, created.id, MODULE],
  );
  return { recordId: created.id };
}

/**
 * Dismiss a conversation without attaching it to anybody.
 *
 * `resolved` rather than a delete: a wrong number that messages again should
 * not reappear as new work, and nothing a customer said is thrown away. The
 * unread count goes, because it is not waiting on anybody any more.
 */
export async function ignore(userId: string, conversationId: string): Promise<void> {
  const conversation = await ownConversation(userId, conversationId);
  if (!conversation) throw new Error('That conversation is not on your WhatsApp account.');
  await transaction(async (conn) => {
    await conn.query(
      `UPDATE ipy_conversation SET status = 'resolved', unread_count = 0 WHERE id = $1`,
      [conversationId],
    );
  });
}
