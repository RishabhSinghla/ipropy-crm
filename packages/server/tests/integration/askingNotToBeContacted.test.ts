/**
 * When somebody asks not to be contacted, it is recorded and it is obeyed.
 *
 * All three channels were broken in different ways, and all three were silent
 * about it:
 *
 *  * **Calls.** Marking a call "Do Not Call" ran
 *    `UPDATE ipy_e_leads SET do_not_call = true`. That column was deleted on
 *    11 August, so the statement was a Postgres 42703 with no guard and no
 *    catch. The rep got a 500 and the request was stored nowhere. The read gate
 *    meanwhile asked for the same dead field through `to_jsonb`, which is always
 *    null, so it blocked nobody while looking like a check.
 *  * **Email.** No suppression of any kind. Not a check, not a store. An
 *    unsubscribe had nowhere to go.
 *  * **WhatsApp.** Genuinely enforced throughout, via `ipy_channel_optout`.
 *    That is the mechanism the other two now share.
 *
 * These are legal obligations, not preferences — TRAI for the dialler, DPDP for
 * withdrawal of consent — so they are tested against a real database rather than
 * asserted about a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { filterOptedOut, isOptedOut, recordConsent } from '../../src/core/consent/index.js';

const CALLER = '+919811590101';
const EMAIL = 'optout-test@example.com';

async function wipe() {
  await db.query(
    `DELETE FROM ipy_channel_optout WHERE handle = ANY($1::text[])`,
    [[CALLER, EMAIL]],
  );
  await db.query(
    `DELETE FROM ipy_consent_event WHERE handle = ANY($1::text[])`,
    [[CALLER, EMAIL]],
  );
}

beforeAll(wipe);
afterAll(wipe);

describe('a request not to be contacted', () => {
  it('is stored when a rep marks a call Do Not Call', async () => {
    expect(await isOptedOut(CALLER, 'call')).toBe(false);

    await recordConsent({
      handle: CALLER, channel: 'call', action: 'opt_out', source: 'call_disposition',
    });

    expect(
      await isOptedOut(CALLER, 'call'),
      'the whole point of the disposition is that the next call is refused',
    ).toBe(true);
  });

  it('leaves a trail that says when and how', async () => {
    // "We did not call them" may have to be evidenced. A boolean cannot.
    const row = await db.queryOne<{ action: string; source: string; channel: string }>(
      `SELECT action, source, channel FROM ipy_consent_event
        WHERE handle = $1 ORDER BY created_at DESC LIMIT 1`,
      [CALLER],
    );
    expect(row?.action).toBe('opt_out');
    expect(row?.source).toBe('call_disposition');
    expect(row?.channel).toBe('call');
  });

  it('does not leak across channels', async () => {
    /*
      Somebody who does not want phone calls may be perfectly happy on WhatsApp.
      One global opt-out was explicitly rejected in the design, and treating a
      call request as a WhatsApp request would lose contact people never asked
      to end.
    */
    expect(await isOptedOut(CALLER, 'whatsapp')).toBe(false);
    expect(await isOptedOut(CALLER, 'email')).toBe(false);
  });

  it('can be reversed if they change their mind', async () => {
    await recordConsent({ handle: CALLER, channel: 'call', action: 'opt_in', source: 'manual' });
    expect(await isOptedOut(CALLER, 'call')).toBe(false);

    // Put it back for the remaining cases.
    await recordConsent({ handle: CALLER, channel: 'call', action: 'opt_out', source: 'manual' });
  });

  it('is not upset by the same request arriving twice', async () => {
    // Somebody can say stop twice, and a second request that errors is a
    // request that looks unhonoured.
    await recordConsent({ handle: CALLER, channel: 'call', action: 'opt_out', source: 'manual' });
    expect(await isOptedOut(CALLER, 'call')).toBe(true);
  });

  it('recognises the same number written differently', async () => {
    // A rep types 9811590101, the provider reports +919811590101. Same person.
    expect(await isOptedOut('9811590101', 'call')).toBe(true);
  });

  it('removes an unsubscribed address from an email send', async () => {
    await recordConsent({ handle: EMAIL, channel: 'email', action: 'opt_out', source: 'manual' });

    const blocked = await filterOptedOut(['someone@example.com', EMAIL], 'email');
    expect(blocked.has(EMAIL)).toBe(true);
    expect(blocked.has('someone@example.com')).toBe(false);
  });

  it('matches an email address whatever case it was typed in', async () => {
    expect(await isOptedOut('OptOut-Test@Example.COM', 'email')).toBe(true);
  });
});

describe('the fields this replaced', () => {
  it('does not offer the three deleted fields anywhere in the CRM', async () => {
    /*
      The reason all three channels broke at once: consent lived on the lead
      record, and the three columns holding it were deleted in one go on
      11 August. The store is keyed by handle now, so a deletion like that
      cannot repeat.

      What is checked is field *metadata*, not the raw column. Migration 002
      created the columns and migrations are forward-only, so on a brand new
      database they still exist — but with no `ipy_field` row they are invisible,
      unreadable through the API and unwritable through it too. Dropping them
      outright would be a destructive migration for no gain. What matters is that
      the seed stopped recreating the metadata, because a fresh install was
      otherwise handing the owner back three fields he had removed.
    */
    const offered = await db.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM ipy_field f
         JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = 'leads'
          AND f.name IN ('do_not_call','do_not_whatsapp','email_opt_out')`,
    );
    expect(
      Number(offered?.n),
      'these were deleted on purpose; the seed must not put them back on a fresh install',
    ).toBe(0);

    // And the consent path works without them, which is the whole point.
    expect(await isOptedOut(CALLER, 'call')).toBe(true);
  });

  it('no code writes those columns by name any more', async () => {
    const { execSync } = await import('node:child_process');
    const root = new URL('../../src/', import.meta.url).pathname;
    // Comment lines are skipped, since the fix itself quotes the statement it
    // replaced in order to explain why.
    const hits = execSync(
      `grep -rn --include='*.ts' -E "SET (do_not_call|do_not_whatsapp|email_opt_out)" ${root} `
      + `| grep -vE ':[[:space:]]*(\\*|//|/\\*)' || true`,
      { encoding: 'utf8' },
    ).trim();

    expect(
      hits,
      'naming a dropped column is a 42703 on the whole statement, which is how '
      + 'a do-not-call request came to be neither stored nor obeyed',
    ).toBe('');
  });
});
