import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import multer from 'multer';
import { db } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { getScope, getUser, requireAuth } from '../../middleware/auth.js';
import { BadRequestError, NotFoundError, ServiceUnavailableError } from '../../utils/errors.js';
import { assertCapability, assertModuleAccess, canAccessRecord, getFieldPermissions } from '../../core/permissions/index.js';
import { aiStatus, complete } from '../../ai/client.js';
import {
  isSttConfigured, SttError, transcribeAudio, transcribeRecording,
} from '../../core/stt/index.js';
import { scoreLead } from '../../ai/leadScoring.js';
import { matchForRecord, matchProperties, matchBuyersForProperty, loadRequirement } from '../../ai/matching.js';
import { draftMessage, summariseRecord } from '../../ai/drafting.js';
import { analyseTranscript, coachingReport } from '../../ai/callAnalysis.js';
import { ask, dailyDigest, dashboardInsight, parseNaturalQuery } from '../../ai/assistant.js';
import {
  actionStatuses, cancelAssistantAction, confirmAssistantAction, pendingActionsForRecord,
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
  keyGenerator: (req) => {
    const userId = (req as { user?: { id?: string } }).user?.id;
    if (userId) return `ai:u:${userId}`;
    return `ai:ip:${req.ip ? ipKeyGenerator(req.ip) : 'unknown'}`;
  },
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
    // Up to 50, because the tab now lets a rep widen the list and work it
    // themselves rather than trusting the top handful. The scorer reads a
    // fixed candidate pool either way, so this only changes how much of the
    // ranking is returned.
    limit: Math.min(50, Number(req.query.limit) || 6),
    withNarrative: req.query.narrative !== 'false',
    persist: true,
    // Matched units are properties: the caller must see the rows the scorer
    // would rank, not just the lead the matches belong to.
    scope,
  });
  res.json({ matches, requirement: await loadRequirement(id) });
}));

/** Ad-hoc matching from a requirement the rep types in. */
aiRouter.post('/match', modelLimiter, asyncHandler(async (req, res) => {
  const scope = getScope(req);
  // An inventory search answers with unit ids, labels and prices — the same
  // things a properties list gives, so it is gated by the same capability.
  await assertModuleAccess(scope.user, 'properties', 'view');
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

  res.json({ matches: await matchProperties(input, { limit: input.limit, withNarrative: input.withNarrative, scope }) });
}));

