/**
 * Call intelligence.
 *
 * Takes a transcript (supplied by the telephony provider, an external STT
 * service, or typed in by the rep) and extracts the things a sales manager
 * actually needs: what was agreed, what the objections were, sentiment, and the
 * next actions — which are then created as real tasks.
 */
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { completeJson, isAiAvailable, saveInsight, REAL_ESTATE_SYSTEM } from './client.js';
import { buildRecordSummary } from './drafting.js';

export interface CallAnalysis {
  summary: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  objections: string[];
  nextActions: string[];
  disposition: string | null;
  talkRatio: number | null;
  score: number | null;
  /** field updates the analysis implies, e.g. a stated budget */
  extractedFields: Record<string, unknown>;
  coaching: string | null;
}

export async function analyseCallRecording(callId: string): Promise<CallAnalysis | null> {
  const call = await db.queryOne<{
    id: string; transcript: string | null; record_id: string | null; record_module: string | null;
    duration_seconds: number; direction: string; user_id: string | null;
  }>(
    `SELECT id, transcript, record_id, record_module, duration_seconds, direction, user_id
     FROM ipy_call WHERE id = $1`,
    [callId],
  );

  if (!call) return null;
  if (!call.transcript) {
    logger.debug({ callId }, 'call analysis skipped — no transcript available');
    return null;
  }
  return analyseTranscript(call.id, call.transcript, {
    recordId: call.record_id,
    module: call.record_module,
    durationSeconds: call.duration_seconds,
    direction: call.direction,
    userId: call.user_id,
  });
}

