/**
 * The thread behind one phone number, without opening anything.
 *
 * What the composer needs before it can offer the right control: is there a
 * conversation at all, is WhatsApp's 24-hour window still open, and what were
 * the last few things said.
 *
 * **It writes nothing, and that is the whole point.** Clicking the WhatsApp
 * icon beside a number is somebody looking, not somebody starting a
 * conversation. A row created on a glance would put an empty thread into the
 * team's shared queue for every number anybody hovered over, and the queue is
 * the one screen that has to mean something. `sendOnBusinessNumber` creates
 * the conversation, on the first message that actually goes.
 */
import { db } from '../../../db/pool.js';
import { BadRequestError } from '../../../utils/errors.js';
import { matchKey } from '../agent/matchContact.js';

export interface NumberThread {
  handle: string;
  conversationId: string | null;
  windowOpen: boolean;
  windowExpiresAt: string | null;
  assignedName: string | null;
  messages: Record<string, unknown>[];
}

/**
 * `withMessages` is the caller's answer to "may this person read the thread?".
 * The route decides it by loading the record through `recordService`, exactly
 * as the contact's WhatsApp tab does — the record is the gate, not the thread.
 * Without it the answer still carries the window state, which is enough to
 * choose a control and nothing to read.
 */
export async function threadForNumber(to: string, withMessages: boolean): Promise<NumberThread> {
  const handle = matchKey(to);
  if (!handle) throw new BadRequestError('That is not a number WhatsApp can reach.');

  const thread = await db.queryOne<{
    id: string; window_expires_at: string | null; assigned_name: string | null;
  }>(
    `SELECT c.id, c.window_expires_at,
            trim(u.first_name || ' ' || u.last_name) AS assigned_name
       FROM ipy_conversation c
       LEFT JOIN ipy_user u ON u.id = c.assigned_to
      WHERE c.channel = 'whatsapp' AND c.handle = $1 AND c.wa_account_id IS NULL
      LIMIT 1`,
    [handle],
  );

  let messages: Record<string, unknown>[] = [];
  if (thread && withMessages) {
    // The last handful, newest last, so the composer reads like a chat rather
    // than like a report. The whole history is on the contact's own tab.
    const { rows } = await db.query(
      `SELECT id, direction, type, body, status, template_name, created_at, route
         FROM ipy_message
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 12`,
      [thread.id],
    );
    messages = rows.reverse();
  }

  return {
    handle,
    conversationId: thread?.id ?? null,
    windowOpen: Boolean(thread?.window_expires_at && new Date(thread.window_expires_at) > new Date()),
    windowExpiresAt: thread?.window_expires_at ?? null,
    assignedName: thread?.assigned_name ?? null,
    messages,
  };
}
