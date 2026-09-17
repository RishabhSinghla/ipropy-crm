import { db, transaction, onCommit, type Tx } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { notify } from '../../../core/notifications/index.js';
import { decide, mayImportConversation, type HistoryScope } from './historyPolicy.js';
import { handleFromJid, matchContact } from './matchContact.js';
import { textOf, type HistoryConversation, type LiveMessage } from './session.js';

/**
 * Where a WhatsApp message becomes part of the CRM.
 *
 * Everything from a linked phone lands here, and two rules govern all of it:
 *
 *   * **Nothing is stored until the policy says so.** History from a number the
 *     CRM has never heard of is the rep's private life and is dropped before it
 *     reaches a table — see `historyPolicy`.
 *   * **The same message never lands twice.** A reconnect replaying a batch, a
 *     retry, a restart mid-sync: all of them offer messages the CRM may already
 *     hold. The unique index on (account, provider message id) is what makes
 *     that safe, and `ON CONFLICT DO NOTHING` is what makes it quiet.
 *
 * The module is `leads`, which is this CRM's single party record — there is no
 * separate Contacts module, and a conversation attaches to the person.
 */

const MODULE = 'leads';

interface AccountRow {
  id: string;
  user_id: string;
  history_scope: HistoryScope;
  is_enabled: boolean;
}

async function accountOf(accountId: string): Promise<AccountRow | null> {
  return db.queryOne<AccountRow>(
    `SELECT id, user_id, history_scope, is_enabled FROM ipy_wa_account WHERE id = $1`,
    [accountId],
  );
}

/**
 * The conversation this handle belongs to on this account, created if new.
 *
 * Scoped by account as well as handle: two agents may both talk to the same
 * customer, and those are two conversations — Sheetal's thread and Rahul's —
 * not one thread with both their messages interleaved.
 */
