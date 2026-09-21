import { Router } from 'express';
import { z } from 'zod';
import { recordConsent } from '../../core/consent/index.js';
import { db, transaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { assertCapability, hasCapability } from '../../core/permissions/index.js';
import { activeValues, assertPicklistValue } from '../../core/metadata/picklists.js';
import { columnsOf } from '../../core/entity/payloadColumns.js';
import { logManualCall } from '../../integrations/telephony/manualCall.js';
import { recordService } from '../../core/entity/recordService.js';
import { emitToUser } from '../../realtime.js';
import { parseByteRange } from '../../utils/httpRange.js';
import { applyFileSecurityHeaders } from '../../core/media/serving.js';

export const telephonyRouter = Router();
telephonyRouter.use(requireAuth);

/*
  No `/status` and no `/call`.

  Both existed for cloud telephony — a browser that dials through Twilio or
  Exotel — which was never configured here and is now removed. A rep rings
  somebody from their handset; the Call button is a `tel:` link, and the call
  comes back through the paired Android app.
*/

/**
 * Who is this number, before the phone stops ringing.
 *
 * The one question the Android app has to answer in the second between a call
 * arriving and a rep deciding how to greet it, and the same one the CRM asks
 * after a call to file it. Both go here, so there is one answer.
 *
 * Three rules, and the first two are already the CRM's:
 *
 *  * **It never guesses between two people.** `matchContact` answers one,
 *    nobody, or "more than one and I will not choose" — because filing a
 *    customer against a stranger who shares their number is worse than asking.
 *    The screen offers the candidates.
 *  * **Numbers match on their last ten digits.** `9711533633`, `+919711533633`
 *    and `0919711533633` are one number; the CRM stores a country code and
 *    national digits, and imported rows carry every shape there is.
 *  * **The card is read as the person asking**, through `recordService`, so a
 *    rep who may not open a lead is told the number belongs to somebody —
 *    with the owner's name, so they can pass it on — and not what that
 *    somebody's budget is.
 */
telephonyRouter.get('/lookup', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const phone = String(req.query.phone ?? '');
  const { matchContact, matchKey } = await import('../../integrations/whatsapp/matchContact.js');
  if (!matchKey(phone)) throw new BadRequestError('A phone number of at least ten digits is needed.');

  const match = await matchContact('leads', phone);
  if (match.kind === 'none') { res.json({ kind: 'none' }); return; }
  if (match.kind === 'ambiguous') {
    res.json({ kind: 'ambiguous', candidates: match.candidates });
    return;
  }

  /*
    Read as the caller. A rep outside this lead's scope gets the "known to the
    CRM, not to you" shape rather than a 403 — an incoming call from a
    colleague's customer is a thing that happens, and "somebody else owns this,
    ask them" is the useful answer.
  */
  let record;
  try {
    record = await recordService.getRecord(scope, 'leads', match.recordId);
  } catch {
    const owner = await db.queryOne<{ owner_name: string | null }>(
      `SELECT trim(u.first_name || ' ' || u.last_name) AS owner_name
         FROM ipy_record r LEFT JOIN ipy_user u ON u.id = r.owner_id WHERE r.id = $1`,
      [match.recordId],
    );
    res.json({ kind: 'restricted', label: match.label, ownerName: owner?.owner_name ?? null });
    return;
  }

  const lastCall = await db.queryOne<{ started_at: string; direction: string; disposition: string | null }>(
    `SELECT started_at, direction, disposition FROM ipy_call
      WHERE record_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [match.recordId],
  );

  res.json({
    kind: 'one',
    recordId: match.recordId,
    module: 'leads',
    label: record.label ?? match.label,
    /*
      The facts the module itself flags as worth showing under a name —
      `config.listSubtitle`, the same ones the list and the split view read.
      Hardcoding "budget, configuration, locality" here would be a fourth place
      to edit when an admin changes what matters.
    */
    facts: record.display ?? {},
    values: record.values ?? {},
    ownerName: record.ownerName ?? null,
    lastCall: lastCall ?? null,
  });
}));

/** Log a call made outside the system. */
telephonyRouter.post('/log', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const input = z.object({
    to: z.string().min(6),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().nullable().optional(),
    direction: z.enum(['inbound', 'outbound']).default('outbound'),
    durationSeconds: z.number().int().min(0).max(36_000),
    disposition: z.string().optional(),
    notes: z.string().optional(),
    // How warm they sounded, as the rep read it. Deliberately not the record's
    // `rating`, which the scorer owns and overwrites.
    intent: z.enum(['hot', 'warm', 'cold']).nullable().optional(),
  }).refine((value) => !value.recordId || Boolean(value.module), {
    message: 'The record module is required when linking a call',
  }).parse(req.body);

  await assertPicklistValue('call_disposition', input.disposition);

  if (input.recordId && input.module) {
    await recordService.getRecord(getScope(req), input.module, input.recordId);
  }

  res.status(201).json(await logManualCall({
    userId: user.id,
    recordId: input.recordId ?? null,
    module: input.module ?? null,
    toNumber: input.to,
    direction: input.direction,
    durationSeconds: input.durationSeconds,
    disposition: input.disposition,
    notes: input.notes,
    intent: input.intent ?? null,
  }));
}));

telephonyRouter.get('/calls', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const {
    recordId, userId, limit, offset, direction, source, hasRecording,
    disposition, answered, from, to,
  } = z.object({
    recordId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    direction: z.enum(['inbound', 'outbound', 'missed', 'rejected', 'blocked', 'unknown']).optional(),
    source: z.enum(['api', 'device', 'manual']).optional(),
    hasRecording: z.coerce.boolean().optional(),
    disposition: z.string().max(60).optional(),
    /*
      Answered is not a direction and not a status: a call with time on the
      clock was picked up, whichever way it went and whatever the handset
      chose to call it. Filtering on `status` instead gives a different answer
      on every make of phone.
    */
    answered: z.enum(['yes', 'no']).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    limit: z.coerce.number().int().max(200).default(50),
    offset: z.coerce.number().int().default(0),
  }).parse(req.query);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (recordId) { params.push(recordId); clauses.push(`c.record_id = $${params.length}`); }
  if (direction) { params.push(direction); clauses.push(`c.direction = $${params.length}`); }
  if (source) { params.push(source); clauses.push(`c.source = $${params.length}`); }
  if (hasRecording) clauses.push(`c.recording_url IS NOT NULL`);
  if (disposition) { params.push(disposition); clauses.push(`c.disposition = $${params.length}`); }
  if (answered) clauses.push(answered === 'yes' ? `c.duration_seconds > 0` : `c.duration_seconds = 0`);
  if (from) { params.push(from); clauses.push(`c.started_at >= $${params.length}::timestamptz`); }
  // The day somebody types is the whole day: a date with no time is midnight,
  // so "to 20 September" would otherwise exclude every call made on it.
  if (to) { params.push(to); clauses.push(`c.started_at < ($${params.length}::timestamptz + interval '1 day')`); }
  // A rep sees their own calls unless they can listen to recordings org-wide.
  const canSeeAll = user.isAdmin || await hasCapability(user, 'telephony.listen_recordings');
  if (userId && userId !== user.id && !canSeeAll) {
    throw new ForbiddenError('You can only view your own calls');
  }
  if (recordId) await assertRecordIdAccess(req, recordId);
  if (userId) { params.push(userId); clauses.push(`c.user_id = $${params.length}`); }
  else if (!canSeeAll) { params.push(user.id); clauses.push(`c.user_id = $${params.length}`); }
  params.push(limit, offset);

  const rows = await db.query(
    `SELECT c.id, c.direction, c.from_number, c.to_number, c.status, c.duration_seconds,
            c.recording_url, c.disposition, c.notes, c.intent, c.ai_summary, c.ai_sentiment,
            c.ai_next_actions, c.ai_objections, c.ai_score, c.ai_talk_ratio,
            c.started_at, c.ended_at, c.source, c.device_id, c.user_id,
            -- The call happened and stays on the log; the link to a deleted
            -- lead does not, or the row offers a button that 404s. Nulled
            -- together so the UI falls back to the phone number it already has.
            r.id AS record_id,
            CASE WHEN r.id IS NULL THEN NULL ELSE c.record_module END AS record_module,
            r.label AS record_label,
            trim(u.first_name || ' ' || u.last_name) AS agent_name
     FROM ipy_call c
     LEFT JOIN ipy_record r ON r.id = c.record_id AND r.is_deleted = false
     LEFT JOIN ipy_user u ON u.id = c.user_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY c.started_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  /*
    The count matches the filters, not the page — a list that says "50 calls"
    because fifty is the page size tells somebody counting a day's work the
    wrong number. It rides in a **header** rather than wrapping the rows in an
    envelope: this endpoint answers a bare array, the record's Calls tab and an
    integration test both pin that, and changing the shape to add one number
    would have broken four tests and whatever else reads it.
  */
  const total = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_call c
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`,
    params.slice(0, params.length - 2),
  );
  res.setHeader('X-Total-Count', String(total?.count ?? rows.rows.length));
  res.json(rows.rows);
}));

telephonyRouter.get('/calls/:id', asyncHandler(async (req, res) => {
  const row = await db.queryOne<Record<string, unknown> & { user_id: string | null }>(
    `SELECT c.*,
            r.id AS record_id,
            CASE WHEN r.id IS NULL THEN NULL ELSE c.record_module END AS record_module,
            r.label AS record_label,
            trim(u.first_name || ' ' || u.last_name) AS agent_name
     FROM ipy_call c
     LEFT JOIN ipy_record r ON r.id = c.record_id AND r.is_deleted = false
     LEFT JOIN ipy_user u ON u.id = c.user_id
     WHERE c.id = $1`,
    [req.params.id],
  );
  if (!row) throw new NotFoundError('Call not found');

  const user = getUser(req);
  const canSeeAll = user.isAdmin || await hasCapability(user, 'telephony.listen_recordings');
  if (row.user_id !== user.id && !canSeeAll) throw new ForbiddenError('You can only view your own calls');

  res.json(row);
}));

telephonyRouter.patch('/calls/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const input = z.object({
    disposition: z.string().optional(),
    notes: z.string().optional(),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().nullable().optional(),
    transcript: z.string().optional(),
  }).refine((value) => !value.recordId || Boolean(value.module), {
    message: 'The record module is required when linking a call',
  }).parse(req.body);

  const existing = await db.queryOne<{
    user_id: string | null; disposition: string | null; notes: string | null;
  }>(
    `SELECT user_id, disposition, notes FROM ipy_call WHERE id = $1`, [req.params.id],
  );
  if (!existing) throw new NotFoundError('Call not found');
  if (existing.user_id !== user.id && !user.isAdmin) throw new ForbiddenError('You can only update your own calls');
  await assertPicklistValue('call_disposition', input.disposition);
  if (input.recordId && input.module) {
    await recordService.getRecord(getScope(req), input.module, input.recordId);
  }

  const map: Record<string, string> = {
    disposition: 'disposition', notes: 'notes',
    recordId: 'record_id', module: 'record_module', transcript: 'transcript',
  };
  const sets: string[] = [];
  const params: unknown[] = [req.params.id];
  for (const [k, v] of Object.entries(input)) {
    const col = map[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  // Editing the outcome moves the moment it was decided, for the same reason
  // the button stamps it: a call whose outcome is set and whose
  // `disposition_at` is null is invisible to everything that reports by date.
  if (input.disposition !== undefined && input.disposition !== existing.disposition) {
    sets.push('disposition_at = now()');
  }
  if (!sets.length) { res.json({ ok: true }); return; }

  await transaction(async (tx) => {
    const nextDisposition = input.disposition ?? existing.disposition;
    const nextNotes = input.notes ?? existing.notes;
    const changedNarrative = nextDisposition !== existing.disposition || nextNotes !== existing.notes;
    if (changedNarrative) {
      await tx.query(
        `INSERT INTO ipy_call_revision
           (call_id, edited_by, previous_disposition, previous_notes, new_disposition, new_notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.params.id, user.id, existing.disposition, existing.notes, nextDisposition, nextNotes],
      );
    }
    await tx.query(`UPDATE ipy_call SET ${sets.join(', ')} WHERE id = $1`, params);
  });
  res.json({ ok: true });
}));

