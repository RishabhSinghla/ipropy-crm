/**
 * Automatic daily AI calling: settings, preview, a small test run, today's progress, and the per-record call history.
 * The work itself is in `integrations/voiceagent/autoCalls.ts`; this file only checks who may ask and shapes the answer.
 */
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAdmin, requireAuth } from '../../middleware/auth.js';
import { BadRequestError } from '../../utils/errors.js';
import { assertCapability } from '../../core/permissions/index.js';
import { recordService } from '../../core/entity/recordService.js';
import { publicSarvamPolicy, readSarvamPolicy } from '../../integrations/voiceagent/policy.js';
import {
  AI_MODULES, SKIP_TEXT, blockedReason, istInstant, istParts, ownerProblem, planAutoCalls, readSchedules, sarvamProblem, startAutoRun,
} from '../../integrations/voiceagent/autoCalls.js';

export const aiCallingRouter = Router();
aiCallingRouter.use(requireAuth);

const moduleName = z.enum(AI_MODULES);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 10:30.');
const moduleSettings = z.object({
  enabled: z.boolean(),
  startTime: time,
  days: z.array(z.number().int().min(1).max(7)).min(1, 'Pick at least one day.').max(7),
  dailyCap: z.number().int().min(1).max(500),
  viewId: z.string().uuid().nullable(),
  restDays: z.number().int().min(0).max(365),
  maxAttempts: z.number().int().min(1).max(10),
  retryHours: z.number().int().min(1).max(240),
}).partial();

/** Settings, plus the plain reason nothing would ring right now. Admin only. */
aiCallingRouter.get('/schedule', requireAdmin, asyncHandler(async (_req, res) => {
  const schedules = await readSchedules();
  const now = new Date();
  const master = schedules['_master'];
  const owner = master?.ownerUserId ?? null;
  res.json({
    master: { enabled: master?.enabled ?? false },
    modules: Object.fromEntries(AI_MODULES.map((m) => [m, { ...schedules[m], blockedReason: schedules[m] ? blockedReason(schedules[m]!, master, now) : 'Not set up.' }])),
    health: { sarvam: sarvamProblem(), owner: await ownerProblem(owner) },
    policy: publicSarvamPolicy(),
    now: istParts(now),
  });
}));

aiCallingRouter.put('/schedule', requireAdmin, asyncHandler(async (req, res) => {
  const user = getUser(req);
  const body = z.object({ master: z.object({ enabled: z.boolean() }).optional(), modules: z.record(moduleName, moduleSettings).optional() }).parse(req.body);
  if (body.master) await db.query(`UPDATE ipy_ai_call_schedule SET enabled=$1, updated_at=now(), updated_by=$2, owner_user_id=COALESCE(owner_user_id,$2) WHERE module='_master'`, [body.master.enabled, user.id]);
  for (const [module, s] of Object.entries(body.modules ?? {})) {
    if (s.viewId) {
      const ok = await db.queryOne(`SELECT 1 FROM ipy_view v JOIN ipy_module m ON m.id = v.module_id WHERE v.id = $1 AND m.name = $2`, [s.viewId, module]);
      if (!ok) throw new BadRequestError('That saved view belongs to a different module.');
    }
    await db.query(
      `UPDATE ipy_ai_call_schedule SET
         enabled = COALESCE($2, enabled), start_time = COALESCE($3, start_time), days = COALESCE($4::smallint[], days),
         daily_cap = COALESCE($5, daily_cap), view_id = CASE WHEN $6::boolean THEN $7::uuid ELSE view_id END,
         rest_days = COALESCE($8, rest_days), max_attempts = COALESCE($9, max_attempts), retry_hours = COALESCE($10, retry_hours),
         owner_user_id = COALESCE(owner_user_id, $11::uuid), updated_at = now(), updated_by = $11::uuid
       WHERE module = $1`,
      [module, s.enabled ?? null, s.startTime ?? null, s.days ?? null, s.dailyCap ?? null, 'viewId' in s, s.viewId ?? null,
        s.restDays ?? null, s.maxAttempts ?? null, s.retryHours ?? null, user.id]);
  }
  await db.query(`INSERT INTO ipy_audit(module_name, user_id, action, changes, source) VALUES ('ai_calling', $1, 'ai_calling_settings', $2::jsonb, 'app')`,
    [user.id, JSON.stringify([body])]);
  res.json({ ok: true });
}));

/** Saved views an admin may pick as "who can be called". */
aiCallingRouter.get('/views', requireAdmin, asyncHandler(async (req, res) => {
  const module = moduleName.parse(req.query.module);
  const rows = await db.query(`SELECT v.id, v.name FROM ipy_view v JOIN ipy_module m ON m.id = v.module_id WHERE m.name = $1 ORDER BY v.is_system DESC, v.name`, [module]);
  res.json(rows.rows);
}));

const targetIds = z.array(z.string().uuid()).max(25).optional();

