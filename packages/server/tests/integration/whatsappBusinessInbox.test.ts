/**
 * The shared inbox on the business number.
 *
 * One number for the whole team, so the rules are about *who may see and take
 * what* — and those only exist against a real database with real users:
 *
 *  * a rep sees the queue (unassigned) and their own, and **not** a thread
 *    another rep is working, because two people answering one customer is the
 *    failure this screen exists to prevent;
 *  * an admin sees everything, because somebody has to be able to look;
 *  * taking a thread moves it, and the person losing it is told rather than
 *    finding out from the customer;
 *  * opening marks read, and a rep can park it again by marking it unread.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import {
  assign, conversationMessages, listConversations, markRead, markUnread,
} from '../../src/integrations/whatsapp/business/inbox.js';

const stamp = Date.now();
const MINE = `9111${String(stamp).slice(-6)}`;
const QUEUE = `9222${String(stamp).slice(-6)}`;
const THEIRS = `9333${String(stamp).slice(-6)}`;
const ON_A_LEAD = `9444${String(stamp).slice(-6)}`;

let rep = '';
let otherRep = '';
let admin = '';
const conversations: Record<string, string> = {};

async function conversation(handle: string, assignedTo: string | null): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, assigned_to, last_message_at, last_message_preview, unread_count)
     VALUES ('whatsapp', $1, $2, now(), 'hello', 2)
     RETURNING id`,
    [handle, assignedTo],
  );
  return row!.id;
}

beforeAll(async () => {
  const users = await db.query<{ id: string; is_admin: boolean }>(
    `SELECT id, is_admin FROM ipy_user WHERE is_active = true ORDER BY is_admin DESC, created_at LIMIT 5`,
  );
  admin = users.rows.find((user) => user.is_admin)!.id;
  const reps = users.rows.filter((user) => !user.is_admin);
  rep = reps[0]?.id ?? admin;
  otherRep = reps[1]?.id ?? admin;

  conversations.mine = await conversation(MINE, rep);
  conversations.queue = await conversation(QUEUE, null);
  conversations.theirs = await conversation(THEIRS, otherRep);
  conversations.onALead = await conversation(ON_A_LEAD, admin);
  // Attached to a module, which is what "Contacts chats" filters on. No
  // record: the filter reads `record_module`, and a thread nobody has linked
  // has none — which is exactly the row that must not appear under either.
  await db.query(`UPDATE ipy_conversation SET record_module = 'leads' WHERE id = $1`, [conversations.onALead]);
});

afterAll(async () => {
  await db.query(
    `DELETE FROM ipy_conversation WHERE handle IN ($1,$2,$3,$4)`,
    [MINE, QUEUE, THEIRS, ON_A_LEAD],
  );
});

describe('the shared WhatsApp inbox', () => {
  it('shows a rep their own chats and the unassigned queue, and nobody else\'s', async () => {
    const rows = await listConversations({ userId: rep, isAdmin: false, filter: 'all' });
    const handles = rows.map((row) => row.handle);
    expect(handles).toContain(MINE);
    expect(handles).toContain(QUEUE);
    expect(handles, 'a thread another rep is working must not be in this list').not.toContain(THEIRS);
  });

  it('shows an admin everything', async () => {
    const rows = await listConversations({ userId: admin, isAdmin: true, filter: 'all' });
    const handles = rows.map((row) => row.handle);
    expect(handles).toEqual(expect.arrayContaining([MINE, QUEUE, THEIRS]));
  });

  it('filters down to mine, the queue and unread', async () => {
    const mine = await listConversations({ userId: rep, isAdmin: false, filter: 'mine' });
    expect(mine.every((row) => row.assignedTo === rep)).toBe(true);

    const queue = await listConversations({ userId: rep, isAdmin: false, filter: 'unassigned' });
    expect(queue.every((row) => row.assignedTo === null)).toBe(true);

    const unread = await listConversations({ userId: rep, isAdmin: false, filter: 'unread' });
    expect(unread.every((row) => row.unreadCount > 0)).toBe(true);
  });

  it('finds a chat by number', async () => {
    const found = await listConversations({ userId: rep, isAdmin: false, filter: 'all', search: QUEUE.slice(-6) });
    expect(found.map((row) => row.handle)).toContain(QUEUE);
  });

  it('lets a rep take a chat out of the queue', async () => {
    await assign({ userId: rep, isAdmin: false, conversationId: conversations.queue, to: rep });
    const row = await db.queryOne<{ assigned_to: string }>(
      `SELECT assigned_to FROM ipy_conversation WHERE id = $1`, [conversations.queue],
    );
    expect(row!.assigned_to).toBe(rep);
  });

  it('refuses a rep the thread they cannot see, rather than leaking it', async () => {
    await expect(conversationMessages(rep, false, conversations.theirs))
      .rejects.toThrow(/not in your inbox/i);
  });

  it('marks read on open and can be parked as unread again', async () => {
    await markRead(rep, false, conversations.mine);
    let row = await db.queryOne<{ unread_count: number }>(
      `SELECT unread_count FROM ipy_conversation WHERE id = $1`, [conversations.mine],
    );
    expect(row!.unread_count).toBe(0);

    await markUnread(rep, false, conversations.mine);
    row = await db.queryOne<{ unread_count: number }>(
      `SELECT unread_count FROM ipy_conversation WHERE id = $1`, [conversations.mine],
    );
    expect(row!.unread_count).toBeGreaterThan(0);
  });

});

/**
 * "Contacts chats" and "Inventories chats" in the queue's dropdown.
 *
 * The filter is a module *name* rather than a list written in the code: there
 * are two modules today and an admin may add a third with no deploy. A thread
 * nobody has linked to a record belongs to no module and is correctly in
 * neither — which is the half worth pinning, because an unlinked thread
 * appearing under both would be invisible until somebody counted.
 */
describe('filtering the inbox by module', () => {
  it('shows only the threads on that module', async () => {
    const rows = await listConversations({
      userId: admin, isAdmin: true, filter: 'all', module: 'leads',
    });
    const handles = rows.map((row) => row.handle);
    expect(handles).toContain(ON_A_LEAD);
    expect(handles).not.toContain(QUEUE);
  });

  it('leaves a thread nobody has linked out of every module', async () => {
    const rows = await listConversations({
      userId: admin, isAdmin: true, filter: 'all', module: 'properties',
    });
    expect(rows.map((row) => row.handle)).not.toContain(ON_A_LEAD);
    expect(rows.map((row) => row.handle)).not.toContain(QUEUE);
  });

  it('still shows everything when no module is named', async () => {
    const rows = await listConversations({ userId: admin, isAdmin: true, filter: 'all' });
    const handles = rows.map((row) => row.handle);
    expect(handles).toContain(ON_A_LEAD);
    expect(handles).toContain(QUEUE);
  });
});
