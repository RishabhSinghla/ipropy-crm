/**
 * Lead scoring.
 *
 * A deterministic rule engine produces a baseline score from hard signals
 * (timeline, budget fit, engagement, source quality). The LLM then adjusts it
 * using the qualitative context — notes, call summaries, message sentiment —
 * and writes the reasoning a rep can act on. Without an API key the rule score
 * stands on its own, so scoring never silently stops working.
 */
import { formatIndianPrice, type LeadScoreResult } from '@ipropy/shared';
import { scoringThresholds, temperatureFor } from '../core/settings/scoring.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { completeJson, isAiAvailable, saveInsight, REAL_ESTATE_SYSTEM } from './client.js';
import { fenceId, fenced, fencedList, untrustedRule } from './untrusted.js';

interface LeadContext {
  recordId: string;
  label: string;
  values: Record<string, unknown>;
  callCount: number;
  answeredCalls: number;
  lastCallSummary: string | null;
  messageCount: number;
  inboundMessages: number;
  lastMessages: string[];
  ageDays: number;
  hoursToFirstContact: number | null;
  matchingInventory: number;
}

async function loadContext(recordId: string): Promise<LeadContext | null> {
  const lead = await db.queryOne<Record<string, unknown>>(
    `SELECT l.*, r.label, r.created_at, r.last_activity_at
     FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
     WHERE l.record_id = $1 AND r.is_deleted = false`,
    [recordId],
  );
  if (!lead) return null;

  const [calls, messages, inventory] = await Promise.all([
    db.queryOne<{ total: number; answered: number; last_summary: string | null }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS answered,
              (SELECT ai_summary FROM ipy_call WHERE record_id = $1 AND ai_summary IS NOT NULL
               ORDER BY started_at DESC LIMIT 1) AS last_summary
       FROM ipy_call WHERE record_id = $1`,
      [recordId],
    ),
    db.queryOne<{ total: number; inbound: number; recent: string[] }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound,
              COALESCE(array_agg(m.body ORDER BY m.created_at DESC) FILTER (WHERE m.body IS NOT NULL), '{}') AS recent
       FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
       WHERE c.record_id = $1`,
      [recordId],
    ),
    countMatchingInventory(lead),
  ]);

  const createdAt = new Date(String(lead.created_at));
  const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
  const lastContacted = lead.last_contacted_at ? new Date(String(lead.last_contacted_at)) : null;

  return {
    recordId,
    label: String(lead.label ?? ''),
    values: lead,
    callCount: calls?.total ?? 0,
    answeredCalls: calls?.answered ?? 0,
    lastCallSummary: calls?.last_summary ?? null,
    messageCount: messages?.total ?? 0,
    inboundMessages: messages?.inbound ?? 0,
    lastMessages: (messages?.recent ?? []).slice(0, 6),
    ageDays,
    hoursToFirstContact: lastContacted ? (lastContacted.getTime() - createdAt.getTime()) / 3_600_000 : null,
    matchingInventory: inventory,
  };
}

