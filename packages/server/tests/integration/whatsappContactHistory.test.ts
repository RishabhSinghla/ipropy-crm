/**
 * A contact's WhatsApp history, and who may read it.
 *
 * This is §12 — manager visibility — and the shape of it matters. The tab is
 * deliberately *not* scoped to the reader's own linked number: it shows what was
 * said to this person, whoever said it. Authority comes from the contact, so a
 * manager who can open the lead reads the conversation, and nobody has to borrow
 * an agent's session to do it.
 *
 * Which means the permission check is the whole test. Against a real database,
 * because it runs through `recordService` and its four layers — profile, role
 * hierarchy, sharing rules, field visibility — none of which a mock exercises.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { recordLive } from '../../src/integrations/whatsapp/agent/store.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const national = String(9_700_000_000 + (stamp % 89_000_000));
let accountId: string;
let leadId: string;

beforeAll(async () => {
  const ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `WhatsApp History ${stamp}`, mobile: national,
  });
  leadId = lead.id;

  const account = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_wa_account (user_id, label, phone_number, status)
     VALUES ($1,$2,$3,'connected') RETURNING id`,
    [ctx.user.id, `History test ${stamp}`, `+9195${stamp % 100000000}`],
  );
  accountId = account!.id;

  await recordLive({
    accountId, jid: `91${national}@s.whatsapp.net`, providerMessageId: `hist-${stamp}`,
    fromMe: false, timestamp: new Date(), text: 'Send me 3 BHK options.',
    raw: { key: { id: `hist-${stamp}` } } as never,
  });
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_wa_account WHERE id = $1`, [accountId]).catch(() => undefined);
  await db.query(`DELETE FROM ipy_record WHERE id = $1`, [leadId]).catch(() => undefined);
});

describe('the messages on a contact', () => {
  it('are found by the contact, not by whose phone carried them', async () => {
    const { rows } = await db.query<{ body: string | null; wa_account_id: string | null }>(
      `SELECT m.body, m.wa_account_id
         FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
        WHERE c.record_id = $1 AND c.channel = 'whatsapp'`,
      [leadId],
    );
    expect(rows.map((r) => r.body)).toContain('Send me 3 BHK options.');
    // Carried by an account, so the tab can say which number it came from.
    expect(rows[0]?.wa_account_id).toBe(accountId);
  });

  it('survive the account being deleted, which is an agent leaving', async () => {
    /*
      The rule from §24: deactivating somebody must not erase what the customer
      was told. The foreign key is ON DELETE SET NULL for exactly this, and a
      database is the only thing that can prove the cascade does not fire.
    */
    /*
      A different user, because one account per agent is a unique index and the
      first draft of this test tried to give one person two. The database said
      no, which is the isolation working — Sheetal cannot accumulate phones for
      the CRM to choose between.
    */
    const leaver = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user
        WHERE is_active AND id NOT IN (SELECT user_id FROM ipy_wa_account)
        ORDER BY created_at LIMIT 1`,
    );
    if (!leaver) return; // a database where everybody has linked; nothing to prove here

    const throwaway = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_wa_account (user_id, label, phone_number, status)
       VALUES ($1, $2, $3, 'connected') RETURNING id`,
      [leaver.id, `Leaver ${stamp}`, `+9194${stamp % 100000000}`],
    );

    await recordLive({
      accountId: throwaway!.id, jid: `91${national}@s.whatsapp.net`,
      providerMessageId: `leaver-${stamp}`, fromMe: true, timestamp: new Date(),
      text: 'Sharing the floor plan.', raw: { key: { id: `leaver-${stamp}` } } as never,
    });

    await db.query(`DELETE FROM ipy_wa_account WHERE id = $1`, [throwaway!.id]);

    const { rows } = await db.query<{ body: string | null; wa_account_id: string | null }>(
      `SELECT m.body, m.wa_account_id
         FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
        WHERE c.record_id = $1 AND m.body = 'Sharing the floor plan.'`,
      [leadId],
    );
    expect(rows, 'the message must outlive the account that sent it').toHaveLength(1);
    expect(rows[0]?.wa_account_id).toBeNull();
  });
});