/** Who WOULD be called tomorrow, and why everybody else is left out. Calls nobody. */
aiCallingRouter.post('/preview', requireAdmin, asyncHandler(async (req, res) => {
  const input = z.object({ module: moduleName, recordIds: targetIds }).parse(req.body);
  const s = (await readSchedules())[input.module];
  const now = new Date();
  const tomorrow = istParts(new Date(now.getTime() + 24 * 3_600_000)).date;
  const plan = await planAutoCalls({ module: input.module, asOf: istInstant(tomorrow, s?.startTime ?? '10:30'), onlyRecordIds: input.recordIds });
  res.json({
    date: tomorrow, considered: plan.considered, dailyCap: plan.capLeft, problem: plan.problem,
    picks: plan.picks,
    skipped: Object.entries(plan.skippedCount).map(([reason, count]) => ({ reason, text: SKIP_TEXT[reason as keyof typeof SKIP_TEXT], count })),
    skippedExamples: plan.skippedExamples.map((x) => ({ ...x, text: SKIP_TEXT[x.reason] })),
  });
}));

/** A small test run with a hard limit. Works with the switches off: the owner starts it by hand, on purpose. */
aiCallingRouter.post('/run-now', requireAdmin, asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertCapability(user, 'telephony.call');
  const input = z.object({ module: moduleName, limit: z.number().int().min(1).max(25), recordIds: targetIds }).parse(req.body);
  const hours = readSarvamPolicy();
  const result = await startAutoRun({ module: input.module, trigger: 'manual', limit: input.limit, onlyRecordIds: input.recordIds, startedBy: user.id });
  res.status(result.status === 'failed' ? 400 : 201).json({ ...result, callingHours: `${hours.callStart}–${hours.callEnd}` });
}));

/** Today's progress, the last seven days, and recent runs. Anyone who may place calls can see it. */
aiCallingRouter.get('/status', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'telephony.call');
  const today = istParts(new Date()).date;
  const perDay = await db.query<{ day: string; module: string | null; calls: number; answered: number; interested: number; failed: number }>(
    `SELECT to_char((c.started_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, c.record_module AS module,
            count(*)::int AS calls,
            count(*) FILTER (WHERE s.st IN ('answered','interested','callback','not_interested','do_not_call','wrong_number'))::int AS answered,
            count(*) FILTER (WHERE s.st = 'interested')::int AS interested,
            count(*) FILTER (WHERE s.st IN ('failed','busy','no_answer','voicemail'))::int AS failed
       FROM ipy_call c, LATERAL (SELECT ipy_ai_status(c.status, c.disposition, c.sarvam_meta->>'outcome') AS st) s
      WHERE c.source = 'sarvam' AND c.direction = 'outbound' AND c.started_at > now() - interval '8 days'
      GROUP BY 1, 2 ORDER BY 1 DESC`);
  const runs = await db.query(
    `SELECT id, module, to_char(run_date,'YYYY-MM-DD') AS run_date, trigger, status, planned, skipped, message, batch_id, created_at, finished_at
       FROM ipy_ai_call_run ORDER BY created_at DESC LIMIT 20`);
  const planned = await db.query<{ module: string; planned: number }>(
    `SELECT module, COALESCE(sum(planned),0)::int AS planned FROM ipy_ai_call_run WHERE run_date = $1 AND status <> 'failed' GROUP BY module`, [today]);
  const schedules = await readSchedules();
  const master = schedules['_master'];
  res.json({
    today, perDay: perDay.rows, runs: runs.rows, planned: Object.fromEntries(planned.rows.map((r) => [r.module, r.planned])),
    masterEnabled: master?.enabled ?? false,
    blocked: Object.fromEntries(AI_MODULES.map((m) => [m, schedules[m] ? blockedReason(schedules[m]!, master, new Date()) : null])),
  });
}));

/** Every AI call on one record, for its "AI calls" panel. Visible to whoever may open the record. */
aiCallingRouter.get('/records/:module/:id', asyncHandler(async (req, res) => {
  const module = z.string().min(1).parse(req.params.module);
  const id = z.string().uuid().parse(req.params.id);
  await recordService.getRecord(getScope(req), module, id);
  const calls = await db.query(
    `SELECT c.id, c.started_at, c.duration_seconds, c.status, c.disposition, c.ai_summary, c.notes, c.transcript,
            (c.recording_url IS NOT NULL OR c.recording_key IS NOT NULL) AS has_recording,
            c.sarvam_app_id AS agent_app_id, c.sarvam_batch_id AS batch_id, c.sarvam_meta->>'outcome' AS outcome,
            ipy_ai_status(c.status, c.disposition, c.sarvam_meta->>'outcome') AS ai_status,
            (SELECT cm.body FROM ipy_comment cm WHERE cm.source_external_id = 'sarvam_ai_call:' || c.provider_call_id LIMIT 1) AS feedback,
            (b.origin = 'auto') AS automatic
       FROM ipy_call c LEFT JOIN ipy_sarvam_batch b ON b.id = c.sarvam_batch_id
      WHERE c.source = 'sarvam' AND c.record_id = $1 ORDER BY c.started_at DESC LIMIT 50`, [id]);
  res.json({ calls: calls.rows });
}));
