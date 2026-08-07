import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { assertCapability, canAccessRecord } from '../../core/permissions/index.js';
import { isAiAvailable } from '../../ai/client.js';
import { isSttConfigured, SttError, transcribeRecording } from '../../core/stt/index.js';
import { scoreLead } from '../../ai/leadScoring.js';
import { analyseDeal } from '../../ai/dealRisk.js';
import { matchForRecord, matchProperties, matchBuyersForProperty, loadRequirement } from '../../ai/matching.js';
import { draftMessage, summariseRecord } from '../../ai/drafting.js';
import { analyseTranscript, coachingReport } from '../../ai/callAnalysis.js';
import { ask, dailyDigest, dashboardInsight, parseNaturalQuery } from '../../ai/assistant.js';

export const aiRouter = Router();
aiRouter.use(requireAuth);

aiRouter.get('/status', asyncHandler(async (_req, res) => {
  res.json({
    available: isAiAvailable(),
    message: isAiAvailable()
      ? 'AI features are active.'
      : 'Set ANTHROPIC_API_KEY to enable AI features. Rule-based scoring and matching still work without it.',
  });
}));

// ---------------------------------------------------------------------------
// Scoring & analysis
// ---------------------------------------------------------------------------

aiRouter.post('/score-lead/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, 'leads', req.params.id, 'view'))) throw new NotFoundError();
  const result = await scoreLead(req.params.id);
  if (!result) throw new NotFoundError('Lead not found');
  res.json(result);
}));

aiRouter.post('/analyse-deal/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, 'deals', req.params.id, 'view'))) throw new NotFoundError();
  const result = await analyseDeal(req.params.id);
  if (!result) throw new NotFoundError('Deal not found');
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Property matching
// ---------------------------------------------------------------------------

aiRouter.get('/match/:module/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { module, id } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'view'))) throw new NotFoundError();

  const matches = await matchForRecord(id, {
    limit: Math.min(20, Number(req.query.limit) || 6),
    withNarrative: req.query.narrative !== 'false',
    persist: true,
  });
  res.json({ matches, requirement: await loadRequirement(id) });
}));

/** Ad-hoc matching from a requirement the rep types in. */
aiRouter.post('/match', asyncHandler(async (req, res) => {
  const input = z.object({
    budgetMin: z.number().nullable().optional(),
    budgetMax: z.number().nullable().optional(),
    configurations: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
    carpetAreaMin: z.number().nullable().optional(),
    carpetAreaMax: z.number().nullable().optional(),
    possessionTimeline: z.string().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    purpose: z.string().nullable().optional(),
    limit: z.number().int().max(20).default(6),
    withNarrative: z.boolean().default(false),
  }).parse(req.body);

  res.json({ matches: await matchProperties(input, { limit: input.limit, withNarrative: input.withNarrative }) });
}));

/** Reverse match: who should we pitch this unit to? */
aiRouter.get('/buyers-for/:propertyId', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, 'properties', req.params.propertyId, 'view'))) throw new NotFoundError();
  res.json({ buyers: await matchBuyersForProperty(req.params.propertyId, Math.min(25, Number(req.query.limit) || 10)) });
}));

// ---------------------------------------------------------------------------
// Drafting & summarising
// ---------------------------------------------------------------------------

aiRouter.post('/draft', asyncHandler(async (req, res) => {
  const user = getUser(req);
  const scope = getScope(req);
  const input = z.object({
    channel: z.enum(['whatsapp', 'email', 'sms', 'call_script']).default('whatsapp'),
    recordId: z.string().uuid(),
    module: z.string(),
    goal: z.string().optional(),
    tone: z.enum(['warm', 'professional', 'urgent', 'consultative']).optional(),
    replyingTo: z.string().optional(),
    language: z.string().optional(),
    includeProperties: z.boolean().optional(),
  }).parse(req.body);

  if (!(await canAccessRecord(scope, input.module, input.recordId, 'view'))) throw new NotFoundError();

  const draft = await draftMessage({ ...input, userId: user.id });
  if (!draft) throw new BadRequestError('AI drafting is unavailable — check the API key configuration');
  res.json(draft);
}));