/** Previous versions of an edited call note/outcome. */
telephonyRouter.get('/calls/:id/history', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const call = await db.queryOne<{ user_id: string | null }>(
    `SELECT user_id FROM ipy_call WHERE id = $1`, [req.params.id],
  );
  if (!call) throw new NotFoundError('Call not found');
  const canSeeAll = user.isAdmin || await hasCapability(user, 'telephony.listen_recordings');
  if (call.user_id !== user.id && !canSeeAll) throw new ForbiddenError('You can only view your own calls');

  const rows = await db.query(
    `SELECT r.id, r.previous_disposition, r.previous_notes,
            r.new_disposition, r.new_notes, r.created_at,
            trim(u.first_name || ' ' || u.last_name) AS edited_by_name
       FROM ipy_call_revision r
       LEFT JOIN ipy_user u ON u.id = r.edited_by
      WHERE r.call_id = $1
      ORDER BY r.created_at DESC`,
    [req.params.id],
  );
  res.json(rows.rows);
}));

// ---------------------------------------------------------------------------
// Recording playback
//
// Streamed through the API rather than linked directly: a recording is the most
// sensitive artefact this system holds, and both storage drivers can serve it
// without a public URL.
// ---------------------------------------------------------------------------

telephonyRouter.get('/calls/:id/recording', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const call = await db.queryOne<{ recording_key: string | null; recording_url: string | null; user_id: string | null }>(
    `SELECT recording_key, recording_url, user_id FROM ipy_call WHERE id = $1`, [req.params.id],
  );
  if (!call) throw new NotFoundError('Call not found');

  const canListen = user.isAdmin
    || call.user_id === user.id
    || await hasCapability(user, 'telephony.listen_recordings');
  if (!canListen) throw new ForbiddenError('You do not have permission to listen to call recordings');

  // Provider-hosted recordings (Twilio, Exotel) are absolute URLs we do not
  // hold bytes for — redirect rather than proxying someone else's audio.
  if (!call.recording_key) {
    if (call.recording_url && /^https?:\/\//i.test(call.recording_url)) {
      res.redirect(call.recording_url);
      return;
    }
    throw new NotFoundError('There is no recording for this call');
  }

  const { getDriver } = await import('../../core/storage/index.js');
  const buffer = await (await getDriver()).read(call.recording_key);
  if (!buffer) throw new NotFoundError('The recording file is no longer available');

  const extension = call.recording_key.split('.').pop()?.toLowerCase() ?? 'mp3';
  const mime = extension === 'm4a' || extension === 'mp4' ? 'audio/mp4'
    : extension === 'amr' ? 'audio/amr'
      : extension === 'wav' ? 'audio/wav' : 'audio/mpeg';

  /*
    The same headers every other byte-serving route in this CRM applies —
    `nosniff`, a Content-Disposition, and the strict media CSP. This route had
    none of them, which is the finding the public file routes already produced
    once: `applyFileSecurityHeaders` existed and four places that served bytes
    never called it. Found again here on 20 September 2026 by reading the
    response headers of a recording uploaded from a paired handset.

    Applied before the range branch, because a seek returns bytes too and a
    header set only on the whole-file path protects the one request nobody
    makes — the player asks for ranges.
  */
  applyFileSecurityHeaders(res, mime, call.recording_key.split('/').pop() ?? 'recording', false);

  // Range support so the player can seek — without it, scrubbing a ten-minute
  // call re-downloads from the start on every drag.
  const range = req.headers.range;
  if (range) {
    const parsed = parseByteRange(range, buffer.length);
    if (!parsed.ok) {
      res.status(416).setHeader('Content-Range', `bytes */${buffer.length}`).end();
      return;
    }
    const { start, end } = parsed;
    res.status(206)
      .setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`)
      .setHeader('Content-Length', String(end - start + 1))
      .setHeader('Accept-Ranges', 'bytes')
      .setHeader('Content-Type', mime)
      .send(buffer.subarray(start, end + 1));
    return;
  }

  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(buffer.length));
  res.send(buffer);
}));

/**
 * Calls this user has finished but not said anything about.
 *
 * The disposition prompt reads this. Capturing "what happened" is the whole
 * difference between a call log and a pipeline — and the only moment anyone
 * will actually answer is right after hanging up.
 */
telephonyRouter.get('/needs-disposition', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const rows = await db.query(
    `SELECT c.id, c.direction, c.from_number, c.to_number, c.duration_seconds,
            c.started_at,
            r.id AS record_id,
            CASE WHEN r.id IS NULL THEN NULL ELSE c.record_module END AS record_module,
            r.label AS record_label
     FROM ipy_call c LEFT JOIN ipy_record r ON r.id = c.record_id AND r.is_deleted = false
     WHERE c.user_id = $1 AND c.disposition IS NULL
       AND c.status = 'completed' AND c.duration_seconds > 0
       AND c.started_at > now() - interval '3 days'
     ORDER BY c.started_at DESC LIMIT 20`,
    [user.id],
  );
  res.json(rows.rows);
}));

/**
 * Record the outcome, and act on it.
 *
 * A disposition that only writes a column is a form nobody fills in twice.
 * "Call back later" with a date becomes a real task; "Do Not Call" sets the
 * flag on the lead that every other channel already respects.
 */
telephonyRouter.post('/calls/:id/disposition', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const input = z.object({
    disposition: z.string().min(1).max(60),
    notes: z.string().max(4000).optional(),
    followUpAt: z.string().datetime().nullable().optional(),
    intent: z.enum(['hot', 'warm', 'cold']).nullable().optional(),
  }).parse(req.body);

  /*
    The outcome has to be one the admin's list offers.

    This took any string up to 60 characters, and production holds calls
    recorded against an outcome that exists in no list — which quietly
    corrupts every report that groups by disposition, and would hide a
    "Do Not Call" typed as "do not call" from the consent store below.
  */
  await assertPicklistValue('call_disposition', input.disposition);

  /*
    Keep the previous outcome, the same way editing a call does.

    `PATCH /calls/:id` writes an `ipy_call_revision` row before it overwrites
    anything — that is what migration 130 created the table for, in its own
    words: "A disposition is part of the customer record; silently replacing it
    makes the call log less trustworthy than an ordinary CRM note." This
    endpoint did not, and it is the one a rep actually uses: the button after
    every call. So the edit path kept history and the path everybody takes
    threw it away, and `GET /calls/:id/history` answered an empty list for a
    call that had been changed twice.

    Read inside the transaction and before the update, or the "previous" value
    is the one just written.
  */
  const call = await transaction(async (tx) => {
    const before = await tx.queryOne<{ disposition: string | null; notes: string | null }>(
      `SELECT disposition, notes FROM ipy_call WHERE id = $1 AND (user_id = $2 OR $3)`,
      [req.params.id, user.id, user.isAdmin],
    );

    const updated = await tx.queryOne<{
      id: string; record_id: string | null; record_module: string | null;
      to_number: string; from_number: string | null; direction: string;
    }>(
      `UPDATE ipy_call SET disposition = $2, notes = COALESCE($3, notes),
              disposition_at = now(), follow_up_at = $4, intent = COALESCE($7, intent)
       WHERE id = $1 AND (user_id = $5 OR $6)
       RETURNING id, record_id, record_module, to_number, from_number, direction`,
      [
        req.params.id, input.disposition, input.notes ?? null, input.followUpAt ?? null,
        user.id, user.isAdmin, input.intent ?? null,
      ],
    );
    if (!updated || !before) return null;

    // The first disposition on a call is not a correction, so it is not a
    // revision — only a change to something already recorded is.
    const nextNotes = input.notes ?? before.notes;
    const changed = before.disposition !== null
      && (before.disposition !== input.disposition || before.notes !== nextNotes);
    if (changed) {
      await tx.query(
        `INSERT INTO ipy_call_revision
           (call_id, edited_by, previous_disposition, previous_notes, new_disposition, new_notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.params.id, user.id, before.disposition, before.notes, input.disposition, nextNotes],
      );
    }
    return updated;
  });
  if (!call) throw new NotFoundError('Call not found, or it is not yours to update');

  if (input.disposition === 'Do Not Call') {
    /*
      Store the request, do not paint a flag on the lead.

      This used to write a boolean onto the lead record. That column was
      deleted on 11 August, so the statement was a Postgres 42703 with no
      guard and no catch, inside asyncHandler. A rep marking a call
      "Do Not Call" got a 500 and the opt-out was persisted nowhere at all —
      not to a column, not to the consent store. Under TRAI that is a request
      we were legally obliged to honour and did not even record.

      The number is what the request is about, so the number is what is
      stored — and it is the customer's number, which on an inbound call is
      the other end. Both of those were still wrong after that fix: this sat
      inside `if (call.record_id)`, so a stranger who asked not to be rung
      again was recorded nowhere at all, against a comment promising the
      opposite; and it always stored `to_number`, which on an inbound call is
      the agent's own handset. That combination opted the CRM out of ringing
      itself and left the caller on the list.
    */
    await recordConsent({
      handle: call.direction === 'inbound' ? (call.from_number ?? call.to_number) : call.to_number,
      channel: 'call',
      action: 'opt_out',
      source: 'call_disposition',
      recordId: call.record_id,
    });
  }

  if (call.record_id) {
    if (input.disposition === 'Wrong Number') {
      /*
        Junk the lead — if there is still a status to set, and if Junk is
        still one of its options.

        Two literals in one statement, and an admin owns both. The column can
        be deleted, which makes this a 42703 on the whole statement and a 500
        for a rep who did nothing but say the number was wrong; and the option
        can be deleted, which would store a value the dropdown no longer
        offers and no filter matches. Neither is worth failing the
        disposition over: the outcome is already recorded by here, and a CRM
        that records less because a field was removed is what was asked for.
      */
      const present = await columnsOf('ipy_e_leads');
      const statuses = await activeValues('lead_status');
      if (present.has('status') && (!statuses.length || statuses.includes('Junk'))) {
        await db.query(
          `UPDATE ipy_e_leads SET status = 'Junk' WHERE record_id = $1 AND status <> 'Junk'`,
          [call.record_id],
        );
      }
    }
    if (input.followUpAt) {
      const { scheduleFollowUp } = await import('../../core/workflow/followUp.js');
      await scheduleFollowUp({
        recordId: call.record_id,
        module: call.record_module ?? 'leads',
        on: input.followUpAt,
        reason: `Call back — ${input.disposition}`,
        notes: input.notes ?? null,
        ownerId: user.id,
        authorId: user.id,
      });
    }
  }

  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Paired phones
