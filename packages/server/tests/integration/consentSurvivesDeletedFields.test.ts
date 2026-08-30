/**
 * Consent checks, when the consent fields have been deleted.
 *
 * `do_not_call`, `do_not_whatsapp` and `email_opt_out` were removed from the
 * leads module on 11 August. Three pieces of code still named them as columns,
 * and naming a dropped column is a Postgres 42703.
 *
 * The two failures were different, and only one of them was loud:
 *
 *  * **Do Not Call threw, uncaught.** The check sits before the try block in
 *    `clickToCall`, so every click-to-call returned a 500 — including calls to
 *    people who had never asked not to be called. It failed closed, which is the
 *    safe direction, but as an error rather than as a rule.
 *  * **The WhatsApp mirror was caught and swallowed.** The opt-out itself kept
 *    working, because `ipy_channel_optout` is the actual record of consent and
 *    `maySend` reads that. What stopped was the copy onto the lead record — so
 *    the flag quietly disappeared from the CRM while enforcement carried on.
 *    Nobody would notice until they filtered for it.
 *
 * These run against a real Postgres because the whole bug is a real Postgres
 * error, and a mock would have reported success for both.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';

const CONSENT_FIELDS = ['do_not_call', 'do_not_whatsapp', 'email_opt_out'] as const;
const restore: string[] = [];

beforeAll(async () => {
  // If a field happens to exist in this database, drop it for the suite so the
  // test exercises the state production is actually in.
  for (const name of CONSENT_FIELDS) {
    const column = await db.queryOne(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ipy_e_leads' AND column_name = $1`,
      [name],
    );
    if (column) {
      restore.push(name);
      await db.query(`ALTER TABLE ipy_e_leads DROP COLUMN ${name}`);
    }
  }
});

afterAll(async () => {
  for (const name of restore) {
    await db.query(`ALTER TABLE ipy_e_leads ADD COLUMN IF NOT EXISTS ${name} BOOLEAN DEFAULT false`);
  }
});

describe('reading consent when the field is gone', () => {
  it('does not throw looking up Do Not Call', async () => {
    /*
      The exact query `clickToCall` runs. It used to name the column directly and
      threw 42703 before the try block, so every call failed.
    */
    const lead = await db.queryOne<{ record_id: string }>(`SELECT record_id FROM ipy_e_leads LIMIT 1`);
    if (!lead) return;

    await expect(db.queryOne<{ blocked: boolean }>(
      `SELECT COALESCE((to_jsonb(l)->>'do_not_call')::boolean, false) AS blocked
         FROM ipy_e_leads l WHERE l.record_id = $1`,
      [lead.record_id],
    )).resolves.toMatchObject({ blocked: false });
  });

  it('treats an absent field as nothing recorded, not as blocked', async () => {
    // The honest direction. No field means nobody has asked not to be called, so
    // the call goes through — rather than silently blocking every number.
    const rows = await db.query<{ blocked: boolean }>(
      `SELECT COALESCE((to_jsonb(l)->>'do_not_call')::boolean, false) AS blocked FROM ipy_e_leads l LIMIT 5`,
    );
    for (const row of rows.rows) expect(row.blocked).toBe(false);
  });

  it('starts working again the moment the field comes back', async () => {
    /*
      The point of reading it as JSON rather than guarding the feature off. If
      the owner restores the field, consent enforcement resumes with no code
      change — which is what makes this safe to ship without deciding for him.
    */
    await db.query(`ALTER TABLE ipy_e_leads ADD COLUMN do_not_call BOOLEAN DEFAULT false`);
    try {
      const lead = await db.queryOne<{ record_id: string }>(`SELECT record_id FROM ipy_e_leads LIMIT 1`);
      if (!lead) return;
      await db.query(`UPDATE ipy_e_leads SET do_not_call = true WHERE record_id = $1`, [lead.record_id]);

      const dnc = await db.queryOne<{ blocked: boolean }>(
        `SELECT COALESCE((to_jsonb(l)->>'do_not_call')::boolean, false) AS blocked
           FROM ipy_e_leads l WHERE l.record_id = $1`,
        [lead.record_id],
      );
      expect(dnc?.blocked, 'a restored field must be read again').toBe(true);
    } finally {
      await db.query(`ALTER TABLE ipy_e_leads DROP COLUMN IF EXISTS do_not_call`);
    }
  });
});

describe('what still enforces consent', () => {
  it('keeps the opt-out record in its own table, not on the lead', async () => {
    /*
      This is why the WhatsApp failure was survivable. `ipy_channel_optout` is
      the record of consent and `maySend` reads it, so somebody who replied STOP
      stayed blocked throughout — even while the copy on the lead record was
      failing every time.
    */
    const table = await db.queryOne(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'ipy_channel_optout'`,
    );
    expect(table, 'consent must not live only on a deletable field').toBeTruthy();

    const { isOptedOut, recordConsent } = await import('../../src/integrations/whatsapp/consent.js');

    /*
      Recorded through the real path rather than by inserting a row. The lookup
      normalises a handle to E.164 first, so a hand-written row in the wrong
      format is findable by nothing — which would make this test pass against a
      broken system and fail against a working one.
    */
    await recordConsent({ handle: '+919000000001', action: 'opt_out', source: 'manual' });
    try {
      expect(await isOptedOut('+919000000001'), 'somebody who opted out stays blocked').toBe(true);
      expect(await isOptedOut('+919000000002')).toBe(false);
    } finally {
      await recordConsent({ handle: '+919000000001', action: 'opt_in', source: 'manual' });
      await db.query(`DELETE FROM ipy_consent_event WHERE handle LIKE '%919000000001'`);
    }
  });
});
