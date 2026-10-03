/**
 * A rep asking the owner of a record for it, and the owner handing it over.
 *
 * **3 October 2026, the owner:** *"if the agent/user search the any thing, then
 * system will display the record name on the screen and if agent want to access
 * the display record, he can ask to actual owner of record for the permission to
 * assigned him, Now The actual user can change the owner of record."*
 *
 * **Granting is an ordinary reassignment, not a second kind of permission.**
 * There is no "grant" flag anywhere, no row that quietly widens somebody's
 * scope: approving writes the new owner through `recordService.updateRecord`,
 * so the field permissions, the validation, the workflows and the audit trail
 * all apply exactly as they would if the owner had used the assignment field by
 * hand. A permission system with two doors is a permission system with one
 * door nobody has read.
 */
import { db, type Tx } from '../../db/pool.js';
import { notify } from '../notifications/index.js';
import { logger } from '../../utils/logger.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import type { ScopeContext } from '../permissions/index.js';

export interface AccessRequest {
  id: string;
  recordId: string;
  module: string;
  recordLabel: string;
  requestedBy: string;
  requesterName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  note: string | null;
  status: 'pending' | 'granted' | 'declined';
  createdAt: string;
  decidedAt: string | null;
}

const SELECT = `
  SELECT ar.id, ar.record_id, ar.module_name, ar.requested_by, ar.owner_id, ar.note,
         ar.status, ar.created_at, ar.decided_at,
         r.label AS record_label,
         nullif(trim(req.first_name || ' ' || req.last_name), '') AS requester_name,
         nullif(trim(own.first_name || ' ' || own.last_name), '') AS owner_name
    FROM ipy_access_request ar
    JOIN ipy_record r ON r.id = ar.record_id
    JOIN ipy_user req ON req.id = ar.requested_by
    LEFT JOIN ipy_user own ON own.id = ar.owner_id`;

interface Row {
  id: string; record_id: string; module_name: string; requested_by: string;
  owner_id: string | null; note: string | null; status: AccessRequest['status'];
  created_at: string; decided_at: string | null; record_label: string;
  requester_name: string | null; owner_name: string | null;
}

