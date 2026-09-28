/**
 * The Truecaller listening door.
 *
 * Truecaller's mobile-web documentation has not been updated in six years and
 * could not be read from the machine this was written on, so rather than guess
 * at the shape of a delivery — the mistake that cost four separate bugs on the
 * WhatsMarketing adapter — this records exactly what arrives and creates
 * nothing at all.
 *
 * It writes to `ipy_lead_inbox`, the same table every other inbound source
 * already uses, so there is one place to look for "something arrived from
 * outside" and so these rows become ordinary captures the day the real
 * integration is written. `status` stays `pending`: nothing has been turned
 * into a lead, and nothing will be until the delivery can be proved to have
 * come from Truecaller.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

export const TRUECALLER_SOURCE = 'truecaller';

/** Enough to hold a profile many times over, small enough that a flood cannot bloat the table. */
const MAX_STORED_BYTES = 16 * 1024;

/** How many deliveries are kept. This is a diagnostic log, not a record of the business. */
const KEEP_RECENT = 50;

/**
 * Headers that are a credential and nothing else.
 *
 * Everything else is kept — a signature header is the whole point of this
 * exercise, and it is always one of the `x-…` names nobody can predict from
 * here. A third party's payload has already carried a live access token into a
 * log once in this repo; assume the next one does too, and drop the two that
 * can only ever be secrets.
 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

export function withoutCredentialHeaders(headers: Record<string, unknown>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) continue;
    safe[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  }
  return safe;
}

/**
 * The delivery, shrunk to something a table can hold.
 *
 * A payload too big to store is replaced by a note saying so rather than
 * dropped, because "nothing arrived" and "something arrived that was too big"
 * look identical afterwards and mean opposite things.
 */
export function trimmedToFit(delivery: unknown): unknown {
  const json = JSON.stringify(delivery) ?? 'null';
  if (json.length <= MAX_STORED_BYTES) return delivery;
  return { tooLargeToStore: true, bytes: json.length, firstPart: json.slice(0, MAX_STORED_BYTES) };
}

/**
 * Store one delivery. Never throws.
 *
 * The caller has already answered 200 — every provider retries anything it
 * does not hear a prompt 200 for, and a retry storm caused by a full disk is
 * a worse problem than a delivery nobody recorded.
 */
export async function recordTruecallerDelivery(input: {
  method: string;
  query: unknown;
  headers: Record<string, unknown>;
  body: unknown;
}): Promise<void> {
  try {
    const delivery = trimmedToFit({
      method: input.method,
      query: input.query ?? {},
      headers: withoutCredentialHeaders(input.headers),
      body: input.body ?? null,
    });

    await db.query(
      `INSERT INTO ipy_lead_inbox (source, raw_payload, normalized, status, error)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [
        TRUECALLER_SOURCE,
        JSON.stringify(delivery),
        JSON.stringify({}),
        'Recorded only — the Truecaller integration is not finished, so no lead was created.',
      ],
    );

    // Bounded on the way in rather than by a sweeper nobody remembers to run.
    await db.query(
      `DELETE FROM ipy_lead_inbox
        WHERE source = $1
          AND id NOT IN (
            SELECT id FROM ipy_lead_inbox WHERE source = $1 ORDER BY received_at DESC LIMIT $2
          )`,
      [TRUECALLER_SOURCE, KEEP_RECENT],
    );
  } catch (err) {
    logger.error({ err }, 'could not record a Truecaller delivery');
  }
}
