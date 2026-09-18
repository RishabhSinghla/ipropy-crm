/**
 * What the composer is allowed to know, and what it must not do.
 *
 * The WhatsApp icon sits beside every phone number in the CRM, so it is
 * clicked far more often than anything is sent. Three promises only a real
 * database can hold to:
 *
 *  * **Looking writes nothing.** A conversation row created on a glance would
 *    put an empty thread in the team's shared queue for every number anybody
 *    hovered over, and the queue is the one screen that has to mean something.
 *  * **The window is read from the row, not assumed.** WhatsApp carries a free
 *    reply for 24 hours after the customer last wrote; the composer offers a
 *    message box or a template list on the strength of this answer, so a wrong
 *    one is a rep typing a paragraph that cannot go.
 *  * **Messages need the record.** Without one the answer still says whether
 *    the window is open — enough to choose a control, nothing to read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { threadForNumber } from '../../src/integrations/whatsapp/business/thread.js';

const stamp = Date.now();
const SILENT = `9444${String(stamp).slice(-6)}`;
const TALKING = `9555${String(stamp).slice(-6)}`;
const STALE = `9666${String(stamp).slice(-6)}`;
const NOBODY = `9777${String(stamp).slice(-6)}`;

async function thread(handle: string, windowExpiresAt: string | null): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_conversation (channel, handle, window_expires_at, last_message_at)
     VALUES ('whatsapp', $1, $2::timestamptz, now())
     RETURNING id`,
    [handle, windowExpiresAt],
  );
  return row!.id;
}

beforeAll(async () => {
  await thread(SILENT, null);
  const talking = await thread(TALKING, new Date(Date.now() + 3_600_000).toISOString());
  await thread(STALE, new Date(Date.now() - 3_600_000).toISOString());

  for (const [index, body] of ['hi there', 'are you free saturday?'].entries()) {
    await db.query(
      `INSERT INTO ipy_message (conversation_id, direction, channel, type, body, status, route, created_at)
       VALUES ($1, 'inbound', 'whatsapp', 'text', $2, 'delivered', 'business', now() - ($3 || ' minutes')::interval)`,
      [talking, body, String(10 - index * 5)],
    );
  }
});

afterAll(async () => {
  await db.query(
    `DELETE FROM ipy_conversation WHERE handle IN ($1,$2,$3,$4)`,
    [SILENT, TALKING, STALE, NOBODY],
  );
});

describe('the number behind the WhatsApp icon', () => {
  it('creates nothing for a number with no conversation', async () => {
    const answer = await threadForNumber(NOBODY, true);

    expect(answer.conversationId).toBeNull();
    expect(answer.windowOpen).toBe(false);
    expect(answer.messages).toHaveLength(0);

    const row = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_conversation WHERE channel = 'whatsapp' AND handle = $1`,
      [NOBODY],
    );
    expect(row, 'looking at a number must not open a conversation').toBeNull();
  });

  it('says the window is open only while it really is', async () => {
    expect((await threadForNumber(TALKING, false)).windowOpen).toBe(true);
    // Expired an hour ago: only an approved template may go now.
    expect((await threadForNumber(STALE, false)).windowOpen).toBe(false);
    // Nobody has ever written in, so there was never a window to expire.
    expect((await threadForNumber(SILENT, false)).windowOpen).toBe(false);
  });

  it('hands back the last few lines, oldest first, only with the record', async () => {
    const withRecord = await threadForNumber(TALKING, true);
    expect(withRecord.messages.map((message) => message.body))
      .toEqual(['hi there', 'are you free saturday?']);

    const withoutRecord = await threadForNumber(TALKING, false);
    expect(withoutRecord.messages, 'no record, nothing to read').toHaveLength(0);
    expect(withoutRecord.windowOpen, 'the window is still answered').toBe(true);
  });

  it('matches the number however it is written on the screen', async () => {
    const spaced = await threadForNumber(`+91 ${TALKING.slice(0, 5)} ${TALKING.slice(5)}`, false);
    expect(spaced.conversationId).toBe((await threadForNumber(TALKING, false)).conversationId);
  });

  it('refuses something that is not a number at all', async () => {
    await expect(threadForNumber('not a phone', false)).rejects.toThrow(/number WhatsApp can reach/i);
  });
});