// ---------------------------------------------------------------------------

telephonyRouter.get('/devices', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const { listDevices } = await import('../../integrations/telephony/deviceSync.js');
  res.json(await listDevices(user.id, user.isAdmin));
}));

telephonyRouter.post('/devices', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const input = z.object({
    label: z.string().max(60).optional(),
    phoneNumber: z.string().max(20).nullable().optional(),
    model: z.string().max(60).nullable().optional(),
  }).parse(req.body ?? {});

  const { pairDevice } = await import('../../integrations/telephony/deviceSync.js');
  const pairing = await pairDevice({ userId: user.id, ...input });

  // The token is returned exactly once. Said plainly so the UI does not offer a
  // "show again" that cannot work.
  res.status(201).json({
    ...pairing,
    note: 'Copy this token into the phone app now — it is not shown again.',
  });
}));

/**
 * Ring a number from the rep's own phone, pressed at a desk.
 *
 * The laptop cannot place a phone call. Handing it a `tel:` link asks the
 * browser which application should open it — on a Mac that is a dialog naming
 * FaceTime, which is not what anybody wanted and is what this replaces.
 *
 * Answers `{ sent: false }` rather than an error when the person has no paired
 * phone, because the caller's fallback (the laptop's own dialler) is a working
 * answer and not a failure.
 */
