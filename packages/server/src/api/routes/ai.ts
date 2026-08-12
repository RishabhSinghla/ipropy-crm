import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import multer from 'multer';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';
import { assertCapability, canAccessRecord, getFieldPermissions } from '../../core/permissions/index.js';
import { aiStatus, isAiAvailable } from '../../ai/client.js';
import {
  isSttConfigured, SttError, transcribeAudio, transcribeRecording,
} from '../../core/stt/index.js';
import { scoreLead } from '../../ai/leadScoring.js';
import { matchForRecord, matchProperties, matchBuyersForProperty, loadRequirement } from '../../ai/matching.js';
import { draftMessage, summariseRecord } from '../../ai/drafting.js';
import { analyseTranscript, coachingReport } from '../../ai/callAnalysis.js';
import { ask, dailyDigest, dashboardInsight, parseNaturalQuery } from '../../ai/assistant.js';
import {
  actionStatuses, cancelAssistantAction, confirmAssistantAction,
  type AssistantActionProposal,
} from '../../ai/assistantActions.js';
import {
  extractMemoryFact, forgetMemory, listMemories, memoryPrompt, rememberFact,
} from '../../ai/assistantMemory.js';

export const aiRouter = Router();
aiRouter.use(requireAuth);

/**
 * A budget for the routes that actually call a model.
 *
 * Everything here costs a provider request, and the provider is on a free tier
 * with a daily cap — so the scarce resource is not this server's CPU, it is the
 * quota the whole organisation shares for the rest of the day. The general
 * 600/min API limit is no protection: a loop left running in a browser tab, or
 * one impatient person hammering Ask iPropy, exhausts a free tier in about a
 * minute and every AI feature silently drops to its fallback rules for everyone
 * else.
 *
 * Keyed per user rather than per IP, because the office shares one address and
 * one person's runaway tab must not spend the team's day.
 *
 * Deliberately applied per route rather than to the whole router: `/status` and
 * the thread and memory endpoints are ordinary database reads that the UI polls,
 * and rationing those would only make the assistant feel broken.
 */
const modelLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ai:${(req as { user?: { id?: string } }).user?.id ?? req.ip ?? 'unknown'}`,
  message: {
    error: 'rate_limited',
    message: 'Too many AI requests in a row. Give it a minute — this protects the shared daily quota.',
  },
});

const assistantAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, done) => {
    done(null, file.mimetype.startsWith('audio/') || file.mimetype === 'video/webm');
  },
});

async function readableAiFields(user: ReturnType<typeof getUser>, module: string): Promise<string[] | undefined> {
  if (user.isAdmin) return undefined;
  const permissions = await getFieldPermissions(user, module);
  return [...permissions.entries()]
    .filter(([, permission]) => permission !== 'hidden')
    .map(([name]) => name);
}

aiRouter.get('/status', asyncHandler(async (_req, res) => {
  const status = aiStatus();
  res.json({
    ...status,
    message: status.available
      ? `AI features are active (${status.provider}, ${status.model}).`
      : 'No AI provider is configured. Add a key under Admin → Integrations — Google Gemini, Groq and OpenRouter all have a free tier. Rule-based scoring and matching still work without one.',
  });
}));

// ---------------------------------------------------------------------------
// Scoring & analysis
// ---------------------------------------------------------------------------

aiRouter.post('/score-lead/:id', modelLimiter, asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, 'leads', req.params.id, 'view'))) throw new NotFoundError();
  const result = await scoreLead(req.params.id);
  if (!result) throw new NotFoundError('Lead not found');
  res.json(result);
}));

// ---------------------------------------------------------------------------
// Property matching
// ---------------------------------------------------------------------------

aiRouter.get('/match/:module/:id', modelLimiter, asyncHandler(async (req, res) => {
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
aiRouter.post('/match', modelLimiter, asyncHandler(async (req, res) => {
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
aiRouter.get('/buyers-for/:propertyId', modelLimiter, asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, 'properties', req.params.propertyId, 'view'))) throw new NotFoundError();
  res.json({ buyers: await matchBuyersForProperty(req.params.propertyId, Math.min(25, Number(req.query.limit) || 10)) });
}));

// ---------------------------------------------------------------------------
// Drafting & summarising
// ---------------------------------------------------------------------------

aiRouter.post('/draft', modelLimiter, asyncHandler(async (req, res) => {
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

  const draft = await draftMessage({
    ...input,
    userId: user.id,
    visibleFields: await readableAiFields(user, input.module),
  });
  if (!draft) throw new BadRequestError('AI drafting is unavailable — check the API key configuration');
  res.json(draft);
}));

aiRouter.post('/summarise/:module/:id', modelLimiter, asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { module, id } = req.params;
  if (!(await canAccessRecord(scope, module, id, 'view'))) throw new NotFoundError();
  const visible = await readableAiFields(scope.user, module);
  const summary = await summariseRecord(id, module, scope.user.id, visible ? new Set(visible) : undefined);
  if (!summary) throw new BadRequestError('AI summarisation is unavailable');
  res.json({ summary });
}));

// ---------------------------------------------------------------------------
// Call intelligence
// ---------------------------------------------------------------------------

/** Transcribe a call recording so analysis can run without a manual transcript. */
aiRouter.post('/calls/:id/transcribe', modelLimiter, asyncHandler(async (req, res) => {
  const call = await db.queryOne<{ id: string; recording_url: string | null; user_id: string | null }>(
    `SELECT id, recording_url, user_id FROM ipy_call WHERE id = $1`,
    [req.params.id],
  );
  if (!call) throw new NotFoundError('Call not found');
  const user = getUser(req);
  if (call.user_id !== user.id && !user.isAdmin) {
    await assertCapability(user, 'telephony.listen_recordings');
  }
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

aiRouter.post('/calls/:id/analyse', modelLimiter, asyncHandler(async (req, res) => {
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
  const user = getUser(req);
  if (call.user_id !== user.id && !user.isAdmin) {
    await assertCapability(user, 'telephony.listen_recordings');
  }

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

aiRouter.get('/coaching/:userId', modelLimiter, asyncHandler(async (req, res) => {
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

interface StoredAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  query?: unknown;
  action?: AssistantActionProposal;
  choices?: unknown;
}

interface AssistantThreadRow {
  id: string;
  title: string | null;
  context_record_id: string | null;
  context_module: string | null;
  messages: StoredAssistantMessage[];
  created_at: string;
  updated_at: string;
}

function conversationPrompt(messages: StoredAssistantMessage[]): string {
  return messages.slice(-14).map((message) => {
    const speaker = message.role === 'user' ? 'User' : 'Ask iPropy';
    return `${speaker}: ${message.content.replace(/\s+/g, ' ').slice(0, 1_200)}`;
  }).join('\n').slice(-8_000);
}

function threadTitle(question: string): string {
  const compact = question.replace(/\s+/g, ' ').trim();
  return compact.length > 60 ? `${compact.slice(0, 57)}…` : compact;
}

async function assertAssistantContext(
  scope: ReturnType<typeof getScope>,
  recordId?: string | null,
  module?: string | null,
): Promise<void> {
  if (!recordId && !module) return;
  if (!recordId || !module) throw new BadRequestError('A record and its CRM module must be supplied together');
  const record = await db.queryOne<{ module_name: string }>(
    `SELECT module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [recordId],
  );
  if (!record || record.module_name !== module || !(await canAccessRecord(scope, module, recordId, 'view'))) {
    throw new NotFoundError('Record not found');
  }
}

