/**
 * A WhatsApp message becoming part of the CRM, against a real database.
 *
 * Three things only a database can answer, and all three have a history in this
 * codebase. The message must attach to the contact whose number it is. The same
 * message arriving twice — a reconnect replaying a batch, a retry, a restart
 * mid-sync — must land once, which rests on a partial unique index that a mock
 * would happily ignore. And history from a number nobody knows must not reach a
 * table at all: that is the rep's private life, and it is why two previous
 * builds were torn out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { recordHistory, recordLive } from '../../src/integrations/whatsapp/agent/store.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const known = String(9_100_000_000 + (stamp % 89_000_000));
const stranger = String(9_200_000_000 + (stamp % 89_000_000));

let accountId: string;
let leadId: string;
let userId: string;

const jid = (national: string) => `91${national}@s.whatsapp.net`;

const live = (national: string, id: string, text: string, fromMe = false) => ({
  accountId, jid: jid(national), providerMessageId: id, fromMe,
  timestamp: new Date(), text, raw: { key: { id } } as never,
});

beforeAll(async () => {
  const ctx = await adminContext();
  userId = ctx.user.id;
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `WhatsApp Store ${stamp}`,
    mobile: known,
  });
  leadId = lead.id;

  const account = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_account (user_id, label, phone_number, status)
     VALUES ($1, $2, $3, 'connected') RETURNING id`,
    [userId, `Store test ${stamp}`, `+9198${stamp % 100000000}`],
  );
  accountId = account!.id;
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_wa_account WHERE id = $1`, [accountId]).catch(() => undefined);
  await db.query(`DELETE FROM ipy_record WHERE id = $1`, [leadId]).catch(() => undefined);
});

async function messagesFor(national: string): Promise<{ body: string | null; direction: string; record_id: string | null }[]> {
  const { rows } = await db.query<{ body: string | null; direction: string; record_id: string | null }>(
    `SELECT m.body, m.direction, c.record_id
       FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
      WHERE c.wa_account_id = $1 AND c.handle = $2
      ORDER BY m.created_at`,
    [accountId, `+91${national}`],
  );
  return rows;
}

describe('a message arriving now', () => {
  it('lands on the contact whose number it is', async () => {
    await recordLive(live(known, `live-${stamp}-1`, 'Looking for 3 BHK in Greenfields.'));
    const rows = await messagesFor(known);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: 'Looking for 3 BHK in Greenfields.', direction: 'inbound', record_id: leadId });
  });

  it('lands exactly once however many times it arrives', async () => {
    // A reconnect offers the same batch again. Without the unique index this is
    // three copies of one message in the customer's timeline.
    for (let i = 0; i < 3; i++) {
      await recordLive(live(known, `live-${stamp}-repeat`, 'Please arrange a visit.'));
    }
    const bodies = (await messagesFor(known)).filter((r) => r.body === 'Please arrange a visit.');
    expect(bodies).toHaveLength(1);
  });

  it('keeps a message from a number nobody knows, unattached, to be claimed', async () => {
    await recordLive(live(stranger, `live-${stamp}-2`, 'Hi, saw your listing.'));
    const rows = await messagesFor(stranger);
    expect(rows).toHaveLength(1);
    // Kept, because somebody is contacting the business — but filed against
    // nobody, because guessing puts a customer's words on a stranger.
    expect(rows[0]?.record_id).toBeNull();
  });
});

describe('history from the handshake after a scan', () => {
  it('is stored for a number the CRM already knows', async () => {
    await recordHistory({
      accountId,
      jid: jid(known),
      messages: [{ key: { id: `hist-${stamp}-1`, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000) - 86_400, message: { conversation: 'Sent last week' } }] as never,
    });
    const bodies = (await messagesFor(known)).map((r) => r.body);
    expect(bodies).toContain('Sent last week');
  });

  it('is refused entirely for a number the CRM has never seen', async () => {
    /*
      The whole reason this feature was removed twice. A linked phone offers the
      CRM the rep's mother, landlord and doctor; 821 of them the first time.
      Nothing about this conversation may reach a table.
    */
    const privateNumber = String(9_300_000_000 + (stamp % 89_000_000));
    await recordHistory({
      accountId,
      jid: jid(privateNumber),
      messages: [{ key: { id: `hist-${stamp}-private`, fromMe: false }, messageTimestamp: 1, message: { conversation: 'Beta, khana kha liya?' } }] as never,
    });

    expect(await messagesFor(privateNumber)).toHaveLength(0);
    const conversations = await db.query(
      `SELECT id FROM ipy_conversation WHERE wa_account_id = $1 AND handle = $2`,
      [accountId, `+91${privateNumber}`],
    );
    // Not even an empty conversation row: nothing at all.
    expect(conversations.rows).toHaveLength(0);
  });

  it('does not raise an unread count, because it is not new work', async () => {
    const row = await db.queryOne<{ unread_count: number }>(
      `SELECT unread_count FROM ipy_conversation WHERE wa_account_id = $1 AND handle = $2`,
      [accountId, `+91${known}`],
    );
    // Two live inbound messages above; the history one must not have added to it.
    expect(row?.unread_count).toBe(2);
  });
});