/** Reverse match: who should we pitch this unit to? */
aiRouter.get('/buyers-for/:propertyId', modelLimiter, asyncHandler(async (req, res) => {
  const scope = getScope(req);
  if (!(await canAccessRecord(scope, 'properties', req.params.propertyId, 'view'))) throw new NotFoundError();
  // The buyer list is a leads list by another name — names, budgets and
  // owners — so it is scoped like one.
  const limit = Math.min(50, Number(req.query.limit) || 10);
  const buyers = await matchBuyersForProperty(req.params.propertyId, limit, scope, {
    withNarrative: req.query.narrative !== 'false',
  });
  res.json({ buyers });
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
    scope,
  });
  /*
    503, not 400. Nothing was wrong with the request — the CRM simply has no
    model to write with, and a 400 tells the browser the rep typed something
    bad. `/api/webhooks/leads/generic` already answers this way when its key is
    missing, and this is the same situation.

    Worth knowing when it happens: drafting is the one AI feature with no
    deterministic half, so unlike matching, scoring, the digest and duplicate
    detection — all of which answer perfectly well with no provider — this
    stops outright. On a free key that runs out mid-month, it stops for the
    rest of the month.
  */
  if (!draft) {
    throw new ServiceUnavailableError(
      'No AI model is connected, so there is nothing to write the draft with. '
      + 'Add a key under Admin → Integrations, or write the message yourself.',
    );
  }
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

  let thread: AssistantThreadRow | null;
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
  const file = req.file;
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

/**
 * Does this record already exist under a different spelling?
 *
 * Asked when somebody opens a record rather than while they type. A live probe
 * per keystroke would be an embedding call per keystroke, and the answer does
 * not change fast enough to be worth that.
 */
aiRouter.get('/records/:module/:id/duplicates', asyncHandler(async (req, res) => {
  const ctx = getScope(req);
  await assertModuleAccess(ctx.user, req.params.module, 'view');
  if (!await canAccessRecord(ctx, req.params.module, req.params.id, 'view')) {
    throw new NotFoundError('Record not found');
  }

  const { suggestDuplicates } = await import('../../core/search/duplicates.js');
  res.json({ duplicates: await suggestDuplicates(ctx, req.params.module, req.params.id) });
}));

/** "Not the same person." Remembered, so the pair is never offered again. */
aiRouter.post('/records/:module/:id/duplicates/dismiss', asyncHandler(async (req, res) => {
  const ctx = getScope(req);
  await assertModuleAccess(ctx.user, req.params.module, 'edit');
  if (!await canAccessRecord(ctx, req.params.module, req.params.id, 'edit')) {
    throw new NotFoundError('Record not found');
  }
  const { otherId } = z.object({ otherId: z.string().uuid() }).parse(req.body);

  const { dismissDuplicate } = await import('../../core/search/duplicates.js');
  await dismissDuplicate(req.params.id, otherId, ctx.user.id);
  res.json({ ok: true });
}));

/**
 * Thirty seconds of talking becomes a note somebody will actually read.
 *
 * Two steps, and the second is the one that matters. Transcription alone gives
 * you what was said: "haan toh Sharma family aaye the woh A-1818 dekhne wale
 * the kitchen bahut pasand aayi unko lekin master bedroom thoda chhota lag raha
 * tha". That is a wall of text nobody scans three weeks later. Tidied, it is
 * four lines with the objection on its own.
 *
 * Nothing is saved. The note comes back to the box for somebody to read, edit
 * and post — which is the rule he set in August and the right one: a model that
 * mishears a budget and writes it into a record on its own is worse than no
 * feature at all.
 */
aiRouter.post('/voice-note', modelLimiter, assistantAudioUpload.single('audio'), asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) throw new BadRequestError('Record something first');

  const { featureOn } = await import('../../core/settings/aiFeatures.js');
  if (!await featureOn('voiceNotes')) {
    throw new BadRequestError('Voice notes are switched off in Admin → Settings → AI features.');
  }

  const { getSettings } = await import('../../core/settings/integrations.js');
  const settings = getSettings().stt;
  if (!isSttConfigured(settings)) {
    throw new BadRequestError(
      'Speech-to-text is not configured. Add an OpenRouter or Groq key under Admin → Integrations.',
    );
  }

  let transcript: string;
  try {
    transcript = await transcribeAudio(file.buffer, file.originalname || 'note.webm', settings, {
      /*
        The prompt is a style sample, not just a word list.

        Whisper conditions on it: given a plain list of jargon it writes the
        jargon correctly and still decides a Hindi-English sentence is Hindi,
        answering in Devanagari. Given a sentence in the register and the script
        the answer should be in — Hinglish, Latin, our vocabulary — it tends to
        continue in that register, which is exactly what the team writes. The
        transliteration pass below is the floor under it when it does not.

        Hindi is explicit so a Hindi/Hinglish clip cannot be returned as Urdu
        script. Any Devanagari output is converted to the team's Latin-script
        Hinglish below; English terms in the prompt remain strong spelling hints.
      */
      language: 'hi',
      prompt: 'Site visit note, iPropy CRM, Faridabad, Greenfield Colony. '
        + 'Client ko 3 BHK builder floor dikhaya, park facing, carpet area 1450 square feet, '
        + 'demand 1.45 crore, token next week, registry ke baad possession. '
        + 'BHK, lakh, crore, square yards, RERA, follow-up.',
    });
  } catch (err) {
    if (err instanceof SttError) throw new BadRequestError(err.message);
    throw err;
  }
  if (!transcript.trim()) throw new BadRequestError('Nothing was said, or the recording was silent.');

  // Notes used to wait for a second language-model request after speech had
  // already been transcribed. On a live sales call that made a ten-second note
  // feel broken. The browser asks for the fast path: return the accurate
  // transcript immediately, with script normalisation but no second network
  // round trip. The slower tidying path remains available to API callers.
  const fast = req.query.fast === 'true';
  let tidied: Awaited<ReturnType<typeof complete>> = null;
  if (!fast) {
    const { modelFor } = await import('../../core/settings/aiModels.js');
    const { houseStyle } = await import('../../core/settings/houseStyle.js');
    const style = await houseStyle();
    tidied = await complete({
    feature: 'voice_note',
    model: await modelFor('copy'),
    system: 'You tidy spoken notes into written ones for a property CRM. You never add a fact that '
      + 'was not said, never guess a number, and never invent a next step. If something was said '
      + 'ambiguously, write it ambiguously. You never translate: a note is written in the words the '
      + 'person used, only in Latin script.',
    prompt: `Somebody spoke this note after dealing with a customer. It is a raw transcript, so it `
      + `rambles, repeats itself and has no punctuation.\n\n"${transcript.slice(0, 8_000)}"\n\n`
      + `Rewrite it as a note a colleague can scan in five seconds.\n\n`
      + `- Keep the words it was spoken in — do not translate it. ${style.voiceLanguage}\n`
      + `- Latin script only. If any of it is written in Devanagari, transliterate it: `
      + `"अभी क्लाइंट से बात हुई" becomes "abhi client se baat hui", not "just spoke to the client".\n`
      + `- An English word said in a Hindi sentence stays the English word: client, site visit, `
      + `budget, token, registry, booking.\n`
      + `- Short lines. Put an objection, a budget or a date on its own line.\n`
      + `- Keep every number, name and date exactly as said.\n`
      + `- Do not add a greeting, a heading, or anything about what to do next unless it was said.\n`
      + `- If the transcript is one short sentence, leave it almost alone.\n\n`
      + `Return only the note.`,
    maxTokens: 900,
    temperature: 0.1,
    userId: getUser(req).id,
    });
  }

  /*
    Latin script is guaranteed here, not hoped for.

    The house style already asks for Hinglish in Latin script and the prompt now
    says it twice, and neither is a guarantee: the model may be unavailable (no
    key, exhausted quota), and a model that does answer sometimes returns the
    Devanagari it was handed. The team does not read Devanagari notes — they
    write "abhi client se baat hui h" — so a mechanical transliteration runs over
    whatever comes back. It is a no-op on a note that is already Latin, which is
    almost all of them.
  */
  const { hasDevanagari, hasUrdu, toLatin } = await import('../../ai/devanagari.js');
  const written = tidied?.text.trim() || transcript.trim();
  const note = toLatin(written);

  res.json({
    // The raw words, transliterated the same way, so what comes back can be
    // checked against what was said without changing scripts halfway.
    transcript: toLatin(transcript),
    // The tidied version when a model answered, and the raw words when none
    // did. A note in somebody's own rambling words still beats losing it.
    note,
    tidied: Boolean(tidied?.text.trim()),
    /** True when the script had to be corrected — useful when this is reported as "it wrote Hindi". */
    transliterated: hasDevanagari(written) || hasUrdu(written),
  });
}));

