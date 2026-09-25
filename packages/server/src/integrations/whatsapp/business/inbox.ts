/**
 * The shared inbox on the business number.
 *
 * One number for the whole team, so a conversation belongs to the business and
 * is *worked* by one person at a time — take it, pass it on, resolve it. That
 * is the difference from the agent route, where a thread belongs to whoever's
 * phone it arrived on and nobody else can answer it.
 *
 * **Who sees what.** An admin sees every thread. Everybody else sees the ones
 * assigned to them and the ones assigned to nobody — which is the queue they
 * are meant to pick from. A thread another rep is already working is not in
 * anybody else's list, because two people answering one customer is the
 * failure this screen exists to prevent, and a manager who needs to look has
 * the contact's own WhatsApp tab (where the CRM's ordinary record permissions
 * decide, as they do everywhere else).
 */
import { db } from '../../../db/pool.js';
import { BadRequestError, NotFoundError } from '../../../utils/errors.js';
import { notify } from '../../../core/notifications/index.js';

export type InboxFilter = 'all' | 'mine' | 'unassigned' | 'unread' | 'open' | 'pending' | 'resolved';

export interface InboxConversation {
  id: string;
  handle: string;
  contactName: string | null;
  recordId: string | null;
  recordModule: string | null;
  recordLabel: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  status: string;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** Whether a free reply is allowed, or only an approved template. */
  windowOpen: boolean;
  /** When that stops being true, so the queue can say how long is left. */
  windowExpiresAt: string | null;
  /** WhatsApp's own full number, so a screen can print one a person recognises. */
  waId: string | null;
}

/**
 * Who holds a thread: **the person its record is assigned to.**
 *
 * 25 September 2026, the owner: *"There is no different assigned to of record
 * between WhatsApp and what our system has."* A contact assigned to Vijay is
 * Vijay's conversation too, and reassigning the contact reassigns the chat —
 * with nothing to keep in step, because this is read off the record every
 * time rather than copied onto the conversation.
 *
 * A thread nobody has linked to a record has no owner to borrow, so it keeps
 * its own `assigned_to`; that is the unknown-number queue, and it is still
 * worked the way it always was. One SQL expression rather than a join, because
 * the three queries that decide "whose is this" join different tables and all
 * of them call the conversation `c`.
 */
export const HOLDER = `COALESCE(
  (SELECT holder.owner_id FROM ipy_record holder
    WHERE holder.id = c.record_id AND holder.is_deleted = false),
  c.assigned_to
)`;

/**
 * Who may see a thread, as a clause plus the parameters it actually names.
 *
 * The parameters travel *with* the clause and are never bound "just in case":
 * an admin's clause is `TRUE` and names nothing, and Postgres refuses a whole
 * statement that binds a parameter it never references —
 * "could not determine data type of parameter $1", at runtime, with a rep
 * looking at an empty inbox. That is CLAUDE.md rule 8, and this is the fifth
 * time this codebase has met it; the integration test above is what caught it
 * here rather than production.
 *
 * Exported, because the messaging report has to answer "how many" under the
 * same rule that decides "which": two copies would be two different answers to
 * one question about the same threads.
 */
export function visibility(userId: string, isAdmin: boolean, nextIndex: number): {
  clause: string; params: unknown[];
} {
  return isAdmin
    ? { clause: 'TRUE', params: [] }
    : { clause: `(${HOLDER} = $${nextIndex} OR ${HOLDER} IS NULL)`, params: [userId] };
}

