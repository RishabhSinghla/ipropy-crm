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