async function conversationFor(
  conn: Tx,
  accountId: string,
  handle: string,
  recordId: string | null,
  assignedTo: string,
): Promise<string> {
  const existing = await conn.queryOne<{ id: string }>(
    `SELECT id FROM ipy_conversation
      WHERE channel = 'whatsapp' AND handle = $1 AND wa_account_id = $2
      LIMIT 1`,
    [handle, accountId],
  );
  if (existing) {
    // A conversation that starts unmatched and is claimed later must pick up
    // its record without losing what was already said.
    if (recordId) {
      await conn.query(
        `UPDATE ipy_conversation
            SET record_id = COALESCE(record_id, $2), record_module = COALESCE(record_module, $3)
          WHERE id = $1`,
        [existing.id, recordId, MODULE],
      );
    }
    return existing.id;
  }

  const created = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, record_id, record_module, assigned_to, wa_account_id)
     VALUES ('whatsapp', $1, $2, $3, $4, $5)
     RETURNING id`,
    [handle, recordId, recordId ? MODULE : null, assignedTo, accountId],
  );
  return created!.id;
}

interface InsertInput {
  conversationId: string;
  accountId: string;
  direction: 'inbound' | 'outbound';
  providerMessageId: string;
  body: string | null;
  sentBy: string | null;
  at: Date;
}

/** Returns false when the CRM already held this message. */
async function insertMessage(conn: Tx, input: InsertInput): Promise<boolean> {
  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_message
       (conversation_id, direction, channel, type, body, status, provider_message_id, provider, sent_by, wa_account_id, created_at)
     VALUES ($1,$2,'whatsapp','text',$3,$4,$5,'whatsapp_agent',$6,$7,$8)
     ON CONFLICT (wa_account_id, provider_message_id)
       WHERE wa_account_id IS NOT NULL AND provider_message_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      input.conversationId, input.direction, input.body,
      input.direction === 'inbound' ? 'delivered' : 'sent',
      input.providerMessageId, input.sentBy, input.accountId, input.at,
    ],
  );
  return Boolean(row);
}

async function touchConversation(conn: Tx, conversationId: string, preview: string | null, at: Date, inbound: boolean): Promise<void> {
  await conn.query(
    `UPDATE ipy_conversation
        SET last_message_at = $2,
            last_message_preview = COALESCE($3, last_message_preview),
            last_inbound_at = CASE WHEN $4 THEN $2 ELSE last_inbound_at END,
            unread_count = CASE WHEN $4 THEN unread_count + 1 ELSE unread_count END
      WHERE id = $1`,
    [conversationId, at, preview?.slice(0, 200) ?? null, inbound],
  );
}

/**
 * A message happening now.
 *
 * Both directions come through here — an outbound sent from the agent's phone
 * rather than from the CRM is still news, and leaving it out would show the
 * team half a conversation.
 */
export async function recordLive(message: LiveMessage): Promise<void> {
  const account = await accountOf(message.accountId);
  if (!account) return;

  const handle = handleFromJid(message.jid);
  const match = await matchContact(MODULE, handle);
  // Ambiguous counts as unmatched on purpose: the conversation is kept and
  // waits for a person, rather than being filed on the likelier of two people.
  const recordId = match.kind === 'one' ? match.recordId : null;

  const verdict = decide({
    handle,
    matchedRecordId: recordId,
    arrival: 'live',
    scope: account.history_scope,
  });
  if (!verdict.store) return;

  await transaction(async (conn) => {
    const conversationId = await conversationFor(conn, account.id, handle!, recordId, account.user_id);
    const fresh = await insertMessage(conn, {
      conversationId,
      accountId: account.id,
      direction: message.fromMe ? 'outbound' : 'inbound',
      providerMessageId: message.providerMessageId,
      body: message.text,
      sentBy: message.fromMe ? account.user_id : null,
      at: message.timestamp,
    });
    if (!fresh) return;

    await touchConversation(conn, conversationId, message.text, message.timestamp, !message.fromMe);

    /*
      After the commit, never inside it. A notification fans out to sockets and
      web push, and doing that from an open transaction is how this codebase
      deadlocked once already — the handler picks a different pooled connection
      and blocks on the row this transaction still holds.
    */
    if (!message.fromMe) {
      onCommit(conn, async () => {
        await notify({
          userId: account.user_id,
          kind: 'whatsapp',
          title: match.kind === 'one' ? `WhatsApp from ${match.label}` : `WhatsApp from ${handle}`,
          body: message.text?.slice(0, 140) ?? 'Sent you something',
          link: recordId ? `/${MODULE}/${recordId}` : '/chats',
          recordId,
        });
      });
    }
  });
}

/**
 * The batch that arrives once, in the handshake after a scan.
 *
 * Nothing here notifies, replies, scores or schedules. That is the whole point:
 * running history through the live path would auto-reply to every customer
 * about something they said in March, which is a night this codebase has
 * already lost once.
 */
export async function recordHistory(conversation: HistoryConversation): Promise<void> {
  const account = await accountOf(conversation.accountId);
  if (!account) return;

  const handle = handleFromJid(conversation.jid);
  const match = await matchContact(MODULE, handle);
  const recordId = match.kind === 'one' ? match.recordId : null;

  // Asked once for the whole conversation, before a single message is read.
  if (!mayImportConversation(handle, recordId, account.history_scope)) return;

  await transaction(async (conn) => {
    const conversationId = await conversationFor(conn, account.id, handle!, recordId, account.user_id);
    let newest: { at: Date; text: string | null } | null = null;

    for (const raw of conversation.messages) {
      const id = raw.key?.id;
      if (!id) continue;
      const at = new Date(Number(raw.messageTimestamp ?? 0) * 1000);
      const text = textOf(raw);
      const fresh = await insertMessage(conn, {
        conversationId,
        accountId: account.id,
        direction: raw.key?.fromMe ? 'outbound' : 'inbound',
        providerMessageId: id,
        body: text,
        sentBy: raw.key?.fromMe ? account.user_id : null,
        at,
      });
      if (fresh && (!newest || at > newest.at)) newest = { at, text };
    }

    // The preview and timestamp only, and no unread count: a conversation from
    // before the CRM existed is not eight new messages for somebody to answer.
    if (newest) {
      await conn.query(
        `UPDATE ipy_conversation
            SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
                last_message_preview = COALESCE(last_message_preview, $3)
          WHERE id = $1`,
        [conversationId, newest.at, newest.text?.slice(0, 200) ?? null],
      );
    }
  }).catch((err) => logger.error({ err, accountId: conversation.accountId }, 'could not store WhatsApp history'));
}

/** Record a message the CRM itself sent, so the thread shows it immediately. */
export async function recordOutbound(input: {
  accountId: string;
  userId: string;
  handle: string;
  recordId: string | null;
  providerMessageId: string;
  text: string;
}): Promise<void> {
  await transaction(async (conn) => {
    const conversationId = await conversationFor(conn, input.accountId, input.handle, input.recordId, input.userId);
    const fresh = await insertMessage(conn, {
      conversationId,
      accountId: input.accountId,
      direction: 'outbound',
      providerMessageId: input.providerMessageId,
      body: input.text,
      sentBy: input.userId,
      at: new Date(),
    });
    // Not fresh means the socket's own echo beat us to it, which is normal.
    if (fresh) await touchConversation(conn, conversationId, input.text, new Date(), false);
  });
}