function shape(row: Row): AccessRequest {
  return {
    id: row.id,
    recordId: row.record_id,
    module: row.module_name,
    recordLabel: row.record_label,
    requestedBy: row.requested_by,
    requesterName: row.requester_name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/**
 * Ask for a record.
 *
 * **Asking is not seeing.** Nothing here reads a field off the record; the
 * request stores an id and a sentence the rep typed. The record's *name* is
 * read back for the owner's notification, and the owner can already read it.
 */
export async function requestAccess(
  ctx: ScopeContext,
  recordId: string,
  note: string | null,
  conn: Tx = db,
): Promise<AccessRequest> {
  const record = await conn.queryOne<{ id: string; label: string; owner_id: string | null; module_name: string }>(
    `SELECT r.id, r.label, r.owner_id, m.name AS module_name
       FROM ipy_record r JOIN ipy_module m ON m.id = r.module_id
      WHERE r.id = $1 AND r.is_deleted = false`,
    [recordId],
  );
  if (!record) throw new NotFoundError('That record no longer exists');
  if (record.owner_id === ctx.user.id) throw new BadRequestError('This record is already yours');

  /*
    `ON CONFLICT DO NOTHING` against the open-request index, then read the row
    back. Asking twice is the same person still waiting — answering "you have
    already asked" is the truth, and a second notification would teach the
    owner to stop reading them.
  */
  await conn.query(
    `INSERT INTO ipy_access_request (record_id, module_name, requested_by, owner_id, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [recordId, record.module_name, ctx.user.id, record.owner_id, note?.trim() || null],
  );
  const row = await conn.queryOne<Row>(
    `${SELECT} WHERE ar.record_id = $1 AND ar.requested_by = $2 AND ar.status = 'pending'`,
    [recordId, ctx.user.id],
  );
  if (!row) throw new BadRequestError('Could not record that request');

  // Only on the first ask: `created_at` within the last few seconds is what
  // tells a fresh row from one that was already waiting.
  const fresh = Date.now() - new Date(row.created_at).getTime() < 5_000;
  if (fresh && record.owner_id) {
    await notify({
      userId: record.owner_id,
      kind: 'access_request',
      title: `${row.requester_name ?? 'A colleague'} asked for ${record.label}`,
      body: note?.trim() || 'They would like this record assigned to them.',
      link: `/${record.module_name}/${recordId}`,
      recordId,
    }, conn);
  }
  // A record nobody owns has nobody to ask, which is a thing an admin should
  // be able to see rather than a request that silently waits for ever.
  if (fresh && !record.owner_id) {
    logger.info({ recordId, userId: ctx.user.id }, 'access requested on a record with no owner');
  }
  return shape(row);
}

/** What is waiting for me to decide, and what I have asked for. */
export async function listAccessRequests(ctx: ScopeContext): Promise<{ incoming: AccessRequest[]; mine: AccessRequest[] }> {
  const [incoming, mine] = await Promise.all([
    db.query<Row>(
      `${SELECT} WHERE ar.status = 'pending' AND ${ctx.user.isAdmin ? 'TRUE' : 'ar.owner_id = $1'}
       ORDER BY ar.created_at DESC LIMIT 50`,
      ctx.user.isAdmin ? [] : [ctx.user.id],
    ),
    db.query<Row>(
      `${SELECT} WHERE ar.requested_by = $1 ORDER BY ar.created_at DESC LIMIT 50`,
      [ctx.user.id],
    ),
  ]);
  return { incoming: incoming.rows.map(shape), mine: mine.rows.map(shape) };
}

/** The open requests on one record, for the banner its owner sees. */
export async function requestsForRecord(ctx: ScopeContext, recordId: string): Promise<AccessRequest[]> {
  const res = await db.query<Row>(
    `${SELECT} WHERE ar.record_id = $1 AND ar.status = 'pending' ORDER BY ar.created_at DESC`,
    [recordId],
  );
  // Only the owner and an admin are shown who is asking. A rep who can read
  // the record but does not own it has no business knowing who else wants it.
  if (ctx.user.isAdmin) return res.rows.map(shape);
  return res.rows.filter((row) => row.owner_id === ctx.user.id).map(shape);
}

/**
 * Answer a request.
 *
 * Granting hands `assign` the reassignment to perform — this module never
 * writes `owner_id` itself, which is what keeps the audit trail and the
 * workflows honest about who the record belongs to.
 */
export async function decideAccessRequest(
  ctx: ScopeContext,
  id: string,
  decision: 'granted' | 'declined',
  assign: (module: string, recordId: string, userId: string) => Promise<void>,
): Promise<AccessRequest> {
  const row = await db.queryOne<Row>(`${SELECT} WHERE ar.id = $1`, [id]);
  if (!row) throw new NotFoundError('That request no longer exists');
  if (row.status !== 'pending') throw new BadRequestError('That request has already been answered');
  // The record's *current* owner decides, not whoever it was addressed to: a
  // record reassigned since the ask is the new owner's to give away.
  const owner = await db.queryOne<{ owner_id: string | null }>('SELECT owner_id FROM ipy_record WHERE id = $1', [row.record_id]);
  if (!ctx.user.isAdmin && owner?.owner_id !== ctx.user.id) {
    throw new ForbiddenError('Only the person this record is assigned to can answer that');
  }

  if (decision === 'granted') await assign(row.module_name, row.record_id, row.requested_by);

  const updated = await db.queryOne<Row>(
    `WITH done AS (
       UPDATE ipy_access_request
          SET status = $2, decided_at = now(), decided_by = $3
        WHERE id = $1 AND status = 'pending'
        RETURNING id
     )
     ${SELECT} WHERE ar.id = (SELECT id FROM done)`,
    [id, decision, ctx.user.id],
  );
  if (!updated) throw new BadRequestError('That request has already been answered');

  await notify({
    userId: row.requested_by,
    kind: 'access_request',
    title: decision === 'granted'
      ? `${row.record_label} is yours now`
      : `${row.owner_name ?? 'The owner'} kept ${row.record_label}`,
    body: decision === 'granted'
      ? 'The record was assigned to you — it is in your list.'
      : 'Your request was declined.',
    link: decision === 'granted' ? `/${row.module_name}/${row.record_id}` : null,
    recordId: decision === 'granted' ? row.record_id : null,
  });
  return shape(updated);
}
