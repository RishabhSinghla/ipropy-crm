/**
 * The send path, run for real against the real tables.
 *
 * The owner pressed Send on an approved template on 20 September and got
 * *"Unknown field referenced in the request"* — Postgres 42703, wearing the
 * error handler's clothes. The opt-out check asked `ipy_channel_optout` for an
 * `id` column, and that table is keyed on `(handle, channel)` and has never
 * had one.
 *
 * **It survived because nothing ever ran it.** The composer has never been
 * opened against a live provider, and every other test that calls
 * `sendOnBusinessNumber` expects it to refuse *earlier* — at "no provider is
 * switched on" — so the first thing to reach this line was a customer waiting
 * for a message. So this file switches a provider on, which is the only way to
 * get past that guard and make the queries actually execute.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { sendOnBusinessNumber } from '../../src/integrations/whatsapp/business/send.js';
import { invalidate as reloadIntegrations } from '../../src/core/settings/integrations.js';
import { adminContext } from './fixtures.js';

const stamp = Date.now();
const OPTED_OUT = `91${String(stamp).slice(-10)}`;
let userId = '';

beforeAll(async () => {
  userId = (await adminContext()).user.id;

  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_integration WHERE provider = 'whatsapp_whatsmarketing'`,
  );
  if (existing) {
    await db.query(`UPDATE ipy_integration SET is_active = true WHERE id = $1`, [existing.id]);
  } else {
    await db.query(
      `INSERT INTO ipy_integration (provider, kind, label, is_active, config, credentials)
       VALUES ('whatsapp_whatsmarketing', 'whatsapp', 'whatsmarketing.in', true, '{}'::jsonb, '{}'::jsonb)`,
    );
  }
  await reloadIntegrations();

  await db.query(
    `INSERT INTO ipy_channel_optout (handle, channel) VALUES ($1, 'whatsapp')
     ON CONFLICT DO NOTHING`,
    [OPTED_OUT],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_channel_optout WHERE handle = $1`, [OPTED_OUT]);
  await db.query(`UPDATE ipy_integration SET is_active = false WHERE provider = 'whatsapp_whatsmarketing'`);
  await reloadIntegrations();
  await db.query(`DELETE FROM ipy_conversation WHERE handle LIKE $1`, [`%${String(stamp).slice(-8)}%`]);
});

describe('sending on the business number', () => {
  it('reads the opt-out list without asking for a column it does not have', async () => {
    /*
      The assertion that matters is the *shape* of the refusal. "This person
      has opted out" means the query ran; anything mentioning an unknown field
      means it did not, and a customer would have been told nothing at all.
    */
    await expect(sendOnBusinessNumber({
      userId, to: OPTED_OUT, text: 'hello',
    })).rejects.toThrow(/opted out/i);
  });

  it('gets past the opt-out check for everybody else', async () => {
    /*
      A number nobody has opted out of reaches the *next* rule — WhatsApp's
      24-hour window, which is shut because this conversation has never had an
      inbound message. Reaching that refusal is the proof: the opt-out query
      ran and answered no.

      **The number carries its country code**, and that is the point of this
      line rather than an incidental detail. Ten digits is a matching key, not
      a destination, and `sendOnBusinessNumber` now refuses a number it cannot
      dial *before* it looks at the window — see the case below. Writing this
      one with a bare ten digits is what made it pass for the wrong reason
      until 20 September 2026.
    */
    await expect(sendOnBusinessNumber({
      // A different number in its **last ten digits**, which is what the
      // opt-out list matches on — a different prefix alone is the same person.
      userId, to: `917${String(stamp + 7).slice(-9)}`, text: 'hello',
    })).rejects.toThrow(/24-hour window/);
  });

  it('refuses a number it cannot dial, rather than guessing at +91', async () => {
    /*
      Ten digits and no record to read a country code off. WhatsApp reads ten
      digits as a different person from the one who wrote in, which is how
      every free-text reply this CRM ever attempted came back as "outside the
      24-hour window" while the window was plainly open.

      The refusal has to name the missing country code. Assuming +91 would send
      an NRI buyer's message to a stranger in India, and that cannot be taken
      back.
    */
    await expect(sendOnBusinessNumber({
      userId, to: `7${String(stamp + 9).slice(-9)}`, text: 'hello',
    })).rejects.toThrow(/country code/i);
  });
});