export async function analyseTranscript(
  callId: string,
  transcript: string,
  meta: {
    recordId: string | null;
    module: string | null;
    durationSeconds: number;
    direction: string;
    userId: string | null;
  },
): Promise<CallAnalysis | null> {
  if (!isAiAvailable()) return null;

  const context = meta.recordId && meta.module
    ? await buildRecordSummary(meta.recordId, meta.module)
    : '';

  const dispositions = await db.query<{ value: string }>(
    `SELECT v.value FROM ipy_picklist_value v JOIN ipy_picklist p ON p.id = v.picklist_id
     WHERE p.name = 'call_disposition' AND v.is_active ORDER BY v.sequence`,
  );

  const prompt = `Analyse this sales call transcript.

${context ? `## Who they are\n${context}\n` : ''}
## Call
Direction: ${meta.direction}
Duration: ${Math.round(meta.durationSeconds / 60)} minutes

## Transcript
${transcript.slice(0, 24_000)}

Extract what a sales manager needs. Be precise — quote or paraphrase only what was actually said.

Allowed dispositions: ${dispositions.rows.map((d) => d.value).join(', ')}

Return JSON:
{
  "summary": "<3-4 sentences: what the buyer wants, what was agreed, what is blocking>",
  "sentiment": "positive" | "neutral" | "negative",
  "objections": [<concerns the buyer actually raised>],
  "nextActions": [<concrete follow-ups the rep committed to or should take>],
  "disposition": <one of the allowed dispositions, or null>,
  "talkRatio": <estimated % of the call the AGENT spoke, 0-100, or null>,
  "score": <call quality 0-100: did the rep qualify, handle objections, and secure a next step?>,
  "extractedFields": {
    "budget_max": <number in rupees if a budget was stated, else omit>,
    "possession_timeline": <"Immediate" | "Within 1 Month" | "1-3 Months" | "3-6 Months" | "6-12 Months" | "Just Exploring", if stated>,
    "configuration": [<BHK types mentioned, e.g. "3 BHK">],
    "preferred_locations": [<areas mentioned>],
    "funding_type": <"Self Funded" | "Home Loan" | "Loan Pre-Approved", if stated>
  },
  "coaching": "<one specific, actionable coaching note for the rep, or null>"
}

Omit any extractedFields key that was not explicitly stated. Never guess a budget.`;

  const parsed = await completeJson<CallAnalysis>({
    feature: 'call_analysis',
    system: REAL_ESTATE_SYSTEM,
    prompt,
    maxTokens: 1800,
    recordId: meta.recordId,
    userId: meta.userId,
  });
  if (!parsed?.summary) return null;

  await db.query(
    `UPDATE ipy_call
     SET ai_summary = $2, ai_sentiment = $3, ai_next_actions = $4, ai_objections = $5,
         ai_talk_ratio = $6, ai_score = $7, ai_analysed_at = now(),
         disposition = COALESCE(disposition, $8)
     WHERE id = $1`,
    [
      callId, parsed.summary, normaliseSentiment(parsed.sentiment),
      JSON.stringify(parsed.nextActions ?? []), JSON.stringify(parsed.objections ?? []),
      parsed.talkRatio ?? null, parsed.score ?? null, parsed.disposition ?? null,
    ],
  );

  if (meta.recordId) {
    await saveInsight({
      recordId: meta.recordId,
      module: meta.module,
      kind: 'summary',
      title: 'Call analysed',
      body: [
        parsed.summary,
        parsed.objections?.length ? `\n**Objections:** ${parsed.objections.join('; ')}` : '',
        parsed.nextActions?.length ? `\n**Next actions:** ${parsed.nextActions.join('; ')}` : '',
      ].filter(Boolean).join('\n'),
      data: { callId, ...parsed },
      score: parsed.score ?? null,
    });

    await applyExtractedFields(meta.recordId, meta.module, parsed.extractedFields ?? {});
    await createFollowUpTasks(meta.recordId, meta.module, parsed.nextActions ?? [], meta.userId);

    // A fresh call materially changes the picture — re-score.
    if (meta.module === 'leads') {
      const { scoreLead } = await import('./leadScoring.js');
      void scoreLead(meta.recordId).catch((err) => logger.warn({ err }, 're-scoring after call failed'));
    }
  }

  return parsed;
}

function normaliseSentiment(s: string | undefined): string | null {
  if (!s) return null;
  const v = s.toLowerCase();
  return ['positive', 'neutral', 'negative'].includes(v) ? v : null;
}

/**
 * Write back facts the buyer stated on the call — but only into fields that are
 * currently empty, so the AI never overwrites something a human entered.
 */
async function applyExtractedFields(
  recordId: string,
  module: string | null,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!module || !Object.keys(fields).length) return;

  const { registry } = await import('../core/metadata/registry.js');
  const meta = await registry.getModule(module);
  if (!meta) return;

  const allowed = new Set(meta.fields.filter((f) => f.isActive && !f.isReadonly).map((f) => f.name));
  const updates: Record<string, unknown> = {};

  const current = await db.queryOne<Record<string, unknown>>(
    `SELECT * FROM ${meta.tableName} WHERE record_id = $1`, [recordId],
  );
  if (!current) return;

  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && !value.length) continue;

    const field = meta.fields.find((f) => f.name === key);
    const existing = field?.storage === 'column'
      ? current[field.columnName]
      : (current.custom_fields as Record<string, unknown> | null)?.[field?.columnName ?? key];

    const isEmpty = existing === null || existing === undefined || existing === ''
      || (Array.isArray(existing) && existing.length === 0);
    if (isEmpty) updates[key] = value;
  }

  if (!Object.keys(updates).length) return;

  const { updateRecord } = await import('../core/entity/recordService.js');
  const systemUser = await getSystemActor();
  await updateRecord(
    { user: systemUser, subordinateIds: [], groupIds: [], system: true, source: 'ai_call_analysis' },
    module, recordId, updates, { skipWorkflow: true },
  ).catch((err) => logger.warn({ err, recordId }, 'failed to apply extracted fields'));

  logger.info({ recordId, fields: Object.keys(updates) }, 'AI enriched record from call');
}

async function createFollowUpTasks(
  recordId: string,
  module: string | null,
  actions: string[],
  userId: string | null,
): Promise<void> {
  if (!actions.length || !module) return;
  const { scheduleFollowUp } = await import('../core/workflow/followUp.js');
  const owner = await db.queryOne<{ owner_id: string | null }>(
    `SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId],
  );

  // One follow-up, listing what the call actually committed to. This used to
  // create up to three task records; three rows all due tomorrow against the
  // same lead was noise, and the lead only has one next-follow-up date anyway.
  await scheduleFollowUp({
    recordId,
    module,
    on: new Date(Date.now() + 86_400_000),
    reason: 'Next steps from the last call',
    notes: actions.slice(0, 5).map((a) => `• ${a.slice(0, 200)}`).join('\n'),
    ownerId: owner?.owner_id ?? userId,
    authorId: owner?.owner_id ?? userId,
    onlyIfSooner: true,
  });
}

