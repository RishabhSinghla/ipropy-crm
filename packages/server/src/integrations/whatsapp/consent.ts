/**
 * WhatsApp consent.
 *
 * Meta's Business Messaging policy makes opt-out handling the operator's
 * responsibility, and the penalty lands on the phone number — restricted or
 * banned — not on the message. The number is the asset the whole channel is
 * built on, so this is checked on every outbound send rather than trusted to
 * whoever assembled the audience.
 *
 * Two stores, because they answer different questions:
 *
 *  * `ipy_channel_optout` is keyed by phone number and is the authority. Someone
 *    can text STOP from a number the CRM holds no record for, and that must
 *    still be honoured.
 *  * `leads.do_not_whatsapp` is the same fact on the record, so it shows up in
 *    list views, filters and segments where a salesperson will actually see it.
 *
 * `ipy_consent_event` keeps the trail. "We did not message them" is a claim you
 * may have to evidence, and a boolean cannot tell you when or why it changed.
 */
import { toE164 } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * Words that mean stop, in the forms Indian users actually send.
 *
 * Matched only when the message is essentially just the keyword — someone
 * writing "stop sending me the 2BHK, show me 3BHK" is asking for different
 * inventory, not asking to be removed, and unsubscribing them would be worse
 * than useless.
 */
const OPT_OUT_WORDS = ['stop', 'unsubscribe', 'optout', 'opt out', 'remove me', 'band karo', 'bandh karo', 'mat bhejo'];
const OPT_IN_WORDS = ['start', 'subscribe', 'optin', 'opt in', 'resume', 'yes'];

function isJustKeyword(text: string, words: string[]): boolean {
  const cleaned = text.trim().toLowerCase().replace(/[.!,]+$/, '');
  // A short message is a command; a long one containing the word is a sentence.
  if (cleaned.length > 24) return false;
  return words.some((w) => cleaned === w || cleaned === `${w}.`);
}

export function detectConsentKeyword(text: string | null | undefined): 'opt_out' | 'opt_in' | null {
  if (!text) return null;
  if (isJustKeyword(text, OPT_OUT_WORDS)) return 'opt_out';
  if (isJustKeyword(text, OPT_IN_WORDS)) return 'opt_in';
  return null;
}

/**
 * `toE164` returns null for anything it cannot parse. Falling back to the raw
 * string keeps an odd number comparable with itself — the alternative is a
 * null that matches nothing, which would quietly mean "not opted out" and send
 * to exactly the person who asked us not to.
 */
function normaliseHandle(handle: string): string {
  return toE164(handle) ?? handle.trim();
}

/** True when this number must not be messaged. */
export async function isOptedOut(handle: string, conn: Tx = db): Promise<boolean> {
  const normalised = normaliseHandle(handle);
  const row = await conn.queryOne<{ handle: string }>(
    `SELECT handle FROM ipy_channel_optout WHERE handle = $1 AND channel = 'whatsapp'`,
    [normalised],
  );
  return Boolean(row);
}

/** Bulk variant, so a broadcast does one query rather than one per recipient. */
export async function filterOptedOut(handles: string[], conn: Tx = db): Promise<Set<string>> {
  if (!handles.length) return new Set();
  const normalised = handles.map(normaliseHandle);
  const rows = await conn.query<{ handle: string }>(
    `SELECT handle FROM ipy_channel_optout WHERE channel = 'whatsapp' AND handle = ANY($1::text[])`,
    [normalised],
  );
  return new Set(rows.rows.map((r) => r.handle));
}

export async function recordConsent(input: {
  handle: string;
  action: 'opt_out' | 'opt_in';
  source?: 'keyword' | 'manual' | 'import' | 'api';
  messageText?: string | null;
  recordId?: string | null;
}, conn: Tx = db): Promise<void> {
  const handle = normaliseHandle(input.handle);

  if (input.action === 'opt_out') {
    await conn.query(
      `INSERT INTO ipy_channel_optout (handle, channel) VALUES ($1,'whatsapp')
       ON CONFLICT (handle, channel) DO NOTHING`,
      [handle],
    );
  } else {
    await conn.query(`DELETE FROM ipy_channel_optout WHERE handle = $1 AND channel = 'whatsapp'`, [handle]);
  }

  // Mirror onto the record so it is visible and filterable where people work.
  // Matched on the last ten digits for the same reason sign-in is: the same
  // number exists in several formats across imported data.
  await conn.query(
    `UPDATE ipy_e_leads SET do_not_whatsapp = $2
     WHERE right(regexp_replace(coalesce(mobile,''), '\\D', '', 'g'), 10) = right($1, 10)
        OR right(regexp_replace(coalesce(whatsapp_number,''), '\\D', '', 'g'), 10) = right($1, 10)`,
    [handle.replace(/\D/g, ''), input.action === 'opt_out'],
  ).catch((err) => logger.warn({ err }, 'could not mirror consent onto lead records'));

  await conn.query(
    `INSERT INTO ipy_consent_event (record_id, handle, channel, action, source, message_text)
     VALUES ($1,$2,'whatsapp',$3,$4,$5)`,
    [input.recordId ?? null, handle, input.action, input.source ?? 'keyword', input.messageText ?? null],
  );

  logger.info({ handle: `${handle.slice(0, 5)}…`, action: input.action, source: input.source }, 'WhatsApp consent changed');
}

/**
 * Whether a given send is allowed to proceed.
 *
 * A reply inside an open 24-hour session is exempt: the person messaged *us*,
 * and refusing to answer someone who just asked a question is not what opting
 * out of marketing means. Everything else — templates, broadcasts, workflow
 * nudges — is blocked.
 */
export async function maySend(handle: string, opts: { sessionReply?: boolean } = {}): Promise<{ allowed: boolean; reason?: string }> {
  if (opts.sessionReply) return { allowed: true };
  if (await isOptedOut(handle)) {
    return { allowed: false, reason: 'This number has opted out of WhatsApp messages.' };
  }
  return { allowed: true };
}