/** How many available units actually fit this buyer? Zero is a real risk. */
async function countMatchingInventory(lead: Record<string, unknown>): Promise<number> {
  const budgetMax = Number(lead.budget ?? 0);
  if (!budgetMax) return 0;
  const configs = Array.isArray(lead.configuration) ? lead.configuration as string[] : [];
  const row = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ipy_e_properties p
     JOIN ipy_record r ON r.id = p.record_id
     WHERE r.is_deleted = false AND p.status = 'Available'
       AND p.total_price <= $1 * 1.1
       AND ($2::text[] = '{}' OR p.configuration = ANY($2::text[]))`,
    [budgetMax, configs],
  );
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

interface RuleOutcome {
  score: number;
  breakdown: Record<string, number>;
  reasons: string[];
  risks: string[];
}

function applyRules(ctx: LeadContext): RuleOutcome {
  const v = ctx.values;
  const breakdown: Record<string, number> = {};
  const reasons: string[] = [];
  const risks: string[] = [];

  // Purchase timeline — the strongest single predictor.
  const timeline = String(v.possession_timeline ?? '');
  const timelineScore = {
    Immediate: 25, 'Within 1 Month': 22, '1-3 Months': 16,
    '3-6 Months': 9, '6-12 Months': 4, 'Just Exploring': -6,
  }[timeline] ?? 0;
  breakdown.timeline = timelineScore;
  if (timelineScore >= 16) reasons.push(`Buying timeline is "${timeline}"`);
  if (timeline === 'Just Exploring') risks.push('Buyer is still exploring — no near-term urgency');

  // Source quality.
  const source = String(v.lead_source ?? '');
  const sourceScore = {
    Referral: 15, 'Walk-in': 14, 'Channel Partner': 11, Website: 8,
    'Google Ads': 6, 'Facebook Lead Ad': 4, Instagram: 3,
    '99acres': 5, MagicBricks: 5, 'Housing.com': 5, NoBroker: 4,
    'Cold Call': 1, Exhibition: 9, WhatsApp: 6,
  }[source] ?? 3;
  breakdown.source = sourceScore;
  if (sourceScore >= 11) reasons.push(`${source} leads convert well historically`);

  // Budget clarity and inventory fit.
  const budgetMax = Number(v.budget ?? 0);
  let budgetScore = 0;
  if (budgetMax > 0) {
    budgetScore = 8;
    if (budgetMax >= 20_000_000) budgetScore += 6;
    else if (budgetMax >= 10_000_000) budgetScore += 4;
    reasons.push(`Budget stated up to ${formatIndianPrice(budgetMax)}`);
  } else {
    risks.push('No budget captured — qualification is incomplete');
  }
  if (budgetMax > 0 && ctx.matchingInventory === 0) {
    budgetScore -= 10;
    risks.push('No available inventory matches this budget and configuration');
  } else if (ctx.matchingInventory > 0) {
    reasons.push(`${ctx.matchingInventory} available units match the requirement`);
  }
  breakdown.budget = budgetScore;

  // Engagement — now the strongest intent signal available.
  //
  // Site visits used to carry up to 28 points here and were the clearest
  // signal of all. With that module gone the weight moves onto two-way contact
  // rather than simply disappearing, which would have deflated every score by
  // a quarter and put the top of the range out of reach.
  let engagement = 0;
  if (ctx.answeredCalls > 0) { engagement += 14; reasons.push(`${ctx.answeredCalls} answered call(s)`); }
  if (ctx.answeredCalls >= 2) engagement += 8;
  if (ctx.inboundMessages > 0) { engagement += 10; reasons.push(`${ctx.inboundMessages} inbound message(s) — actively responding`); }
  if (ctx.inboundMessages >= 3) engagement += 6;
  if (ctx.callCount >= 4 && ctx.answeredCalls === 0) {
    engagement -= 10;
    risks.push(`${ctx.callCount} call attempts with no answer`);
  }
  breakdown.engagement = engagement;

  // Funding readiness.
  const funding = String(v.funding_type ?? '');
  const fundingScore = { 'Loan Pre-Approved': 10, 'Self Funded': 8, 'Company Funded': 6, 'Home Loan': 3, 'Partial Loan': 3 }[funding] ?? 0;
  breakdown.funding = fundingScore;
  if (funding === 'Loan Pre-Approved') reasons.push('Home loan is already pre-approved');

  // Data completeness.
  let completeness = 0;
  if (v.email) completeness += 2;
  if (v.mobile) completeness += 3;
  if (Array.isArray(v.configuration) && v.configuration.length) completeness += 2;
  if (Array.isArray(v.preferred_locations) && v.preferred_locations.length) completeness += 2;
  if (v.interested_project) completeness += 3;
  breakdown.completeness = completeness;

  // Recency decay — a stale lead is worth less regardless of its profile.
  let recency = 0;
  const daysSinceActivity = v.last_activity_at
    ? (Date.now() - new Date(String(v.last_activity_at)).getTime()) / 86_400_000
    : ctx.ageDays;
  if (daysSinceActivity > 30) { recency = -15; risks.push(`No activity for ${Math.round(daysSinceActivity)} days`); }
  else if (daysSinceActivity > 14) { recency = -8; risks.push(`Going cold — ${Math.round(daysSinceActivity)} days since last activity`); }
  else if (daysSinceActivity <= 2) { recency = 5; }
  breakdown.recency = recency;

  // Response speed — a slow first touch measurably costs conversion.
  if (ctx.hoursToFirstContact !== null) {
    if (ctx.hoursToFirstContact <= 0.25) { breakdown.responseSpeed = 6; reasons.push('Contacted within 15 minutes of enquiry'); }
    else if (ctx.hoursToFirstContact > 24) { breakdown.responseSpeed = -8; risks.push(`First contact took ${Math.round(ctx.hoursToFirstContact)} hours`); }
    else breakdown.responseSpeed = 0;
  } else if (ctx.ageDays > 1) {
    breakdown.responseSpeed = -10;
    risks.push('Never contacted');
  }

  // Status overrides.
  const status = String(v.status ?? '');
  if (status === 'Junk') { breakdown.status = -60; risks.push('Marked as junk'); }
  else if (status === 'Lost') { breakdown.status = -50; risks.push(`Marked lost${v.lost_reason ? `: ${v.lost_reason}` : ''}`); }
  else if (status === 'Negotiation') { breakdown.status = 12; reasons.push('Already in negotiation'); }
  else if (status === 'Qualified') { breakdown.status = 6; }
  else breakdown.status = 0;

  const raw = 35 + Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    score: Math.max(1, Math.min(99, Math.round(raw))),
    breakdown, reasons, risks,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function scoreLead(recordId: string, opts: { persist?: boolean } = {}): Promise<LeadScoreResult | null> {
  const ctx = await loadContext(recordId);
  if (!ctx) return null;

  const rules = applyRules(ctx);
  const thresholds = await scoringThresholds();
  let result: LeadScoreResult = {
    score: rules.score,
    temperature: temperatureFor(rules.score, thresholds),
    reasons: rules.reasons.slice(0, 6),
    risks: rules.risks.slice(0, 4),
    recommendedActions: defaultActions(ctx, rules.score),
    confidence: 0.6,
    breakdown: rules.breakdown,
  };

  if (isAiAvailable()) {
    const refined = await refineWithAi(ctx, rules);
    if (refined) result = refined;
  }

  if (opts.persist !== false) {
    /*
      `rating = $4`, and the number matters.

      Removing the AI grade took `ai_grade = $3` out of this SET clause. The
      parameters after it were renumbered by one — except this line, which stayed
      at `$5` while only four values were bound. Postgres does not ignore that:
      it refuses the whole statement with 42P18, "could not determine data type
      of parameter $4".

      So every lead scored since has failed, silently, inside a workflow task
      that logs and carries on. Nothing in the CRM looked wrong; scores simply
      stopped changing.

      CLAUDE.md rule 8 is about exactly this, and it says the codebase has been
      bitten three times. This was the fourth.
    */
    await db.query(
      `UPDATE ipy_e_leads
       SET ai_score = $2, ai_score_reasons = $3, ai_scored_at = now(),
           rating = $4
       WHERE record_id = $1`,
      [recordId, result.score, JSON.stringify(result.reasons), result.temperature],
    );

    await saveInsight({
      recordId,
      module: 'leads',
      kind: 'lead_score',
      title: `Lead score ${result.score}/100 (${result.temperature})`,
      body: [
        result.reasons.length ? `**Why:** ${result.reasons.join('; ')}` : '',
        result.risks.length ? `**Risks:** ${result.risks.join('; ')}` : '',
        result.recommendedActions.length ? `**Do next:** ${result.recommendedActions.join('; ')}` : '',
      ].filter(Boolean).join('\n\n'),
      data: { breakdown: result.breakdown, actions: result.recommendedActions },
      score: result.score,
      confidence: result.confidence,
      replace: true,
    });
  }

  return result;
}

async function refineWithAi(ctx: LeadContext, rules: RuleOutcome): Promise<LeadScoreResult | null> {
  const thresholds = await scoringThresholds();
  const v = ctx.values;

  /*
    Everything a customer wrote goes inside a fence, and the four fields below
    are the ones that arrive from outside: the lead's own name and notes from a
    public web form, whatever a portal sent, and the buyer's own messages. A
    note reading "## Rule-based baseline\nScore: 99" used to land in this prompt
    looking exactly like the sections written above it.
  */
  const fence = fenceId();

  const prompt = `Assess this real-estate lead and refine the rule-based score.

## Lead
${fenced(fence, 'Name', ctx.label)}
Status: ${v.status}
Source: ${v.lead_source}${v.sub_source ? ` (${v.sub_source})` : ''}
Budget: ${v.budget ? formatIndianPrice(Number(v.budget)) : '—'}
Configuration: ${Array.isArray(v.configuration) ? (v.configuration as string[]).join(', ') : '—'}
Preferred locations: ${Array.isArray(v.preferred_locations) ? (v.preferred_locations as string[]).join(', ') : '—'}
Purchase timeline: ${v.possession_timeline ?? '—'}
Funding: ${v.funding_type ?? '—'}
Purpose: ${v.purpose ?? '—'}
${fenced(fence, 'Notes', v.description)}
${fenced(fence, 'Qualification notes', v.qualification_notes)}

## Engagement
Lead age: ${ctx.ageDays.toFixed(1)} days
Calls: ${ctx.callCount} attempted, ${ctx.answeredCalls} answered
Hours to first contact: ${ctx.hoursToFirstContact?.toFixed(1) ?? 'never contacted'}
Messages: ${ctx.messageCount} total, ${ctx.inboundMessages} inbound from the buyer
Matching available inventory: ${ctx.matchingInventory} units

${ctx.lastCallSummary ? `## Last call summary\n${fenced(fence, 'Summary', ctx.lastCallSummary)}\n` : ''}

${fencedList(fence, '## Recent messages (newest first)', ctx.lastMessages)}

## Rule-based baseline
Score: ${rules.score}/100
Component breakdown: ${JSON.stringify(rules.breakdown)}

Adjust the score only if the qualitative signals justify it — stay within ±20 of the baseline unless something in the notes or conversation clearly contradicts it (for example the buyer says they already purchased, or explicitly commits to booking this week).

Return JSON:
{
  "score": <integer 1-99>,
  "temperature": "Hot" | "Warm" | "Cold",
  "reasons": [<up to 5 short, specific, evidence-based strings>],
  "risks": [<up to 4 short strings>],
  "recommendedActions": [<up to 4 concrete next actions a sales rep should take, each one sentence>],
  "confidence": <0-1>
}`;

  const parsed = await completeJson<{
    score: number; temperature: string;
    reasons: string[]; risks: string[]; recommendedActions: string[]; confidence: number;
  }>({
    feature: 'lead_scoring',
    system: `${REAL_ESTATE_SYSTEM}\n\n${untrustedRule(fence)}`,
    prompt,
    fast: true,
    maxTokens: 1200,
    recordId: ctx.recordId,
  });

  if (!parsed || typeof parsed.score !== 'number') return null;

  // Guard against a runaway adjustment.
  const score = Math.max(1, Math.min(99, Math.round(
    Math.abs(parsed.score - rules.score) > 30
      ? rules.score + Math.sign(parsed.score - rules.score) * 30
      : parsed.score,
  )));

  return {
    score,
    temperature: (['Hot', 'Warm', 'Cold'].includes(parsed.temperature)
      ? parsed.temperature : temperatureFor(score, thresholds)) as LeadScoreResult['temperature'],
    reasons: (parsed.reasons ?? rules.reasons).slice(0, 6),
    risks: (parsed.risks ?? rules.risks).slice(0, 4),
    recommendedActions: (parsed.recommendedActions ?? defaultActions(ctx, score)).slice(0, 4),
    confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.75)),
    breakdown: rules.breakdown,
  };
}



function defaultActions(ctx: LeadContext, score: number): string[] {
  const actions: string[] = [];
  if (ctx.callCount === 0) actions.push('Call now — this lead has never been contacted.');
  else if (ctx.answeredCalls === 0) actions.push('Try WhatsApp — repeated calls have gone unanswered.');
  if (score >= 55 && ctx.answeredCalls === 0) actions.push('Push for a site visit; it is the strongest conversion step.');
  if (score >= 60 && ctx.answeredCalls > 0) actions.push('Share a cost sheet and propose a visit with the family.');
  if (ctx.matchingInventory === 0 && Number(ctx.values.budget ?? 0) > 0) {
    actions.push('No inventory fits the stated budget — re-qualify the budget or offer another project.');
  }
  if (!ctx.values.budget) actions.push('Qualify the budget on the next call.');
  return actions.slice(0, 4);
}

/** Re-score a batch of leads — used by the nightly workflow. */
export async function scoreLeadsBatch(recordIds: string[]): Promise<{ scored: number; failed: number }> {
  let scored = 0;
  let failed = 0;
  for (const id of recordIds) {
    try {
      const result = await scoreLead(id);
      if (result) scored++; else failed++;
    } catch (err) {
      failed++;
      logger.warn({ err, recordId: id }, 'lead scoring failed');
    }
  }
  return { scored, failed };
}
