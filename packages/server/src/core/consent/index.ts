/**
 * Who has asked not to be contacted, on which channel.
 *
 * There was one of these for WhatsApp and nothing for anything else, which is
 * how the CRM ended up unable to honour a do-not-call request at all. The
 * mechanism was always channel-shaped — `ipy_channel_optout` is keyed
 * `(handle, channel)` — it was simply only ever written with `'whatsapp'`.
 *
 * Three channels now share this one store, because the alternative is three
 * implementations that drift, and the last time consent lived in more than one
 * place two of the copies quietly stopped working for three weeks.
 *
 * Why not a flag on the lead: someone can text STOP from a number the CRM holds
 * no record for, and that still has to be honoured. A handle is the thing a
 * request actually arrives about; a record is not always there to hang it on.
 * `leads.do_not_call`, `do_not_whatsapp` and `email_opt_out` were all deleted on
 * 11 August, so nothing here depends on a column that an admin can remove.
 *
 * `ipy_consent_event` keeps the trail beside it. "We did not contact them" is a
 * claim that may have to be evidenced to TRAI or under DPDP, and a boolean
 * cannot say when or why it changed.
 */
import { toE164 } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';

export type ConsentChannel = 'whatsapp' | 'call' | 'email';

/**
 * Email addresses are compared lowercased; phone numbers go through `toE164`.
 *
 * `toE164` returns null for anything it cannot parse, and falling back to the
 * raw string keeps an odd number comparable with itself. A null would match
 * nothing, which reads as "not opted out" and sends to precisely the person who
 * asked us not to.
 */
export function normaliseHandle(handle: string, channel: ConsentChannel): string {
  if (channel === 'email') return handle.trim().toLowerCase();
  return toE164(handle) ?? handle.trim();
}

/** True when this handle must not be contacted on this channel. */
export async function isOptedOut(
  handle: string,
  channel: ConsentChannel,
  conn: Tx = db,
): Promise<boolean> {
  const row = await conn.queryOne<{ handle: string }>(
    `SELECT handle FROM ipy_channel_optout WHERE handle = $1 AND channel = $2`,
    [normaliseHandle(handle, channel), channel],
  );
  return Boolean(row);
}

/** Bulk variant, so a broadcast does one query rather than one per recipient. */
export async function filterOptedOut(
  handles: string[],
  channel: ConsentChannel,
  conn: Tx = db,
): Promise<Set<string>> {
  if (!handles.length) return new Set();
  const rows = await conn.query<{ handle: string }>(
    `SELECT handle FROM ipy_channel_optout
      WHERE channel = $1 AND handle = ANY($2::text[])`,
    [channel, handles.map((h) => normaliseHandle(h, channel))],
  );
  return new Set(rows.rows.map((r) => r.handle));
}

/**
 * Record an opt-out or opt-in, and leave an audit row either way.
 *
 * Idempotent on purpose: the same person can say stop twice, and a request that
 * errors the second time is a request that looks unhonoured.
 */
export async function recordConsent(input: {
  handle: string;
  channel: ConsentChannel;
  action: 'opt_out' | 'opt_in';
  source?: 'keyword' | 'manual' | 'import' | 'api' | 'call_disposition';
  messageText?: string | null;
  recordId?: string | null;
}, conn: Tx = db): Promise<void> {
  const handle = normaliseHandle(input.handle, input.channel);

  if (input.action === 'opt_out') {
    await conn.query(
      `INSERT INTO ipy_channel_optout (handle, channel) VALUES ($1,$2)
       ON CONFLICT (handle, channel) DO NOTHING`,
      [handle, input.channel],
    );
  } else {
    await conn.query(
      `DELETE FROM ipy_channel_optout WHERE handle = $1 AND channel = $2`,
      [handle, input.channel],
    );
  }

  await conn.query(
    `INSERT INTO ipy_consent_event (record_id, handle, channel, action, source, message_text)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.recordId ?? null,
      handle,
      input.channel,
      input.action,
      input.source ?? 'manual',
      input.messageText ?? null,
    ],
  );
}