aiRouter.post('/summarise/:module/:id', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { module, id } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'view'))) throw new NotFoundError();
  const summary = await summariseRecord(id, module, scope.user.id);
  if (!summary) throw new BadRequestError('AI summarisation is unavailable');
  res.json({ summary });
}));

// ---------------------------------------------------------------------------
// Call intelligence
// ---------------------------------------------------------------------------

/** Transcribe a call recording so analysis can run without a manual transcript. */
aiRouter.post('/calls/:id/transcribe', asyncHandler(async (req, res) => {
  const call = await db.queryOne<{ id: string; recording_url: string | null }>(
    `SELECT id, recording_url FROM ipy_call WHERE id = $1`,
    [req.params.id],
  );
  if (!call) throw new NotFoundError('Call not found');
  if (!call.recording_url) {
    throw new BadRequestError('This call has no recording to transcribe');
  }

  const { getSettings } = await import('../../core/settings/integrations.js');
  const settings = getSettings().stt;
  if (!isSttConfigured(settings)) {
    throw new BadRequestError(
      'Speech-to-text is not configured — add an STT API key under Admin → Integrations (or set STT_API_KEY).',
    );
  }

  try {
    const transcript = await transcribeRecording(call.recording_url, settings);
    await db.query(`UPDATE ipy_call SET transcript = $2 WHERE id = $1`, [call.id, transcript]);
    res.json({ transcript });
  } catch (err) {
    if (err instanceof SttError) throw new BadRequestError(err.message);
    throw err;
  }
}));

aiRouter.post('/calls/:id/analyse', asyncHandler(async (req, res) => {
  const { transcript } = z.object({ transcript: z.string().min(20).optional() }).parse(req.body ?? {});

  const call = await db.queryOne<{
    id: string; transcript: string | null; record_id: string | null; record_module: string | null;
    duration_seconds: number; direction: string; user_id: string | null;
  }>(
    `SELECT id, transcript, record_id, record_module, duration_seconds, direction, user_id
     FROM ipy_call WHERE id = $1`,
    [req.params.id],
  );
  if (!call) throw new NotFoundError('Call not found');

  const text = transcript ?? call.transcript;
  if (!text) throw new BadRequestError('No transcript available. Paste one to analyse this call.');

  if (transcript && transcript !== call.transcript) {
    await db.query(`UPDATE ipy_call SET transcript = $2 WHERE id = $1`, [call.id, transcript]);
  }

  const result = await analyseTranscript(call.id, text, {
    recordId: call.record_id,
    module: call.record_module,
    durationSeconds: call.duration_seconds,
    direction: call.direction,
    userId: call.user_id,
  });
  if (!result) throw new BadRequestError('AI analysis is unavailable — check the API key configuration');
  res.json(result);
}));

aiRouter.get('/coaching/:userId', asyncHandler(async (req, res) => {
  const user = getUser(req);
  // A rep can see their own report; managers can see their team's.
  if (req.params.userId !== user.id) await assertCapability(user, 'telephony.listen_recordings');
  const report = await coachingReport(req.params.userId, Math.min(90, Number(req.query.days) || 30));
  if (!report) throw new NotFoundError('Not enough analysed calls to build a coaching report yet');
  res.json(report);
}));

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

aiRouter.post('/ask', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { question, contextRecordId, contextModule, threadId } = z.object({
    question: z.string().min(2).max(2000),
    contextRecordId: z.string().uuid().optional(),
    contextModule: z.string().optional(),
    threadId: z.string().uuid().optional(),
  }).parse(req.body);

  const result = await ask(question, scope, { contextRecordId, contextModule, threadId });

  // Persist the exchange so the assistant panel has history.
  if (threadId) {
    await db.query(
      `UPDATE ipy_ai_thread
       SET messages = messages || $2::jsonb, updated_at = now()
       WHERE id = $1 AND user_id = $3`,
      [
        threadId,
        JSON.stringify([
          { role: 'user', content: question, at: new Date().toISOString() },
          { role: 'assistant', content: result.answer, at: new Date().toISOString(), query: result.query },
        ]),
        scope.user.id,
      ],
    );
  }

  res.json(result);
}));