/**
 * "The app is open on my phone."
 *
 * Sent by the app's own screens every minute while it is in the foreground.
 * It exists because that is the fact a desk Call depends on and the one thing
 * nobody could see: the instruction reaches a handset over the app's own
 * connection, so a closed app cannot be rung however healthy the phone is.
 *
 * In the screens rather than the native half on purpose — those update
 * themselves from the server, so every handset already in the field starts
 * reporting without anybody installing anything.
 */
telephonyRouter.post('/devices/app-open', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { markAppOpen } = await import('../../integrations/telephony/deviceSync.js');
  res.json(await markAppOpen(user.id));
}));

telephonyRouter.post('/dial', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const input = z.object({
    to: z.string().min(3).max(32),
    module: z.string().max(60).optional(),
    recordId: z.string().uuid().optional(),
  }).parse(req.body ?? {});

  const { queueDial } = await import('../../integrations/telephony/deviceSync.js');
  const queued = await queueDial({
    userId: user.id,
    number: input.to,
    module: input.module ?? null,
    recordId: input.recordId ?? null,
  });
  if (!queued) {
    res.json({ sent: false, reason: 'no-device' });
    return;
  }

  /*
    The queue is what makes this reliable; this event is what makes it quick.
    The app runs the same signed-in web app inside it, so when it is open the
    instruction arrives in the same second rather than on the next sync. When
    it is not, the phone finds the command the next time it asks — inside the
    minute the command is alive for, or not at all.
  */
  emitToUser(user.id, 'device:dial', {
    commandId: queued.commandId,
    number: input.to,
    module: input.module ?? null,
    recordId: input.recordId ?? null,
    expiresAt: queued.expiresAt,
  });

  res.json({
    sent: true,
    commandId: queued.commandId,
    device: queued.deviceLabel,
    expiresAt: queued.expiresAt,
  });
}));

