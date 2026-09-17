/**
 * What happens to a WhatsApp conversation nobody recognises.
 *
 * The specification's rule: never silently create a second contact. So an
 * unknown number waits to be claimed, and the three ways out of that state all
 * have to work against a real database — two of them write to `ipy_record`
 * through the CRM's own engine, and the third has to make the conversation stop
 * asking without throwing away what a customer said.
 *
 * The isolation is tested here too. An agent must not be able to resolve a
 * conversation on somebody else's linked account, however the request is
 * shaped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { recordLive } from '../../src/integrations/whatsapp/agent/store.js';
import { createContact, ignore, linkExisting, listUnmatched } from '../../src/integrations/whatsapp/agent/claim.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const stranger = String(9_400_000_000 + (stamp % 89_000_000));
const knownNumber = String(9_500_000_000 + (stamp % 89_000_000));

let accountId: string;
let otherAccountId: string;
let otherUserId: string;
let userId: string;
const madeRecords: string[] = [];

const live = (national: string, id: string, text: string, onAccount = accountId) => ({
  accountId: onAccount, jid: `91${national}@s.whatsapp.net`, providerMessageId: id,
  fromMe: false, timestamp: new Date(), text, raw: { key: { id } } as never,
});

beforeAll(async () => {
  const ctx = await adminContext();
  userId = ctx.user.id;

  const account = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_account (user_id, label, phone_number, status)
     VALUES ($1,$2,$3,'connected') RETURNING id`,
    [userId, `Claim test ${stamp}`, `+9197${stamp % 100000000}`],
  );
  accountId = account!.id;

  // A second agent, so "not yours" can be tested rather than assumed.
  const other = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_user WHERE id <> $1 AND is_active ORDER BY created_at LIMIT 1`,
    [userId],
  );
  otherUserId = other!.id;
  const otherAccount = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_account (user_id, label, phone_number, status)
     VALUES ($1,$2,$3,'connected') RETURNING id`,
    [otherUserId, `Claim test other ${stamp}`, `+9196${stamp % 100000000}`],
  );
  otherAccountId = otherAccount!.id;
});

afterAll(async () => {
  for (const id of [accountId, otherAccountId]) {
    await db.query(`DELETE FROM ipy_wa_account WHERE id = $1`, [id]).catch(() => undefined);
  }
  for (const id of madeRecords) {
    await db.query(`DELETE FROM ipy_record WHERE id = $1`, [id]).catch(() => undefined);
  }
});

async function conversationIdFor(national: string): Promise<string> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_conversation WHERE wa_account_id = $1 AND handle = $2`,
    [accountId, `+91${national}`],
  );
  return row!.id;
}

describe('an unknown number waiting to be claimed', () => {
  it('appears in the agent"s own unmatched list, and nobody else"s', async () => {
    await recordLive(live(stranger, `claim-${stamp}-1`, 'Hi, saw your board outside B-221.'));

    const mine = await listUnmatched(userId);
    expect(mine.map((c) => c.handle)).toContain(`+91${stranger}`);

    const theirs = await listUnmatched(otherUserId);
    expect(theirs.map((c) => c.handle)).not.toContain(`+91${stranger}`);
  });

  it('offers a contact that has appeared since the message arrived', async () => {
    /*
      Candidates are recomputed, not stored. A number that matched nobody on
      Monday may match somebody on Tuesday because a colleague added them — and
      offering that is the difference between one click and retyping a contact
      the CRM already has.
    */
    await recordLive(live(knownNumber, `claim-${stamp}-2`, 'Please share the floor plan.'));
    const ctx = await adminContext();
    const lead = await recordService.createRecord(ctx, 'leads', {
      full_name: `Appeared Later ${stamp}`, mobile: knownNumber,
    });
    madeRecords.push(lead.id);

    const entry = (await listUnmatched(userId)).find((c) => c.handle === `+91${knownNumber}`);
    expect(entry?.candidates.map((c) => c.recordId)).toContain(lead.id);
  });

  it('links to that contact, bringing the conversation with it', async () => {
    const conversationId = await conversationIdFor(knownNumber);
    const lead = (await listUnmatched(userId)).find((c) => c.handle === `+91${knownNumber}`)!.candidates[0]!;

    await linkExisting(userId, conversationId, lead.recordId);

    const row = await db.queryOne<{ record_id: string | null }>(
      `SELECT record_id FROM ipy_conversation WHERE id = $1`, [conversationId],
    );
    expect(row?.record_id).toBe(lead.recordId);
    expect((await listUnmatched(userId)).map((c) => c.handle)).not.toContain(`+91${knownNumber}`);
  });

  it('creates a contact through the CRM"s own engine, carrying the number over', async () => {
    const conversationId = await conversationIdFor(stranger);
    const ctx = await adminContext();

    const { recordId } = await createContact(ctx, conversationId, { full_name: `From WhatsApp ${stamp}` });
    madeRecords.push(recordId);

    // Through recordService, so it is an ordinary lead: audited, validated, and
    // holding the number nobody had to retype.
    const lead = await recordService.getRecord(ctx, 'leads', recordId);
    expect(lead.values.full_name).toBe(`From WhatsApp ${stamp}`);
    expect(String(lead.values.mobile)).toContain(stranger.slice(-10));

    expect((await listUnmatched(userId)).map((c) => c.handle)).not.toContain(`+91${stranger}`);
  });
});

describe('dismissing a conversation', () => {
  const junk = String(9_600_000_000 + (stamp % 89_000_000));

  it('stops it asking, without throwing away what was said', async () => {
    await recordLive(live(junk, `claim-${stamp}-3`, 'wrong number sorry'));
    const conversationId = await conversationIdFor(junk);

    await ignore(userId, conversationId);

    expect((await listUnmatched(userId)).map((c) => c.handle)).not.toContain(`+91${junk}`);
    const kept = await db.query(
      `SELECT id FROM ipy_message WHERE conversation_id = $1`, [conversationId],
    );
    expect(kept.rows.length).toBeGreaterThan(0);
  });
});

describe('another agent"s conversation', () => {
  it('cannot be linked, created from, or dismissed', async () => {
    await recordLive(live(stranger, `claim-${stamp}-4`, 'hello'), );
    const conversationId = await conversationIdFor(stranger);
    const ctx = await adminContext();

    await expect(linkExisting(otherUserId, conversationId, madeRecords[0]!)).rejects.toThrow(/not on your WhatsApp/i);
    await expect(ignore(otherUserId, conversationId)).rejects.toThrow(/not on your WhatsApp/i);
    await expect(
      createContact({ ...ctx, user: { ...ctx.user, id: otherUserId } }, conversationId, { full_name: 'Nope' }),
    ).rejects.toThrow(/not on your WhatsApp/i);
  });
});
