/**
 * Bridge between the workflow engine's `ai_action` task and the AI modules.
 * Config declares which action to run and where to write the result, so admins
 * can add AI steps to any workflow without code.
 */
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import type { TaskContext } from '../core/workflow/tasks.js';
import { scoreLead } from './leadScoring.js';
import { matchForRecord } from './matching.js';
import { draftMessage, summariseRecord } from './drafting.js';
import { saveInsight, complete, isAiAvailable, REAL_ESTATE_SYSTEM } from './client.js';

type WriteMap = Record<string, string>;

export async function runAiWorkflowAction(
  action: string,
  config: Record<string, unknown>,
  ctx: TaskContext,
): Promise<void> {
  const writeTo = (config.writeTo ?? {}) as WriteMap;

  switch (action) {
    case 'score_lead': {
      const result = await scoreLead(ctx.recordId);
      if (result) {
        logger.debug({ recordId: ctx.recordId, score: result.score }, 'workflow scored lead');
      }
      break;
    }

    case 'match_properties': {
      const matches = await matchForRecord(ctx.recordId, {
        limit: Number(config.limit ?? 5),
        withNarrative: config.withNarrative !== false,
        persist: true,
      });
      if (matches.length && ctx.record.owner_id) {
        await db.query(
          `INSERT INTO ipy_notification (user_id, kind, title, body, link, record_id)
           VALUES ($1,'ai','Property matches ready',$2,$3,$4)`,
          [
            ctx.record.owner_id,
            `${matches.length} units match ${ctx.record.__label ?? 'this buyer'}. Top pick: ${matches[0].propertyLabel}.`,
            `/${ctx.module}/${ctx.recordId}`,
            ctx.recordId,
          ],
        );
      }
      break;
    }

    case 'draft_message': {
      const draft = await draftMessage({
        channel: (config.channel as 'whatsapp' | 'email' | 'sms') ?? 'whatsapp',
        recordId: ctx.recordId,
        module: ctx.module,
        goal: config.goal ? String(config.goal) : undefined,
        tone: config.tone as 'warm' | 'professional' | 'urgent' | 'consultative' | undefined,
        includeProperties: config.includeProperties !== false,
      });
      if (draft) {
        // Stash it on the context so a following send task can pick it up.
        (ctx as unknown as { aiDraft?: string }).aiDraft = draft.body;
        await saveInsight({
          recordId: ctx.recordId,
          module: ctx.module,
          kind: 'next_best_action',
          title: 'Suggested message',
          body: draft.body,
          data: { channel: config.channel ?? 'whatsapp', subject: draft.subject },
        });
      }
      break;
    }

    case 'summarise_record': {
      const summary = await summariseRecord(ctx.recordId, ctx.module);
      if (summary) {
        await saveInsight({
          recordId: ctx.recordId, module: ctx.module, kind: 'summary',
          title: 'Record summary', body: summary, replace: true,
        });
        await writeBack(ctx, writeTo.summary, summary);
      }
      break;
    }

    case 'summarise_visit': {
      const result = await summariseSiteVisit(ctx);
      if (result) {
        await writeBack(ctx, writeTo.summary, result.summary);
        await writeBack(ctx, writeTo.sentiment, result.sentiment);
      }
      break;
    }

    case 'classify': {
      const value = await classify(ctx, String(config.question ?? ''), (config.options as string[]) ?? []);
      if (value) await writeBack(ctx, writeTo.result ?? String(config.field ?? ''), value);
      break;
    }

    default:
      logger.warn({ action }, 'unknown AI workflow action');
  }
}

/** Write an AI result into a field on the triggering record. */
async function writeBack(ctx: TaskContext, fieldName: string | undefined, value: unknown): Promise<void> {
  if (!fieldName || value === undefined || value === null) return;
  const { updateRecord } = await import('../core/entity/recordService.js');
  const { registry } = await import('../core/metadata/registry.js');

  const meta = await registry.getModule(ctx.module);
  if (!meta?.fields.some((f) => f.name === fieldName)) {
    logger.warn({ fieldName, module: ctx.module }, 'AI writeTo target field does not exist');
    return;
  }

  const actor = ctx.user ?? {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'system@ipropy', firstName: 'iPropy', lastName: 'AI', fullName: 'iPropy AI',
    avatarUrl: null, phone: null, isAdmin: true, isActive: true,
    roleId: null, roleName: null, profileId: null, profileName: null, groupIds: [],
    timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR',
    theme: 'system' as const, defaultDashboardId: null, extension: null, lastLoginAt: null,
  };

  await updateRecord(
    { user: actor, subordinateIds: [], groupIds: [], system: true, source: 'ai' },
    ctx.module, ctx.recordId, { [fieldName]: value }, { skipWorkflow: true },
  ).catch((err) => logger.warn({ err, fieldName }, 'AI write-back failed'));
}

async function summariseSiteVisit(ctx: TaskContext): Promise<{ summary: string; sentiment: string } | null> {
  if (!isAiAvailable()) return null;

  const feedback = ctx.record.feedback as string | null;
  const objections = ctx.record.objections as string[] | null;
  const interest = ctx.record.interest_level as string | null;
  const nextStep = ctx.record.next_step as string | null;

  if (!feedback && !objections?.length && !interest) return null;

  const parsed = await import('./client.js').then((m) => m.completeJson<{ summary: string; sentiment: string }>({
    feature: 'summarise_visit',
    system: REAL_ESTATE_SYSTEM,
    prompt: `Summarise this site visit for the record.

Interest level: ${interest ?? '—'}
Objections raised: ${objections?.join(', ') || '—'}
Rep's feedback notes: ${feedback ?? '—'}
Agreed next step: ${nextStep ?? '—'}

Return JSON:
{
  "summary": "<2-3 sentences: what the buyer responded to, what held them back, and what happens next>",
  "sentiment": "positive" | "neutral" | "negative"
}`,
    fast: true,
    maxTokens: 500,
    recordId: ctx.recordId,
  }));

  if (!parsed?.summary) return null;
  return {
    summary: parsed.summary,
    sentiment: ['positive', 'neutral', 'negative'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
  };
}

/** Generic classifier — pick one of `options` given the record's context. */
async function classify(ctx: TaskContext, question: string, options: string[]): Promise<string | null> {
  if (!isAiAvailable() || !question || !options.length) return null;

  const { buildRecordSummary } = await import('./drafting.js');
  const summary = await buildRecordSummary(ctx.recordId, ctx.module);

  const result = await complete({
    feature: 'classify',
    system: REAL_ESTATE_SYSTEM,
    prompt: `${question}

## Record
${summary}

Answer with exactly one of these values and nothing else:
${options.join('\n')}`,
    fast: true,
    maxTokens: 50,
    temperature: 0,
    recordId: ctx.recordId,
  });

  const answer = result?.text.trim();
  if (!answer) return null;
  // Only accept an exact option, so a chatty model can't corrupt the field.
  return options.find((o) => o.toLowerCase() === answer.toLowerCase()) ?? null;
}