/**
 * Pick up the next call a signed-in phone missed while its app was asleep.
 *
 * Socket delivery is the fast path, but Android may suspend the webview between
 * the moment a rep presses Call and the moment they open the app. Returning a
 * queued instruction on reconnect means opening iPropy is sufficient; nobody
 * has to return to the laptop and press Call a second time.
 */
telephonyRouter.get('/dial/pending', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const row = await db.queryOne<{
    id: string; number: string | null; module: string | null; record_id: string | null; expires_at: string;
  }>(
    `WITH next_command AS (
       SELECT id FROM ipy_device_command
        WHERE user_id = $1 AND kind = 'dial' AND status = 'queued' AND expires_at > now()
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE ipy_device_command command SET status = 'delivered', delivered_at = now()
       FROM next_command WHERE command.id = next_command.id
     RETURNING command.id, command.payload->>'number' AS number, command.module, command.record_id, command.expires_at`,
    [user.id],
  );
  if (!row || !row.number) { res.json({ command: null }); return; }
  res.json({ command: { id: row.id, number: row.number, module: row.module, recordId: row.record_id, expiresAt: row.expires_at } });
}));

/**
 * Did the phone actually ring?
 *
 * Asked by the screen that pressed Call, for a few seconds after. Without it
 * the CRM would say "ringing from your phone" whatever happened — and the two
 * ways that is a lie are both ordinary: a handset that is off, and an app one
 * version behind that has never heard of placing a call. Either way the rep
 * finds out from the CRM rather than from a customer who was never rung.
 */
