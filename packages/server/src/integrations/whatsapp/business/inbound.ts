/**
 * A customer's message arriving on the business number.
 *
 * One contact, one history: the message lands on the same `ipy_conversation`
 * the Inbox already reads, against the same lead a call would be filed
 * against, and the timeline shows the call and the reply in one column. There
 * is no second messages table for the official route, because there is no
 * second customer.
 *
 * Three rules that are the whole of it:
 *
 *  * **Seen once.** Providers retry, Meta for days. A delivery already
 *    recorded is dropped before anything is written, so nobody is notified
 *    twice about the same sentence.
 *  * **Never a silent duplicate contact.** An unknown number opens a
 *    conversation with no record attached and waits for a person to create,
 *    link or ignore — the owner's §3 — because a CRM that invents a second
 *    "Ravi" every time somebody messages from a spare phone is a CRM whose
 *    contact list nobody trusts.
 *  * **Written in a transaction, announced after it.** `onCommit`, because an
 *    event emitted inside an open transaction deadlocks against the workflow
 *    that answers it, and this codebase has already paid for that lesson.
 */
import { db, onCommit, transaction, type Tx } from '../../../db/pool.js';
import { bus } from '../../../core/events/bus.js';
import { logger } from '../../../utils/logger.js';
import { notifyMany } from '../../../core/notifications/index.js';
import { matchContact, matchKey } from '../matchContact.js';
import { businessProvider } from './registry.js';
import { keepInboundMedia } from './media.js';
import type { InboundMessage, StatusUpdate } from './types.js';

const MODULE = 'leads';

/** How long the CRM remembers a delivery, which is longer than any provider retries. */
const EVENT_MEMORY_DAYS = 30;

/**
 * Has this exact delivery been handled before?
 *
 * The insert *is* the check: two webhook deliveries racing each other both ask
 * at once, and only the one that wins the unique index gets a row back. A
 * SELECT-then-INSERT would let both through on a bad afternoon.
 */