/**
 * What comparable units of yours were listed at — answered while the record is
 * still being typed, so it takes the shape rather than an id.
 */
aiRouter.get('/comparables', asyncHandler(async (req, res) => {
  const user = getUser(req);
  await assertModuleAccess(user, 'properties', 'view');
  const input = z.object({
    locality: z.string().min(1),
    bedrooms: z.coerce.number().int().min(0),
    area: z.coerce.number().positive().optional(),
    excludeRecordId: z.string().uuid().optional(),
  }).parse(req.query);

  const { comparablesFor } = await import('../../ai/comparables.js');
  res.json({
    comparables: await comparablesFor({
      locality: input.locality,
      bedrooms: input.bedrooms,
      area: input.area ?? null,
      excludeRecordId: input.excludeRecordId ?? null,
    }),
  });
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
  // A proposal from a finished call has no chat thread to write back into.
  if (result.threadId) {
    await appendThreadMessages(result.threadId, getUser(req).id, [{
      role: 'assistant', content: result.answer, at: new Date().toISOString(), action: result.action,
    }]);
  }
  res.json(result);
}));

/** Proposals waiting on this user for one record — shown when the page opens. */
aiRouter.get('/actions', asyncHandler(async (req, res) => {
  const recordId = z.string().uuid().parse(req.query.recordId);
  res.json({ actions: await pendingActionsForRecord(recordId, getUser(req).id) });
}));

aiRouter.delete('/actions/:id', asyncHandler(async (req, res) => {
  const result = await cancelAssistantAction(req.params.id, getUser(req).id);
  const answer = 'Cancelled — no CRM data was changed.';
  if (result.threadId) {
    await appendThreadMessages(result.threadId, getUser(req).id, [{
      role: 'assistant', content: answer, at: new Date().toISOString(), action: result.action,
    }]);
  }
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
  const scope = getScope(req);
  // An insight id is not a capability: check the record it belongs to, so a
  // user who cannot see a record cannot silence its insights either.
  const insight = await db.queryOne<{ record_id: string | null }>(
    `SELECT record_id FROM ipy_ai_insight WHERE id = $1`,
    [req.params.id],
  );
  if (!insight) throw new NotFoundError();

  if (insight.record_id) {
    const record = await db.queryOne<{ module_name: string }>(
      `SELECT module_name FROM ipy_record WHERE id = $1`,
      [insight.record_id],
    );
    if (!record || !(await canAccessRecord(scope, record.module_name, insight.record_id, 'view'))) {
      throw new NotFoundError();
    }
  } else {
    // Record-less insights are account-wide; only an admin can dismiss those.
    await assertCapability(scope.user, 'admin.access');
  }

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
              COUNT(*) FILTER (WHERE success = false)::int AS failures,
              SUM(cost_paise)::bigint AS cost_paise
       FROM ipy_ai_log WHERE created_at > now() - interval '30 days'
       GROUP BY feature ORDER BY cost_paise DESC, calls DESC`,
    ),
    db.query(
      `SELECT date_trunc('day', created_at)::date::text AS day,
              COUNT(*)::int AS calls, SUM(input_tokens + output_tokens)::int AS tokens,
              SUM(cost_paise)::bigint AS cost_paise
       FROM ipy_ai_log WHERE created_at > now() - interval '30 days'
       GROUP BY 1 ORDER BY 1`,
    ),
  ]);
  // The headline number: what the whole month cost. Ordering the table by cost
  // rather than call count puts the expensive feature at the top, which is the
  // one somebody would actually want to switch off.
  const totalPaise = byFeature.rows.reduce((sum, r) => sum + Number(r.cost_paise ?? 0), 0);
  res.json({ byFeature: byFeature.rows, daily: daily.rows, totalPaise });
}));