telephonyRouter.get('/dial/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const row = await db.queryOne<{ status: string; error: string | null; via: string | null }>(
    `SELECT status, error, payload->>'via' AS via FROM ipy_device_command
      WHERE id = $1 AND user_id = $2`,
    [req.params.id, user.id],
  );
  if (!row) throw new NotFoundError('That call instruction is not yours or no longer exists.');
  res.json({ status: row.status, error: row.error, via: row.via });
}));

/**
 * The phone closing its own instruction, from the app rather than the plugin.
 *
 * There is a device-token route for this already (`/api/device/commands/:id/result`)
 * and it is the right one when the native side placed the call. It cannot be
 * the only one: **every copy of the app installed today has no `placeCall` in
 * it**, so the plugin call fails, nothing is posted, and the instruction sits
 * there until it expires — 130 of them on production and not one ever
 * collected. The app's own webview can still hand the number to the phone's
 * dialler, and when it does, this is how it says so.
 *
 * Safe because a command belongs to a person: the signed-in user may close
 * their own dial instruction and nobody else's, which is all this does.
 */
telephonyRouter.post('/dial/:id/result', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    ok: z.boolean(),
    /** `app` placed the call outright; `dialler` filled it in for a tap. */
    via: z.enum(['app', 'dialler']).optional(),
    error: z.string().max(200).nullish(),
  }).parse(req.body ?? {});

  const row = await db.queryOne<{ id: string }>(
    `UPDATE ipy_device_command
        SET status = $3, finished_at = now(), error = $4,
            payload = payload || jsonb_build_object('via', $5::text)
      WHERE id = $1 AND user_id = $2 AND kind = 'dial'
      RETURNING id`,
    [req.params.id, user.id, input.ok ? 'done' : 'failed', input.error ?? null, input.via ?? 'app'],
  );
  if (!row) throw new NotFoundError('That call instruction is not yours or no longer exists.');
  res.json({ ok: true });
}));