async function appendThreadMessages(
  threadId: string,
  userId: string,
  messages: StoredAssistantMessage[],
  firstQuestion?: string,
): Promise<void> {
  await db.query(
    `UPDATE ipy_ai_thread
     SET messages = messages || $3::jsonb,
         title = CASE
           WHEN jsonb_array_length(messages) = 0
            AND (title IS NULL OR title = '' OR title = 'New conversation')
           THEN $4
           ELSE title
         END,
         updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [threadId, userId, JSON.stringify(messages), firstQuestion ? threadTitle(firstQuestion) : null],
  );
}

aiRouter.post('/ask', modelLimiter, asyncHandler(async (req, res) => {
  const scope = getScope(req);
  const { question, contextRecordId, contextModule, threadId } = z.object({
    question: z.string().min(2).max(2000),
    contextRecordId: z.string().uuid().optional(),
    contextModule: z.string().optional(),
    threadId: z.string().uuid().optional(),
  }).parse(req.body);

  let thread: AssistantThreadRow | null = null;
  if (threadId) {
    // Ownership is checked before any AI or record lookup. Previously an
    // unknown thread still received an answer and merely failed to persist it.
    thread = await db.queryOne<AssistantThreadRow>(
      `SELECT id, title, context_record_id, context_module, messages, created_at, updated_at
       FROM ipy_ai_thread WHERE id = $1 AND user_id = $2`,
      [threadId, scope.user.id],
    );
    if (!thread) throw new NotFoundError('Conversation not found');
  } else {
    await assertAssistantContext(scope, contextRecordId, contextModule);
    thread = await db.queryOne<AssistantThreadRow>(
      `INSERT INTO ipy_ai_thread (user_id, title, context_record_id, context_module)
       VALUES ($1,'New conversation',$2,$3)
       RETURNING id, title, context_record_id, context_module, messages, created_at, updated_at`,
      [scope.user.id, contextRecordId ?? null, contextModule ?? null],
    );
  }
  if (!thread) throw new Error('Could not create assistant conversation');

  const effectiveRecordId = thread.context_record_id ?? contextRecordId;
  const effectiveModule = thread.context_module ?? contextModule;
  await assertAssistantContext(scope, effectiveRecordId, effectiveModule);

  const at = new Date().toISOString();
  const memoryFact = extractMemoryFact(question);
  if (memoryFact) {
    const remembered = await rememberFact(scope.user.id, memoryFact, thread.id);
    const answer = `I’ll remember that: ${remembered.fact}. You can review or remove saved memory from the History panel.`;
    await appendThreadMessages(thread.id, scope.user.id, [
      { role: 'user', content: question, at },
      { role: 'assistant', content: answer, at: new Date().toISOString() },
    ], question);
    res.json({ answer, threadId: thread.id, remembered });
    return;
  }

  const memories = await listMemories(scope.user.id, 20);
  const result = await ask(question, scope, {
    contextRecordId: effectiveRecordId ?? undefined,
    contextModule: effectiveModule ?? undefined,
    threadId: thread.id,
    conversationContext: conversationPrompt(thread.messages ?? []),
    memoryContext: memoryPrompt(memories),
  });

  await appendThreadMessages(thread.id, scope.user.id, [
    { role: 'user', content: question, at },
    {
      role: 'assistant',
      content: result.answer,
      at: new Date().toISOString(),
      query: result.query,
      action: result.action,
      choices: result.choices,
    },
  ], question);

  res.json({ ...result, threadId: thread.id });
}));

/** Browser-recorded voice → text for the assistant compose box. */
aiRouter.post('/transcribe', modelLimiter, assistantAudioUpload.single('audio'), asyncHandler(async (req, res) => {
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw new BadRequestError('Record a voice question first');

  const { getSettings } = await import('../../core/settings/integrations.js');
  const settings = getSettings().stt;
  if (!isSttConfigured(settings)) {
    throw new BadRequestError('Speech-to-text is not configured. Add it under Admin → Integrations.');
  }
  try {
    const transcript = await transcribeAudio(file.buffer, file.originalname || 'ask-ipropy.webm', settings, {
      prompt: 'iPropy CRM, Faridabad, property, builder floor, BHK, square yards, crore, lakh, lead, follow-up',
    });
    res.json({ transcript });
  } catch (err) {
    if (err instanceof SttError) throw new BadRequestError(err.message);
    throw err;
  }
}));

/** NL → filter without running it, so the UI can preview and let the user edit. */
aiRouter.post('/parse-query', modelLimiter, asyncHandler(async (req, res) => {
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
  const rows = await db.query<{
    id: string; title: string | null; context_record_id: string | null; context_module: string | null;
    updated_at: string; message_count: number; preview: string | null;
  }>(
    `SELECT id, title, context_record_id, context_module, updated_at,
            jsonb_array_length(messages)::int AS message_count,
            messages->-1->>'content' AS preview
     FROM ipy_ai_thread WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 30`,
    [getUser(req).id],
  );
  res.json(rows.rows.map((row) => ({
    id: row.id,
    title: row.title ?? 'New conversation',
    contextRecordId: row.context_record_id,
    contextModule: row.context_module,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    preview: row.preview,
  })));
}));

aiRouter.post('/threads', asyncHandler(async (req, res) => {
  const { title, contextRecordId, contextModule } = z.object({
    title: z.string().trim().min(1).max(80).optional(),
    contextRecordId: z.string().uuid().optional(),
    contextModule: z.string().optional(),
  }).refine((input) => Boolean(input.contextRecordId) === Boolean(input.contextModule), {
    message: 'A record and module must be supplied together',
  }).parse(req.body ?? {});

  await assertAssistantContext(getScope(req), contextRecordId, contextModule);

  const row = await db.queryOne<{ id: string; title: string }>(
    `INSERT INTO ipy_ai_thread (user_id, title, context_record_id, context_module)
     VALUES ($1,$2,$3,$4) RETURNING id, title`,
    [getUser(req).id, title ?? 'New conversation', contextRecordId ?? null, contextModule ?? null],
  );
  res.status(201).json(row);
}));

aiRouter.get('/threads/:id', asyncHandler(async (req, res) => {
  const row = await db.queryOne<AssistantThreadRow>(
    `SELECT id, title, context_record_id, context_module, messages, created_at, updated_at
     FROM ipy_ai_thread WHERE id = $1 AND user_id = $2`,
    [req.params.id, getUser(req).id],
  );
  if (!row) throw new NotFoundError('Thread not found');
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const ids = messages.flatMap((message) => message.action?.id ? [message.action.id] : []);
  const statuses = await actionStatuses(ids, getUser(req).id);
  const enriched = messages.map((message) => message.action?.id
    ? { ...message, action: { ...message.action, status: statuses.get(message.action.id) ?? message.action.status } }
    : message);
  res.json({
    id: row.id,
    title: row.title ?? 'New conversation',
    contextRecordId: row.context_record_id,
    contextModule: row.context_module,
    messages: enriched,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}));

aiRouter.patch('/threads/:id', asyncHandler(async (req, res) => {
  const { title } = z.object({ title: z.string().trim().min(1).max(80) }).parse(req.body);
  const row = await db.queryOne<{ id: string; title: string }>(
    `UPDATE ipy_ai_thread SET title = $3, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING id, title`,
    [req.params.id, getUser(req).id, title],
  );
  if (!row) throw new NotFoundError('Thread not found');
  res.json(row);
}));

aiRouter.delete('/threads/:id', asyncHandler(async (req, res) => {
  const result = await db.query(
    `DELETE FROM ipy_ai_thread WHERE id = $1 AND user_id = $2`,
    [req.params.id, getUser(req).id],
  );
  if (!result.rowCount) throw new NotFoundError('Thread not found');
  res.json({ ok: true });
}));

aiRouter.post('/actions/:id/confirm', asyncHandler(async (req, res) => {
  const result = await confirmAssistantAction(req.params.id, getScope(req));
  await appendThreadMessages(result.threadId, getUser(req).id, [{
    role: 'assistant', content: result.answer, at: new Date().toISOString(), action: result.action,
  }]);
  res.json(result);
}));

aiRouter.delete('/actions/:id', asyncHandler(async (req, res) => {
  const result = await cancelAssistantAction(req.params.id, getUser(req).id);
  const answer = 'Cancelled — no CRM data was changed.';
  await appendThreadMessages(result.threadId, getUser(req).id, [{
    role: 'assistant', content: answer, at: new Date().toISOString(), action: result.action,
  }]);
  res.json({ action: result.action, answer });
}));

aiRouter.get('/memory', asyncHandler(async (req, res) => {
  res.json(await listMemories(getUser(req).id));
}));

aiRouter.delete('/memory/:id', asyncHandler(async (req, res) => {
  if (!(await forgetMemory(getUser(req).id, req.params.id))) throw new NotFoundError('Memory not found');
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
