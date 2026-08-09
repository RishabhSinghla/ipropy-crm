import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { assertCapability, canAccessRecord } from '../../core/permissions/index.js';
import { isTelephonyConfigured, logManualCall, placeCall } from '../../integrations/telephony/service.js';

export const telephonyRouter = Router();
telephonyRouter.use(requireAuth);

telephonyRouter.get('/status', asyncHandler(async (_req, res) => {
  res.json({ configured: isTelephonyConfigured() });
}));

/** Click-to-call from a record. */
telephonyRouter.post('/call', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  await assertCapability(user, 'telephony.call');

  const input = z.object({
    to: z.string().min(6),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().nullable().optional(),
  }).parse(req.body);

  if (input.recordId && input.module) {
    if (!(await canAccessRecord(scope, input.module, input.recordId, 'view'))) throw new ForbiddenError();
  }

  res.status(201).json(await placeCall({
    agentUserId: user.id,
    toNumber: input.to,
    recordId: input.recordId ?? null,
    module: input.module ?? null,
  }));
}));

/** Log a call made outside the system. */
telephonyRouter.post('/log', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    to: z.string().min(6),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().nullable().optional(),
    direction: z.enum(['inbound', 'outbound']).default('outbound'),
    durationSeconds: z.number().int().min(0).max(36_000),
    disposition: z.string().optional(),
    notes: z.string().optional(),
  }).parse(req.body);

  res.status(201).json(await logManualCall({
    userId: user.id,
    recordId: input.recordId ?? null,
    module: input.module ?? null,
    toNumber: input.to,
    direction: input.direction,
    durationSeconds: input.durationSeconds,
    disposition: input.disposition,
    notes: input.notes,
  }));
}));

telephonyRouter.get('/calls', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { recordId, userId, limit, offset, direction, hasRecording } = z.object({
    recordId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    direction: z.enum(['inbound', 'outbound', 'missed']).optional(),
    hasRecording: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().max(200).default(50),
    offset: z.coerce.number().int().default(0),
  }).parse(req.query);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (recordId) { params.push(recordId); clauses.push(`c.record_id = $${params.length}`); }
  if (direction) { params.push(direction); clauses.push(`c.direction = $${params.length}`); }
  if (hasRecording) clauses.push(`c.recording_url IS NOT NULL`);
  // A rep sees their own calls unless they can listen to recordings org-wide.
  const canSeeAll = user.isAdmin || (await import('../../core/permissions/index.js')
    .then((m) => m.hasCapability(user, 'telephony.listen_recordings')));
  if (userId) { params.push(userId); clauses.push(`c.user_id = $${params.length}`); }
  else if (!canSeeAll) { params.push(user.id); clauses.push(`c.user_id = $${params.length}`); }
  params.push(limit, offset);

  const rows = await db.query(
    `SELECT c.id, c.direction, c.from_number, c.to_number, c.status, c.duration_seconds,
            c.recording_url, c.disposition, c.notes, c.ai_summary, c.ai_sentiment,
            c.ai_next_actions, c.ai_objections, c.ai_score, c.ai_talk_ratio,
            c.started_at, c.ended_at, c.record_id, c.record_module,
            r.label AS record_label,
            trim(u.first_name || ' ' || u.last_name) AS agent_name
     FROM ipy_call c
     LEFT JOIN ipy_record r ON r.id = c.record_id
     LEFT JOIN ipy_user u ON u.id = c.user_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY c.started_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json(rows.rows);
}));

telephonyRouter.get('/calls/:id', asyncHandler(async (req, res) => {
  const row = await db.queryOne(
    `SELECT c.*, r.label AS record_label, trim(u.first_name || ' ' || u.last_name) AS agent_name
     FROM ipy_call c
     LEFT JOIN ipy_record r ON r.id = c.record_id
     LEFT JOIN ipy_user u ON u.id = c.user_id
     WHERE c.id = $1`,
    [req.params.id],
  );
  if (!row) throw new NotFoundError('Call not found');

  // The recording is the sensitive part — gate it separately from the metadata.
  const user = getUser(req);
  const canListen = user.isAdmin
    || (row as { user_id?: string }).user_id === user.id
    || await import('../../core/permissions/index.js').then((m) => m.hasCapability(user, 'telephony.listen_recordings'));
  if (!canListen) (row as { recording_url?: string | null }).recording_url = null;

  res.json(row);
}));

telephonyRouter.patch('/calls/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const input = z.object({
    disposition: z.string().optional(),
    notes: z.string().optional(),
    recordId: z.string().uuid().nullable().optional(),
    module: z.string().nullable().optional(),
    transcript: z.string().optional(),
  }).parse(req.body);

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
  if (!sets.length) { res.json({ ok: true }); return; }

  params.push(user.id);
  await db.query(
    `UPDATE ipy_call SET ${sets.join(', ')} WHERE id = $1
     AND (user_id = $${params.length} OR $${params.length} IN (SELECT id FROM ipy_user WHERE is_admin))`,
    params,
  );
  res.json({ ok: true });
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
    || await import('../../core/permissions/index.js').then((m) => m.hasCapability(user, 'telephony.listen_recordings'));
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

  // Range support so the player can seek — without it, scrubbing a ten-minute
  // call re-downloads from the start on every drag.
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : buffer.length - 1;
    if (start >= buffer.length) {
      res.status(416).setHeader('Content-Range', `bytes */${buffer.length}`).end();
      return;
    }
    res.status(206)
      .setHeader('Content-Range', `bytes ${start}-${end}/${buffer.length}`)
      .setHeader('Accept-Ranges', 'bytes')
      .setHeader('Content-Type', mime)
      .send(buffer.subarray(start, end + 1));
    return;
  }

  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
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
  const rows = await db.query(
    `SELECT c.id, c.direction, c.from_number, c.to_number, c.duration_seconds,
            c.started_at, c.record_id, c.record_module, r.label AS record_label
     FROM ipy_call c LEFT JOIN ipy_record r ON r.id = c.record_id
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
  const input = z.object({
    disposition: z.string().min(1).max(60),
    notes: z.string().max(4000).optional(),
    followUpAt: z.string().datetime().nullable().optional(),
  }).parse(req.body);

  const call = await db.queryOne<{ id: string; record_id: string | null; record_module: string | null; to_number: string }>(
    `UPDATE ipy_call SET disposition = $2, notes = COALESCE($3, notes),
            disposition_at = now(), follow_up_at = $4
     WHERE id = $1 AND (user_id = $5 OR $6)
     RETURNING id, record_id, record_module, to_number`,
    [req.params.id, input.disposition, input.notes ?? null, input.followUpAt ?? null, user.id, user.isAdmin],
  );
  if (!call) throw new NotFoundError('Call not found, or it is not yours to update');

  if (call.record_id) {
    if (input.disposition === 'Do Not Call') {
      await db.query(`UPDATE ipy_e_leads SET do_not_call = true WHERE record_id = $1`, [call.record_id]);
    }
    if (input.disposition === 'Wrong Number') {
      await db.query(
        `UPDATE ipy_e_leads SET status = 'Junk' WHERE record_id = $1 AND status <> 'Junk'`,
        [call.record_id],
      );
    }
    if (input.followUpAt) {
      const { createRecord } = await import('../../core/entity/recordService.js');
      const { systemContext } = await import('../../core/workflow/tasks.js');
      await createRecord(await systemContext(null), 'activities', {
        subject: `Call back — ${input.disposition}`,
        activity_type: 'Call',
        status: 'Not Started',
        priority: 'High',
        related_to: call.record_id,
        related_module: call.record_module ?? 'leads',
        start_at: input.followUpAt,
        due_date: input.followUpAt.slice(0, 10),
        description: input.notes ?? '',
        owner_id: user.id,
      }, { skipDuplicateCheck: true }).catch(() => undefined);
    }
  }

  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Paired phones
// ---------------------------------------------------------------------------

telephonyRouter.get('/devices', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { listDevices } = await import('../../integrations/telephony/deviceSync.js');
  res.json(await listDevices(user.id, user.isAdmin));
}));