telephonyRouter.delete('/devices/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const { revokeDevice } = await import('../../integrations/telephony/deviceSync.js');
  await revokeDevice(req.params.id, user.id, user.isAdmin);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Virtual / tracking numbers
// ---------------------------------------------------------------------------

telephonyRouter.get('/numbers', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT v.*,
            g.name AS route_group_name, trim(u.first_name || ' ' || u.last_name) AS route_user_name
     FROM ipy_virtual_number v
     LEFT JOIN ipy_group g ON g.id = v.route_to_group_id
     LEFT JOIN ipy_user u ON u.id = v.route_to_user_id
     ORDER BY v.created_at DESC`,
  );
  res.json(rows.rows);
}));

telephonyRouter.post('/numbers', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  const input = z.object({
    number: z.string().min(6),
    label: z.string().optional(),
    provider: z.string().optional(),
    leadSource: z.string().optional(),
    routeToGroupId: z.string().uuid().nullable().optional(),
    routeToUserId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_virtual_number
      (number, label, provider, lead_source, route_to_group_id, route_to_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (number) DO UPDATE SET
       label = EXCLUDED.label,
       lead_source = EXCLUDED.lead_source,
       route_to_group_id = EXCLUDED.route_to_group_id, route_to_user_id = EXCLUDED.route_to_user_id
     RETURNING id`,
    [
      input.number, input.label ?? null, input.provider ?? null,
      input.leadSource ?? null,
      input.routeToGroupId ?? null, input.routeToUserId ?? null,
    ],
  );
  res.status(201).json({ id: row?.id });
}));