export async function listConversations(input: {
  userId: string;
  isAdmin: boolean;
  filter: InboxFilter;
  /**
   * Only threads attached to a record of this module — "Contacts chats",
   * "Inventories chats".
   *
   * A module *name*, never a list of them written here: there are two today
   * and an admin can add a third without a deploy. A thread nobody has linked
   * to a record has no module and is correctly left out of both.
   */
  module?: string;
  search?: string;
  limit?: number;
}): Promise<InboxConversation[]> {
  const params: unknown[] = [];
  const see = visibility(input.userId, input.isAdmin, params.length + 1);
  params.push(...see.params);

  const where: string[] = [
    `c.channel = 'whatsapp'`,
    // The business threads: the agent route keys its own to an account.
    `c.wa_account_id IS NULL`,
    see.clause,
  ];

  if (input.filter === 'mine') {
    params.push(input.userId);
    where.push(`${HOLDER} = $${params.length}`);
  }
  if (input.filter === 'unassigned') where.push(`${HOLDER} IS NULL`);
  if (input.filter === 'unread') where.push(`c.unread_count > 0`);
  if (input.filter === 'open') where.push(`c.status = 'open'`);
  if (input.filter === 'pending') where.push(`c.status = 'pending'`);
  if (input.filter === 'resolved') where.push(`c.status = 'resolved'`);

  if (input.module?.trim()) {
    params.push(input.module.trim());
    where.push(`c.record_module = $${params.length}`);
  }

  if (input.search?.trim()) {
    params.push(`%${input.search.trim().toLowerCase()}%`);
    where.push(`(
      lower(coalesce(c.contact_name, '')) LIKE $${params.length}
      OR c.handle LIKE $${params.length}
      OR lower(coalesce(c.last_message_preview, '')) LIKE $${params.length}
      OR lower(coalesce(r.label, '')) LIKE $${params.length}
    )`);
  }

  params.push(Math.min(input.limit ?? 100, 300));

  const { rows } = await db.query<{
    id: string; handle: string; contact_name: string | null; record_id: string | null;
    record_module: string | null; record_label: string | null; assigned_to: string | null;
    assigned_name: string | null; status: string; unread_count: number;
    last_message_at: string | null; last_message_preview: string | null;
    window_expires_at: string | null;
    wa_id: string | null;
  }>(
    `SELECT c.id, c.handle, c.contact_name, c.record_id, c.record_module,
            r.label AS record_label, ${HOLDER} AS assigned_to,
            trim(u.first_name || ' ' || u.last_name) AS assigned_name,
            c.status, c.unread_count, c.last_message_at, c.last_message_preview,
            c.window_expires_at, c.wa_id
       FROM ipy_conversation c
       LEFT JOIN ipy_record r ON r.id = c.record_id
       LEFT JOIN ipy_user u ON u.id = ${HOLDER}
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  );

  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    contactName: row.contact_name,
    recordId: row.record_id,
    recordModule: row.record_module,
    recordLabel: row.record_label,
    assignedTo: row.assigned_to,
    assignedName: row.assigned_name,
    status: row.status,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    windowOpen: Boolean(row.window_expires_at && new Date(row.window_expires_at).getTime() > now),
    windowExpiresAt: row.window_expires_at,
    waId: row.wa_id,
  }));
}

/** The one place a thread is fetched with its visibility checked. */
export async function readableConversation(
  userId: string, isAdmin: boolean, conversationId: string,
): Promise<{ id: string; handle: string; recordId: string | null; assignedTo: string | null }> {
  const params: unknown[] = [conversationId];
  const see = visibility(userId, isAdmin, params.length + 1);
  params.push(...see.params);

  const row = await db.queryOne<{
    id: string; handle: string; record_id: string | null; assigned_to: string | null;
  }>(
    `SELECT id, handle, record_id, ${HOLDER} AS assigned_to
       FROM ipy_conversation c
      WHERE c.id = $1 AND c.channel = 'whatsapp' AND c.wa_account_id IS NULL
        AND ${see.clause}`,
    params,
  );
  if (!row) throw new NotFoundError('That conversation is not in your inbox.');
  return { id: row.id, handle: row.handle, recordId: row.record_id, assignedTo: row.assigned_to };
}

export async function conversationMessages(
  userId: string, isAdmin: boolean, conversationId: string,
): Promise<Record<string, unknown>[]> {
  await readableConversation(userId, isAdmin, conversationId);
  const { rows } = await db.query(
    `SELECT m.id, m.direction, m.type, m.body, m.media, m.status, m.error_message,
            m.template_name, m.created_at, m.delivered_at, m.read_at, m.route,
            trim(u.first_name || ' ' || u.last_name) AS sent_by_name
       FROM ipy_message m
       LEFT JOIN ipy_user u ON u.id = m.sent_by
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC
      LIMIT 500`,
    [conversationId],
  );
  return rows;
}

/** Opening a thread is what marks it read — receiving it is not. */
export async function markRead(userId: string, isAdmin: boolean, conversationId: string): Promise<void> {
  await readableConversation(userId, isAdmin, conversationId);
  await db.query(`UPDATE ipy_conversation SET unread_count = 0 WHERE id = $1`, [conversationId]);
}

/** Deliberately separate from read: a rep parks a thread to come back to it. */
export async function markUnread(userId: string, isAdmin: boolean, conversationId: string): Promise<void> {
  await readableConversation(userId, isAdmin, conversationId);
  await db.query(
    `UPDATE ipy_conversation SET unread_count = GREATEST(unread_count, 1) WHERE id = $1`,
    [conversationId],
  );
}

/**
 * Take, hand over, or let go.
 *
 * Taking a thread somebody else holds is allowed and deliberate — a rep goes
 * home mid-conversation — but it is never silent: the person losing it is told,
 * so nobody discovers it by finding the customer already answered.
 */
export async function assign(input: {
  userId: string;
  isAdmin: boolean;
  conversationId: string;
  /** null lets it go back to the unassigned queue. */
  to: string | null;
}): Promise<void> {
  const current = await readableConversation(input.userId, input.isAdmin, input.conversationId);

  if (input.to) {
    const exists = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE id = $1 AND is_active = true`, [input.to],
    );
    if (!exists) throw new BadRequestError('That person is not an active user.');
  }

  await db.query(
    `UPDATE ipy_conversation SET assigned_to = $2, status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END
      WHERE id = $1`,
    [input.conversationId, input.to],
  );

  if (current.assignedTo && current.assignedTo !== input.to && current.assignedTo !== input.userId) {
    await notify({
      userId: current.assignedTo,
      kind: 'whatsapp',
      title: 'A WhatsApp chat was moved',
      body: 'Somebody else has taken a conversation that was assigned to you.',
      link: '/chats',
    });
  }
  if (input.to && input.to !== input.userId) {
    await notify({
      userId: input.to,
      kind: 'whatsapp',
      title: 'A WhatsApp chat is yours',
      body: 'A conversation has been assigned to you.',
      link: '/chats',
    });
  }
}

