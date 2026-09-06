/**
 * Bridge between the workflow engine's `ai_action` task and the AI modules.
 * Config declares which action to run and where to write the result, so admins
 * can add AI steps to any workflow without code.
 */
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import type { TaskContext } from '../core/workflow/tasks.js';
import { notify } from '../core/notifications/index.js';
import { scoreLead } from './leadScoring.js';
import { matchForRecord, matchBuyersForProperty } from './matching.js';
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
        await notify({
          userId: String(ctx.record.owner_id),
          kind: 'ai',
          title: 'Property matches ready',
          body: `${matches.length} units match ${ctx.record.__label ?? 'this buyer'}. Top pick: ${matches[0].propertyLabel}.`,
          link: `/${ctx.module}/${ctx.recordId}`,
          recordId: ctx.recordId,
        });
      }
      break;
    }

    case 'match_buyers': {
      await alertBuyerMatches(ctx, config);
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
    theme: 'system' as const, defaultDashboardId: null, lastLoginAt: null,
  };

  await updateRecord(
    { user: actor, subordinateIds: [], groupIds: [], system: true, source: 'ai' },
    ctx.module, ctx.recordId, { [fieldName]: value }, { skipWorkflow: true },
  ).catch((err) => logger.warn({ err, fieldName }, 'AI write-back failed'));
}

/**
 * How good a fit has to be before it is worth interrupting somebody.
 *
 * `matchBuyersForProperty` returns everything over 55, which is the right floor
 * for a list you asked to see. An alert is different: it arrives unasked, and a
 * feed of weak matches is one people learn to ignore within a week — at which
 * point the strong ones are lost too. 70 is roughly "budget and configuration
 * both fit", which is the point a rep would actually pick up the phone.
 */
const MIN_ALERT_SCORE = 70;

/** The shape `matchBuyersForProperty` returns, narrowed to what an alert needs. */
export interface AlertableMatch {
  recordId: string;
  label: string;
  score: number;
  ownerId: string | null;
  /** Set when this person previously said no, explaining what has changed. */
  revival?: string;
}

/**
 * One bucket per rep, so each person gets a single alert about all of their
 * buyers rather than one per buyer.
 *
 * An unowned lead falls to whoever owns the unit. Dropping it would be the
 * quiet failure: nobody owns it precisely because nobody has looked at it, and
 * an unassigned enquiry that matches today's stock is the most valuable one
 * there is.
 */
export function groupMatchesByRep<T extends AlertableMatch>(
  matches: T[],
  fallbackOwnerId: string | null,
): Map<string, T[]> {
  const byRep = new Map<string, T[]>();
  for (const match of matches) {
    const rep = match.ownerId ?? fallbackOwnerId;
    if (!rep) continue;
    const bucket = byRep.get(rep);
    if (bucket) bucket.push(match); else byRep.set(rep, [match]);
  }
  return byRep;
}

/**
 * What one rep's alert says.
 *
 * Naming the buyer in the title is the whole value of the notification on a
 * lock screen — "3 of your buyers match B-110" is worth opening, "New property
 * matched" is not.
 */
export function describeRepAlert(buyers: AlertableMatch[], unitLabel: string): { title: string; body: string } {
  const named = buyers.slice(0, 3).map((b) => `${b.label} (${b.score}%)`).join(', ');
  const body = buyers.length > 3 ? `${named} and ${buyers.length - 3} more` : named;

  // A revived lead is a different phone call and the title has to say so. "3 of
  // your buyers match B-110" sends a rep in expecting a warm enquiry; walking
  // into "you told me it was too expensive" unprepared is how the call is lost
  // in its first ten seconds.
  const revivals = buyers.filter((b) => b.revival);
  if (revivals.length === buyers.length) {
    return {
      title: buyers.length === 1
        ? `${buyers[0].label} said no to a price — this one may fit`
        : `${buyers.length} buyers who said no may fit ${unitLabel}`,
      body: buyers.length === 1 ? buyers[0].revival! : body,
    };
  }

  return {
    title: buyers.length === 1
      ? `${buyers[0].label} may want ${unitLabel}`
      : `${buyers.length} of your buyers match ${unitLabel}`,
    body: revivals.length
      ? `${body} — ${revivals.length} of them previously said no`
      : body,
  };
}

/**
 * Tell the reps whose buyers were waiting for exactly this unit.
 *
 * This is the half of matching that nobody was doing. The CRM could already
 * answer "which units suit this buyer" on demand, but the useful direction is
 * the other one and it is time-critical: a floor photographed this morning is
 * the one somebody asked about three weeks ago, and whoever calls first sells
 * it. Waiting for a rep to think of running a search is waiting for the thing
 * that does not happen on a busy day.
 *
 * Alerts go to the **buyer's** owner, not the property's — the person holding
 * the relationship is the one who can ring them — and they are grouped one per
 * rep, because six notifications about six buyers is six ignored notifications.
 */