/** NL → filter without running it, so the UI can preview and let the user edit. */
aiRouter.post('/parse-query', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { question, module } = z.object({
    question: z.string().min(2),
    module: z.string().optional(),
  }).parse(req.body);

  const parsed = await parseNaturalQuery(question, scope, module);
  if (!parsed) throw new BadRequestError('Could not interpret that query');
  res.json(parsed);
}));

aiRouter.get('/threads', asyncHandler(async (req, res) => {
  const rows = await db.query(
    `SELECT id, title, context_record_id, context_module, updated_at
     FROM ipy_ai_thread WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 30`,
    [getUser(req).id],
  );
  res.json(rows.rows);
}));

aiRouter.post('/threads', asyncHandler(async (req, res) => {
  const { title, contextRecordId, contextModule } = z.object({
    title: z.string().optional(),
    contextRecordId: z.string().uuid().optional(),
    contextModule: z.string().optional(),
  }).parse(req.body ?? {});

  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_ai_thread (user_id, title, context_record_id, context_module)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [getUser(req).id, title ?? 'New conversation', contextRecordId ?? null, contextModule ?? null],
  );
  res.status(201).json({ id: row?.id });
}));

aiRouter.get('/threads/:id', asyncHandler(async (req, res) => {
  const row = await db.queryOne(
    `SELECT * FROM ipy_ai_thread WHERE id = $1 AND user_id = $2`,
    [req.params.id, getUser(req).id],
  );
  if (!row) throw new NotFoundError('Thread not found');
  res.json(row);
}));

aiRouter.delete('/threads/:id', asyncHandler(async (req, res) => {
  await db.query(`DELETE FROM ipy_ai_thread WHERE id = $1 AND user_id = $2`, [req.params.id, getUser(req).id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Digest & insights
// ---------------------------------------------------------------------------

aiRouter.get('/digest', asyncHandler(async (req, res) => {
  const digest = await dailyDigest(getScope(req));
  res.json(digest ?? { greeting: '', priorities: [], summary: '', stats: {} });
}));

aiRouter.post('/insight', asyncHandler(async (req, res) => {
  const { scope: aiScope, prompt } = z.object({
    scope: z.string().default('sales_overview'),
    prompt: z.string().optional(),
  }).parse(req.body ?? {});
  res.json({ insight: await dashboardInsight(getScope(req), aiScope, prompt) });
}));

/** Stored insights for a record — the sidebar panel. */
aiRouter.get('/insights/:recordId', asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const record = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1`, [req.params.recordId],
  );
  if (!record) throw new NotFoundError('Record not found');
  if (!(await canAccessRecord(scope, record.module_name, req.params.recordId, 'view'))) throw new NotFoundError();

  const rows = await db.query(
    `SELECT id, kind, title, body, data, score, confidence, model, created_at
     FROM ipy_ai_insight
     WHERE record_id = $1 AND dismissed_at IS NULL
     ORDER BY created_at DESC LIMIT 20`,
    [req.params.recordId],
  );
  res.json(rows.rows);
}));

aiRouter.post('/insights/:id/dismiss', asyncHandler(async (req, res) => {
  await db.query(`UPDATE ipy_ai_insight SET dismissed_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

aiRouter.get('/usage', asyncHandler(async (req, res) => {
  await assertCapability(getUser(req), 'admin.access');
  const [byFeature, daily] = await Promise.all([
    db.query(
      `SELECT feature, COUNT(*)::int AS calls,
              SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens,
              ROUND(AVG(latency_ms))::int AS avg_latency_ms,
              COUNT(*) FILTER (WHERE success = false)::int AS failures
       FROM ipy_ai_log WHERE created_at > now() - interval '30 days'
       GROUP BY feature ORDER BY calls DESC`,
    ),
    db.query(
      `SELECT date_trunc('day', created_at)::date::text AS day,
              COUNT(*)::int AS calls, SUM(input_tokens + output_tokens)::int AS tokens
       FROM ipy_ai_log WHERE created_at > now() - interval '30 days'
       GROUP BY 1 ORDER BY 1`,
    ),
  ]);
  res.json({ byFeature: byFeature.rows, daily: daily.rows });
}));