export async function setStatus(input: {
  userId: string; isAdmin: boolean; conversationId: string; status: 'open' | 'pending' | 'resolved';
}): Promise<void> {
  await readableConversation(input.userId, input.isAdmin, input.conversationId);
  await db.query(
    `UPDATE ipy_conversation SET status = $2 WHERE id = $1`,
    [input.conversationId, input.status],
  );
}

/**
 * Who else is looking at this thread right now.
 *
 * Kept in memory rather than in a table: it is true for thirty seconds and
 * writing it to Postgres would mean a row per person per thread per minute for
 * something nobody wants to read tomorrow. A restart forgets who was looking,
 * which is the right amount of wrong.
 */
const viewers = new Map<string, Map<string, { name: string; at: number }>>();
const VIEWER_TTL_MS = 45_000;

export function noteViewing(conversationId: string, userId: string, name: string): void {
  const room = viewers.get(conversationId) ?? new Map();
  room.set(userId, { name, at: Date.now() });
  viewers.set(conversationId, room);
}

export function othersViewing(conversationId: string, userId: string): string[] {
  const room = viewers.get(conversationId);
  if (!room) return [];
  const cutoff = Date.now() - VIEWER_TTL_MS;
  const names: string[] = [];
  for (const [id, entry] of room) {
    if (entry.at < cutoff) { room.delete(id); continue; }
    if (id !== userId) names.push(entry.name);
  }
  return names;
}