telephonyRouter.post('/devices', asyncHandler(async (req, res) => {
  const user = getUser(req);
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

telephonyRouter.delete('/devices/:id', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const { revokeDevice } = await import('../../integrations/telephony/deviceSync.js');
  await revokeDevice(req.params.id, user.id, user.isAdmin);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Virtual / tracking numbers
// ---------------------------------------------------------------------------

telephonyRouter.get('/numbers', asyncHandler(async (_req, res) => {
  const rows = await db.query(
    `SELECT v.*, c.label AS campaign_label, p.label AS project_label,
            g.name AS route_group_name, trim(u.first_name || ' ' || u.last_name) AS route_user_name
     FROM ipy_virtual_number v
     LEFT JOIN ipy_record c ON c.id = v.campaign_id
     LEFT JOIN ipy_record p ON p.id = v.project_id
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
    campaignId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    leadSource: z.string().optional(),
    routeToGroupId: z.string().uuid().nullable().optional(),
    routeToUserId: z.string().uuid().nullable().optional(),
  }).parse(req.body);

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_virtual_number
      (number, label, provider, campaign_id, project_id, lead_source, route_to_group_id, route_to_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (number) DO UPDATE SET
       label = EXCLUDED.label, campaign_id = EXCLUDED.campaign_id,
       project_id = EXCLUDED.project_id, lead_source = EXCLUDED.lead_source,
       route_to_group_id = EXCLUDED.route_to_group_id, route_to_user_id = EXCLUDED.route_to_user_id
     RETURNING id`,
    [
      input.number, input.label ?? null, input.provider ?? null,
      input.campaignId ?? null, input.projectId ?? null, input.leadSource ?? null,
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
  const userId = typeof req.query.userId === 'string' ? req.query.userId : user.id;
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