export async function claimEvent(
  conn: Tx, provider: string, kind: 'message' | 'status', key: string,
): Promise<boolean> {
  if (!key) return false;
  const row = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_webhook_event (provider, kind, event_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, kind, event_key) DO NOTHING
     RETURNING id`,
    [provider, kind, key],
  );
  return Boolean(row);
}

/** Keeps the memory from growing for ever. Cheap, indexed, and nobody has to remember it. */
async function pruneEvents(conn: Tx): Promise<void> {
  await conn.query(
    `DELETE FROM ipy_wa_webhook_event WHERE received_at < now() - ($1 || ' days')::interval`,
    [String(EVENT_MEMORY_DAYS)],
  );
}

/**
 * The business conversation for a handle.
 *
 * `wa_account_id IS NULL` is what makes it the business one: the agent route
 * keys a thread to the rep's own account, and the official number is shared by
 * the whole team, so there is exactly one thread per customer.
 */
async function conversationFor(
  conn: Tx, handle: string, recordId: string | null, contactName: string | null,
): Promise<{ id: string; assignedTo: string | null }> {
  const existing = await conn.queryOne<{ id: string; assigned_to: string | null }>(
    `SELECT id, assigned_to FROM ipy_conversation
      WHERE channel = 'whatsapp' AND handle = $1 AND wa_account_id IS NULL
      LIMIT 1`,
    [handle],
  );
  if (existing) {
    // A thread that started unknown and is claimed later keeps everything said
    // before the claim.
    if (recordId) {
      await conn.query(
        `UPDATE ipy_conversation
            SET record_id = COALESCE(record_id, $2),
                record_module = COALESCE(record_module, $3),
                contact_name = COALESCE(contact_name, $4)
          WHERE id = $1`,
        [existing.id, recordId, MODULE, contactName],
      );
    }
    return { id: existing.id, assignedTo: existing.assigned_to };
  }

  /*
    Assigned to whoever owns the lead, when the CRM knows them. Not to whoever
    happens to be online: a customer answering a rep's own message must reach
    that rep, and an unowned thread is better handled by the unassigned queue
    than by a guess.
  */
  const owner = recordId
    ? await conn.queryOne<{ owner_id: string | null }>(
      `SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId],
    )
    : null;

  const created = await conn.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, contact_name, record_id, record_module, assigned_to)
     VALUES ('whatsapp', $1, $2, $3, $4, $5)
     RETURNING id`,
    [handle, contactName, recordId, recordId ? MODULE : null, owner?.owner_id ?? null],
  );
  return { id: created!.id, assignedTo: owner?.owner_id ?? null };
}

export interface StoredInbound {
  conversationId: string;
  messageId: string;
  recordId: string | null;
  handle: string;
  /** True when nobody in the CRM holds this number, so a person must decide. */
  unmatched: boolean;
}

/**
 * Store one inbound message and tell whoever needs to know.
 *
 * Returns null when the delivery was a repeat, so the caller can count it as
 * handled without pretending anything new arrived.
 */
export async function receiveInbound(
  provider: string, message: InboundMessage,
): Promise<StoredInbound | null> {
  const handle = matchKey(message.from);
  if (!handle) {
    logger.warn({ provider }, 'WhatsApp webhook carried a message with no sender');
    return null;
  }

  const match = await matchContact(MODULE, message.from);
  const recordId = match.kind === 'one' ? match.recordId : null;

  const stored = await transaction(async (conn): Promise<StoredInbound | null> => {
    if (!await claimEvent(conn, provider, 'message', message.providerMessageId)) return null;

    const conversation = await conversationFor(
      conn, handle, recordId, message.profileName,
    );

    const body = message.text
      ?? (message.media?.caption ?? null)
      ?? (message.type === 'other' ? null : `[${message.type}]`);

    const row = await conn.queryOne<{ id: string }>(
      `INSERT INTO ipy_message
         (conversation_id, direction, channel, type, body, media, status,
          provider_message_id, provider, route, created_at)
       VALUES ($1, 'inbound', 'whatsapp', $2, $3, $4, 'delivered', $5, $6, 'business', $7)
       RETURNING id`,
      [
        conversation.id,
        message.type === 'other' ? 'text' : message.type,
        body,
        message.media ? JSON.stringify(message.media) : null,
        message.providerMessageId,
        provider,
        message.sentAt,
      ],
    );

    await conn.query(
      /*
        `$2::timestamptz` in every position, not just the first. Postgres
        deduces a parameter's type from where it is used, and the same one used
        as a timestamp *and* as the left side of `+ interval` deduces two
        different types and refuses the whole statement — "inconsistent types
        deduced for parameter $2", which arrives at runtime with a customer's
        message in hand. Cousin of rule 8 in CLAUDE.md, and caught here by a
        test against a real database for exactly that reason.
      */
      `UPDATE ipy_conversation
          SET last_message_at = $2::timestamptz,
              last_message_preview = COALESCE($3, last_message_preview),
              last_inbound_at = $2::timestamptz,
              unread_count = unread_count + 1,
              -- The 24-hour service window reopens on every inbound message.
              -- Outside it only an approved template may be sent, and this is
              -- the column the composer reads to know which it is offering.
              window_expires_at = $2::timestamptz + interval '24 hours',
              status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END
        WHERE id = $1`,
      [conversation.id, message.sentAt, body?.slice(0, 200) ?? null],
    );

    await pruneEvents(conn);

    const result: StoredInbound = {
      conversationId: conversation.id,
      messageId: row!.id,
      recordId,
      handle,
      unmatched: recordId === null,
    };

    onCommit(conn, async () => {
      bus.emit('message.received', {
        conversationId: result.conversationId,
        messageId: result.messageId,
        direction: 'inbound',
        channel: 'whatsapp',
        body,
        handle,
        recordId,
      });
    });

    return result;
  });

  if (!stored) return null;

  /*
    Collect the file, now that the message is safely written.

    Outside the transaction on purpose: fetching a 15MB video is a round trip
    to the vendor, and a provider that does not hear a prompt 200 sends the
    whole delivery again. If it fails, the message and its caption still
    stand — which is the right half to keep.
  */
  if (message.media) {
    const adapter = businessProvider(provider);
    if (adapter) {
      await keepInboundMedia({
        provider: adapter,
        messageId: stored.messageId,
        recordId: stored.recordId,
        ref: message.media,
      });
    }
  }

  // The rep whose lead this is, or every admin when nobody owns it. Through
  // `notify`, so it reaches the bell *and* the phone rather than only the bell.
  await tellSomebody(stored, message);
  return stored;
}

async function tellSomebody(stored: StoredInbound, message: InboundMessage): Promise<void> {
  const conversation = await db.queryOne<{ assigned_to: string | null; contact_name: string | null }>(
    `SELECT assigned_to, contact_name FROM ipy_conversation WHERE id = $1`, [stored.conversationId],
  );
  const recipients = conversation?.assigned_to
    ? [conversation.assigned_to]
    : (await db.query<{ id: string }>(
      `SELECT id FROM ipy_user WHERE is_admin = true AND is_active = true`,
    )).rows.map((row) => row.id);

  if (!recipients.length) return;

  const who = conversation?.contact_name || message.profileName || stored.handle;
  await notifyMany(recipients, {
    kind: 'whatsapp',
    title: `WhatsApp from ${who}`,
    body: (message.text ?? `[${message.type}]`).slice(0, 140),
    link: stored.recordId ? `/${MODULE}/${stored.recordId}` : '/chats',
    recordId: stored.recordId,
  });
}

/**
 * Sent → delivered → read, or failed, coming back for something already sent.
 *
 * Only ever moves forward: providers deliver these out of order often enough
 * that a late "sent" would otherwise un-read a message the customer has
 * plainly read.
 */
export async function applyStatus(provider: string, update: StatusUpdate): Promise<boolean> {
  const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  return transaction(async (conn): Promise<boolean> => {
    if (!await claimEvent(conn, provider, 'status', `${update.providerMessageId}:${update.state}`)) return false;

    const row = await conn.queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM ipy_message
        WHERE provider_message_id = $1 AND route = 'business'
        ORDER BY created_at DESC LIMIT 1`,
      [update.providerMessageId],
    );
    if (!row) return false;
    if ((rank[update.state] ?? 0) <= (rank[row.status] ?? 0) && update.state !== 'failed') return false;

    await conn.query(
      `UPDATE ipy_message
          SET status = $2,
              delivered_at = CASE WHEN $2 IN ('delivered','read') THEN COALESCE(delivered_at, $3) ELSE delivered_at END,
              read_at = CASE WHEN $2 = 'read' THEN COALESCE(read_at, $3) ELSE read_at END,
              error_message = $4
        WHERE id = $1`,
      [row.id, update.state, update.at, update.error],
    );
    return true;
  });
}