async function alertBuyerMatches(ctx: TaskContext, config: Record<string, unknown>): Promise<void> {
  // Only live stock is worth a phone call. A unit that arrives Sold or Blocked
  // still matches buyers arithmetically, and telling six people to chase
  // something they cannot have is worse than saying nothing. Guarded here
  // rather than only in the workflow's conditions so the action is safe
  // wherever an admin wires it.
  const status = ctx.record.status as string | undefined;
  if (status && status !== 'Available') {
    logger.debug({ recordId: ctx.recordId, status }, 'buyer match alert skipped — unit not available');
    return;
  }

  // A unit with no price yet is not sellable, and matching one is nonsense
  // dressed as arithmetic: every buyer "fits" a price of zero. This is the
  // normal state for a floor captured on a site visit — the photos come first
  // and the number lands back at the office — so the alert waits for the price
  // to be entered, which is the field change that fires this again.
  const price = Number(ctx.record.total_price ?? ctx.record.base_price ?? 0);
  if (!price) {
    logger.debug({ recordId: ctx.recordId }, 'buyer match alert skipped — unit has no price yet');
    return;
  }

  const minScore = Number(config.minScore ?? MIN_ALERT_SCORE);
  const matches = await matchBuyersForProperty(ctx.recordId, Math.min(50, Number(config.limit ?? 25)));
  const strong = matches.filter((m) => m.score >= minScore);
  if (!strong.length) {
    logger.debug({ recordId: ctx.recordId, considered: matches.length }, 'no buyer matches above the alert threshold');
    return;
  }

  // Who has already been alerted for this unit. Inventory is re-matched on a
  // price change and again whenever a hold expires and the unit comes back, so
  // without this the same rep is told about the same buyer every time — and
  // the second telling is what teaches them to stop reading the first.
  const previous = await db.queryOne<{ data: { buyerIds?: string[] } | null }>(
    `SELECT data FROM ipy_ai_insight
     WHERE record_id = $1 AND kind = 'buyer_match'
     ORDER BY created_at DESC LIMIT 1`,
    [ctx.recordId],
  );
  const alreadyTold = new Set(previous?.data?.buyerIds ?? []);
  const fresh = strong.filter((m) => !alreadyTold.has(m.recordId));

  const label = String(ctx.record.__label ?? ctx.record.name ?? 'this unit');

  // Written whether or not anyone is notified: the panel on the property should
  // answer "who wants this?" at any time, not only in the minute after it
  // arrived. The id list is also what the next run dedupes against, so it
  // records every strong match, not just the new ones.
  await saveInsight({
    recordId: ctx.recordId,
    module: ctx.module,
    kind: 'buyer_match',
    title: `${strong.length} buyer${strong.length === 1 ? '' : 's'} waiting for this`,
    // A list, because the insights panel renders markdown and a run of plain
    // lines comes out as one paragraph of names.
    body: strong.slice(0, 8).map((m) => `- **${m.label}** — ${m.score}% fit${m.reasons[0] ? `. ${m.reasons[0]}` : ''}`).join('\n'),
    data: { buyerIds: strong.map((m) => m.recordId), buyers: strong.slice(0, 10) },
    score: strong[0].score,
    replace: true,
  });

  if (!fresh.length) {
    logger.debug({ recordId: ctx.recordId, strong: strong.length }, 'buyer matches unchanged — no new alerts');
    return;
  }

  const propertyOwner = ctx.record.owner_id ? String(ctx.record.owner_id) : null;
  const byRep = groupMatchesByRep(fresh, propertyOwner);

  for (const [userId, buyers] of byRep) {
    await notify({
      userId,
      kind: 'buyer_match',
      ...describeRepAlert(buyers, label),
      link: `/${ctx.module}/${ctx.recordId}`,
      recordId: ctx.recordId,
    });
  }

  // A roll-up for whoever listed the unit — but silent, and only if they were
  // not already told as a buyer's rep. Demand on your own stock is worth
  // knowing; it is not worth a phone buzzing, because the person who has to
  // act in the next ten minutes is the one holding the buyer.
  if (propertyOwner && !byRep.has(propertyOwner)) {
    await notify({
      userId: propertyOwner,
      kind: 'buyer_match',
      title: `${strong.length} buyer${strong.length === 1 ? '' : 's'} match ${label}`,
      body: `${byRep.size} rep${byRep.size === 1 ? ' has' : 's have'} been alerted. Top fit: ${strong[0].label} at ${strong[0].score}%.`,
      link: `/${ctx.module}/${ctx.recordId}`,
      recordId: ctx.recordId,
      silent: true,
    });
  }

  logger.info(
    { recordId: ctx.recordId, strong: strong.length, fresh: fresh.length, reps: byRep.size },
    'buyer match alerts sent',
  );
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