telephonyRouter.delete('/numbers/:id', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.integrations');
  await db.query(`DELETE FROM ipy_virtual_number WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Agent stats — the dialer's own scoreboard
// ---------------------------------------------------------------------------

telephonyRouter.get('/stats', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const requestedUserId = typeof req.query.userId === 'string' ? req.query.userId : user.id;
  const canSeeAll = user.isAdmin || await hasCapability(user, 'telephony.listen_recordings');
  if (requestedUserId !== user.id && !canSeeAll) throw new ForbiddenError('You can only view your own call statistics');
  const userId = requestedUserId;
  const days = Math.min(90, Number(req.query.days) || 7);

  const stats = await db.queryOne(
    `SELECT
       COUNT(*)::int AS total_calls,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS connected,
       COALESCE(SUM(duration_seconds),0)::int AS total_seconds,
       COALESCE(ROUND(AVG(duration_seconds) FILTER (WHERE status = 'completed')),0)::int AS avg_duration,
       COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
       COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
       COALESCE(ROUND(AVG(ai_score) FILTER (WHERE ai_score IS NOT NULL)),0)::int AS avg_quality
     FROM ipy_call
     WHERE user_id = $1 AND started_at > now() - ($2 || ' days')::interval`,
    [userId, days],
  );

  const byDay = await db.query(
    `SELECT date_trunc('day', started_at)::date::text AS day,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS connected
     FROM ipy_call
     WHERE user_id = $1 AND started_at > now() - ($2 || ' days')::interval
     GROUP BY 1 ORDER BY 1`,
    [userId, days],
  );

  res.json({ ...stats, byDay: byDay.rows });
}));

async function assertRecordIdAccess(req: Parameters<typeof getScope>[0], recordId: string): Promise<void> {
  const record = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [recordId],
  );
  if (!record) throw new NotFoundError('Record not found');
  await recordService.getRecord(getScope(req), record.module_name, recordId);
}