async function getSystemActor() {
  const admin = await db.queryOne<{ id: string; email: string; first_name: string; last_name: string }>(
    `SELECT id, email, first_name, last_name FROM ipy_user WHERE is_admin = true AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  return {
    id: admin?.id ?? '00000000-0000-0000-0000-000000000000',
    email: admin?.email ?? 'system@ipropy',
    firstName: admin?.first_name ?? 'iPropy',
    lastName: admin?.last_name ?? 'AI',
    fullName: 'iPropy AI',
    avatarUrl: null, phone: null, isAdmin: true, isActive: true,
    roleId: null, roleName: null, profileId: null, profileName: null, groupIds: [],
    timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR',
    theme: 'system' as const, defaultDashboardId: null, extension: null, lastLoginAt: null,
  };
}

/** Manager view: coaching themes across a rep's recent calls. */
export async function coachingReport(userId: string, days = 30): Promise<{
  summary: string; strengths: string[]; improvements: string[]; metrics: Record<string, number>;
} | null> {
  if (!isAiAvailable()) return null;

  const calls = await db.query<{
    ai_summary: string | null; ai_sentiment: string | null; ai_objections: string[] | null;
    ai_score: number | null; ai_talk_ratio: number | null; duration_seconds: number; disposition: string | null;
  }>(
    `SELECT ai_summary, ai_sentiment, ai_objections, ai_score, ai_talk_ratio, duration_seconds, disposition
     FROM ipy_call
     WHERE user_id = $1 AND started_at > now() - ($2 || ' days')::interval AND ai_summary IS NOT NULL
     ORDER BY started_at DESC LIMIT 40`,
    [userId, days],
  );
  if (calls.rows.length < 3) return null;

  const metrics = {
    calls: calls.rows.length,
    avgScore: avg(calls.rows.map((c) => c.ai_score).filter((n): n is number => n !== null)),
    avgTalkRatio: avg(calls.rows.map((c) => c.ai_talk_ratio).filter((n): n is number => n !== null)),
    avgDurationMinutes: Math.round(avg(calls.rows.map((c) => c.duration_seconds)) / 60),
    positiveShare: Math.round(
      (calls.rows.filter((c) => c.ai_sentiment === 'positive').length / calls.rows.length) * 100,
    ),
  };

  const prompt = `Review a sales rep's last ${calls.rows.length} calls and write a coaching summary.

## Aggregate metrics
${JSON.stringify(metrics, null, 2)}

## Call summaries
${calls.rows.slice(0, 20).map((c, i) => `${i + 1}. [${c.ai_sentiment ?? '—'}, score ${c.ai_score ?? '—'}, ${c.disposition ?? '—'}] ${c.ai_summary}`).join('\n')}

## Objections encountered
${[...new Set(calls.rows.flatMap((c) => c.ai_objections ?? []))].join(', ') || 'none recorded'}

Return JSON:
{
  "summary": "<3-4 sentences on the rep's overall performance and the pattern you see>",
  "strengths": [<2-3 specific things they do well, with evidence>],
  "improvements": [<2-3 specific, coachable behaviours, each with what to do differently>]
}`;

  const parsed = await completeJson<{ summary: string; strengths: string[]; improvements: string[] }>({
    feature: 'coaching_report',
    system: REAL_ESTATE_SYSTEM,
    prompt,
    maxTokens: 1200,
    userId,
  });
  if (!parsed) return null;

  return { ...parsed, metrics };
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}
