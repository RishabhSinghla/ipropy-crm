/**
 * One property, one link, one person.
 *
 * The last step of the chain that starts at a gate: photos arrive, group
 * themselves, get named — and then somebody has to send them to a buyer. Until
 * now that meant selecting forty images in WhatsApp, or downloading a zip and
 * attaching it to an email nobody opens on a phone.
 *
 * A share link is not the website. `/api/public/properties` is a catalogue of
 * units that are 'Available' and published; a floor shot this morning is a
 * draft, and it is precisely the one worth sending. The two have different
 * jobs, so they get different doors.
 *
 * What guards it is the token and nothing else, which is a deliberate choice
 * and the reason the token is 16 random bytes rather than a readable slug. A
 * buyer will open this on a phone, forward it to their spouse, and open it
 * again a week later; anything requiring a login would simply not be used, and
 * a feature nobody uses protects nothing.
 */
import { randomBytes } from 'node:crypto';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * 16 bytes, base64url — 22 characters, 128 bits.
 *
 * Not guessable at any rate an attacker could sustain, and short enough that
 * the whole URL still fits on one line of a WhatsApp message, which is the only
 * place it will ever be pasted.
 */
export function mintToken(): string {
  return randomBytes(16).toString('base64url');
}

export interface ShareLink {
  id: string;
  recordId: string;
  token: string;
  label: string | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  viewCount: number;
  lastViewedAt: Date | null;
  /*
    What this link shows: one record, or a set of matches picked off a record's
    matching tab.

    'record' is the default and what every link issued before migration 136 is,
    so nothing already sent changes meaning.
  */
  kind: 'record' | 'matches';
  /** For a 'matches' link: `{ targetModule, ids }`. Null on a record link. */
  payload: { targetModule: string; ids: string[] } | null;
}

interface Row {
  id: string;
  record_id: string;
  token: string;
  label: string | null;
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  view_count: number;
  last_viewed_at: Date | null;
  kind: 'record' | 'matches';
  payload: { targetModule: string; ids: string[] } | null;
}

const COLUMNS = `id, record_id, token, label, created_by, created_at,
                 expires_at, revoked_at, view_count, last_viewed_at, kind, payload`;

function toLink(row: Row): ShareLink {
  return {
    id: row.id,
    recordId: row.record_id,
    token: row.token,
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    viewCount: row.view_count,
    lastViewedAt: row.last_viewed_at,
    kind: row.kind,
    payload: row.payload,
  };
}

export interface CreateShareInput {
  recordId: string;
  userId: string;
  /** Omitted means a plain one-record link, which is what most of them are. */
  kind?: 'record' | 'matches';
  payload?: { targetModule: string; ids: string[] } | null;
  /** Who it is going to — the sender's own note, never shown to the visitor. */
  label?: string | null;
  expiresAt?: Date | null;
}

/**
 * Mint a link.
 *
 * Always a new one, even for the same property and the same label. Reusing a
 * link across two buyers would make the view count meaningless, which is the
 * only thing it is for — and revoking it for one person would revoke it for
 * both.
 */
export async function createShareLink(input: CreateShareInput, conn: Tx = db): Promise<ShareLink> {
  const row = await conn.queryOne<Row>(
    `INSERT INTO ipy_share_link (record_id, token, label, created_by, expires_at, kind, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING ${COLUMNS}`,
    [
      input.recordId, mintToken(), input.label?.trim() || null, input.userId, input.expiresAt ?? null,
      input.kind ?? 'record',
      input.payload ? JSON.stringify(input.payload) : null,
    ],
  );
  logger.info({ recordId: input.recordId, linkId: row!.id }, 'share: link created');
  return toLink(row!);
}

/** Every link ever made for this property, newest first — revoked ones included. */
export async function listShareLinks(recordId: string, conn: Tx = db): Promise<ShareLink[]> {
  const { rows } = await conn.query<Row>(
    `SELECT ${COLUMNS} FROM ipy_share_link WHERE record_id = $1 ORDER BY created_at DESC`,
    [recordId],
  );
  return rows.map(toLink);
}

/**
 * Turn a link off.
 *
 * Marks rather than deletes, so "Rajesh opened this eleven times before I
 * revoked it" survives. Scoped to the record so a caller that has already
 * checked permission on that record cannot be tricked into revoking somebody
 * else's link with a guessed id.
 */
export async function revokeShareLink(id: string, recordId: string, conn: Tx = db): Promise<boolean> {
  const row = await conn.queryOne<{ id: string }>(
    `UPDATE ipy_share_link SET revoked_at = now()
      WHERE id = $1 AND record_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [id, recordId],
  );
  return Boolean(row);
}

/**
 * Resolve a token to the property it opens, or null.
 *
 * Null covers every reason uniformly — no such token, revoked, expired, record
 * deleted — because the caller must answer all of them with the same 404. A
 * message distinguishing "revoked" from "never existed" tells somebody probing
 * for links that they found a real one.
 */
export async function resolveShareToken(token: string, conn: Tx = db): Promise<ShareLink | null> {
  const row = await conn.queryOne<Row>(
    `SELECT s.${COLUMNS.split(',').map((c) => c.trim()).join(', s.')}
       FROM ipy_share_link s
       JOIN ipy_record r ON r.id = s.record_id
      WHERE s.token = $1
        AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND r.is_deleted = false`,
    [token],
  );
  return row ? toLink(row) : null;
}

/**
 * Count a visit.
 *
 * Deliberately fire-and-forget at the call site: a failed counter must never
 * stop a buyer seeing the property. It is a signal for the dealer, not
 * bookkeeping anything depends on.
 *
 * Counts requests, not people — a visitor who refreshes counts twice. That is
 * worth being honest about in the UI rather than pretending to a precision no
 * link can have without tracking somebody, which is not a trade worth making
 * to put a number on a card.
 */
export async function recordShareView(id: string, conn: Tx = db): Promise<void> {
  await conn.query(
    `UPDATE ipy_share_link
        SET view_count = view_count + 1, last_viewed_at = now()
      WHERE id = $1`,
    [id],
  );
}
