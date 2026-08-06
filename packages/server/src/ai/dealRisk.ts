/**
 * Deal risk and forecasting.
 *
 * Rule signals (stage age, discount pressure, engagement decay, competitor
 * mentions) produce a baseline risk score; the LLM explains it and proposes the
 * one action most likely to unstick the deal.
 */
import { formatIndianPrice } from '@ipropy/shared';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { completeJson, isAiAvailable, saveInsight, REAL_ESTATE_SYSTEM } from './client.js';

export interface DealRisk {
  riskScore: number;
  reasons: string[];
  nextAction: string;
  forecastCloseDate: string | null;
  winProbability: number;
}

interface DealContext {
  recordId: string;
  label: string;
  stage: string;
  amount: number;
  discountPercent: number;
  daysInStage: number;
  ageDays: number;
  expectedCloseDate: string | null;
  daysToExpectedClose: number | null;
  contactName: string | null;
  projectName: string | null;
  propertyName: string | null;
  propertyStatus: string | null;
  siteVisits: number;
  lastVisitInterest: string | null;
  daysSinceActivity: number;
  callsLast30: number;
  answeredLast30: number;
  inboundMessagesLast30: number;
  lastCallSummary: string | null;
  lostReasonsInProject: string[];
  description: string | null;
}

async function loadDealContext(recordId: string): Promise<DealContext | null> {
  const deal = await db.queryOne<Record<string, unknown>>(
    `SELECT d.*, r.label, r.created_at, r.last_activity_at,
            c.label AS contact_name, pr.name AS project_name,
            p.name AS property_name, p.status AS property_status
     FROM ipy_e_deals d
     JOIN ipy_record r ON r.id = d.record_id
     LEFT JOIN ipy_record c ON c.id = d.contact_id
     LEFT JOIN ipy_e_projects pr ON pr.record_id = d.project_id
     LEFT JOIN ipy_e_properties p ON p.record_id = d.property_id
     WHERE d.record_id = $1 AND r.is_deleted = false`,
    [recordId],
  );
  if (!deal) return null;

  const [visits, engagement, lostReasons] = await Promise.all([
    db.queryOne<{ total: number; interest: string | null }>(
      `SELECT COUNT(*)::int AS total,
              (SELECT interest_level FROM ipy_e_site_visits
               WHERE deal_id = $1 AND interest_level IS NOT NULL
               ORDER BY scheduled_at DESC LIMIT 1) AS interest
       FROM ipy_e_site_visits v JOIN ipy_record r ON r.id = v.record_id
       WHERE v.deal_id = $1 AND r.is_deleted = false AND v.status = 'Completed'`,
      [recordId],
    ),
    db.queryOne<{ calls: number; answered: number; inbound: number; last_summary: string | null }>(
      `SELECT
         (SELECT COUNT(*)::int FROM ipy_call WHERE record_id = $1 AND started_at > now() - interval '30 days') AS calls,
         (SELECT COUNT(*)::int FROM ipy_call WHERE record_id = $1 AND status = 'completed' AND started_at > now() - interval '30 days') AS answered,
         (SELECT COUNT(*)::int FROM ipy_message m JOIN ipy_conversation cv ON cv.id = m.conversation_id
          WHERE cv.record_id = $1 AND m.direction = 'inbound' AND m.created_at > now() - interval '30 days') AS inbound,
         (SELECT ai_summary FROM ipy_call WHERE record_id = $1 AND ai_summary IS NOT NULL
          ORDER BY started_at DESC LIMIT 1) AS last_summary`,
      [recordId],
    ),
    db.query<{ lost_reason: string }>(
      `SELECT DISTINCT lost_reason FROM ipy_e_deals
       WHERE project_id = $1 AND is_lost = true AND lost_reason IS NOT NULL
       LIMIT 5`,
      [deal.project_id],
    ),
  ]);

  const createdAt = new Date(String(deal.created_at));
  const lastActivity = deal.last_activity_at ? new Date(String(deal.last_activity_at)) : createdAt;
  const expected = deal.expected_close_date ? new Date(String(deal.expected_close_date)) : null;

  return {
    recordId,
    label: String(deal.label ?? ''),
    stage: String(deal.stage ?? ''),
    amount: Number(deal.amount ?? 0),
    discountPercent: Number(deal.discount_percent ?? 0),
    daysInStage: Number(deal.days_in_stage ?? 0),
    ageDays: (Date.now() - createdAt.getTime()) / 86_400_000,
    expectedCloseDate: deal.expected_close_date ? String(deal.expected_close_date) : null,
    daysToExpectedClose: expected ? (expected.getTime() - Date.now()) / 86_400_000 : null,
    contactName: (deal.contact_name as string) ?? null,
    projectName: (deal.project_name as string) ?? null,
    propertyName: (deal.property_name as string) ?? null,
    propertyStatus: (deal.property_status as string) ?? null,
    siteVisits: visits?.total ?? 0,
    lastVisitInterest: visits?.interest ?? null,
    daysSinceActivity: (Date.now() - lastActivity.getTime()) / 86_400_000,
    callsLast30: engagement?.calls ?? 0,
    answeredLast30: engagement?.answered ?? 0,
    inboundMessagesLast30: engagement?.inbound ?? 0,
    lastCallSummary: engagement?.last_summary ?? null,
    lostReasonsInProject: lostReasons.rows.map((r) => r.lost_reason),
    description: (deal.description as string) ?? null,
  };
}

const STAGE_ORDER = ['Enquiry', 'Site Visit', 'Revisit', 'Negotiation', 'Token Received', 'Agreement', 'Booked'];
/** Typical days a healthy deal spends in each stage. */
const STAGE_BUDGET: Record<string, number> = {
  Enquiry: 7, 'Site Visit': 10, Revisit: 14, Negotiation: 21, 'Token Received': 14, Agreement: 30,
};

function computeRisk(ctx: DealContext): { score: number; reasons: string[] } {
  let risk = 15;
  const reasons: string[] = [];

  // Stalling in stage.
  const budget = STAGE_BUDGET[ctx.stage] ?? 14;
  if (ctx.daysInStage > budget * 2) {
    risk += 28;
    reasons.push(`${ctx.daysInStage} days in "${ctx.stage}" — more than double the typical ${budget} days`);
  } else if (ctx.daysInStage > budget) {
    risk += 14;
    reasons.push(`${ctx.daysInStage} days in "${ctx.stage}", slightly over the usual ${budget}`);
  }

  // Silence.
  if (ctx.daysSinceActivity > 21) {
    risk += 25;
    reasons.push(`No activity for ${Math.round(ctx.daysSinceActivity)} days`);
  } else if (ctx.daysSinceActivity > 10) {
    risk += 12;
    reasons.push(`Quiet for ${Math.round(ctx.daysSinceActivity)} days`);
  }

  // Engagement collapse — we keep calling, they stop answering.
  if (ctx.callsLast30 >= 3 && ctx.answeredLast30 === 0) {
    risk += 20;
    reasons.push(`${ctx.callsLast30} call attempts in 30 days with no answer`);
  }
  if (ctx.inboundMessagesLast30 === 0 && ctx.ageDays > 14) {
    risk += 8;
    reasons.push('No inbound messages from the buyer in the last 30 days');
  } else if (ctx.inboundMessagesLast30 >= 3) {
    risk -= 10;
    reasons.push(`Buyer is engaged — ${ctx.inboundMessagesLast30} inbound messages`);
  }

  // Slipping past the forecast date.
  if (ctx.daysToExpectedClose !== null && ctx.daysToExpectedClose < 0) {
    risk += 18;
    reasons.push(`Expected close date passed ${Math.abs(Math.round(ctx.daysToExpectedClose))} days ago`);
  }

  // Discount pressure late in the cycle usually means a competing quote.
  if (ctx.discountPercent > 5) {
    risk += 12;
    reasons.push(`Discount ask of ${ctx.discountPercent}% is above the usual band`);
  }

  // No site visit past the enquiry stage is a serious gap.
  const stageIndex = STAGE_ORDER.indexOf(ctx.stage);
  if (ctx.siteVisits === 0 && stageIndex >= 2) {
    risk += 20;
    reasons.push('Advanced stage but no completed site visit on record');
  } else if (ctx.siteVisits >= 2) {
    risk -= 12;
    reasons.push(`${ctx.siteVisits} completed site visits — strong intent`);
  }

  if (ctx.lastVisitInterest === 'Low' || ctx.lastVisitInterest === 'Not Interested') {
    risk += 15;
    reasons.push(`Last site visit recorded "${ctx.lastVisitInterest}" interest`);
  } else if (ctx.lastVisitInterest === 'Very High') {
    risk -= 10;
    reasons.push('Last site visit recorded very high interest');
  }

  // The unit they want has been taken by someone else.
  if (ctx.propertyStatus && ['Booked', 'Sold', 'Blocked'].includes(ctx.propertyStatus) && stageIndex < 4) {
    risk += 22;
    reasons.push(`The linked unit is now "${ctx.propertyStatus}" — they may need a re-pitch`);
  }

  return { score: Math.max(0, Math.min(99, Math.round(risk))), reasons };
}

export async function analyseDeal(recordId: string, opts: { persist?: boolean } = {}): Promise<DealRisk | null> {
  const ctx = await loadDealContext(recordId);
  if (!ctx) return null;

  const rules = computeRisk(ctx);
  let result: DealRisk = {
    riskScore: rules.score,
    reasons: rules.reasons.slice(0, 5),
    nextAction: defaultNextAction(ctx, rules.score),
    forecastCloseDate: forecastClose(ctx, rules.score),
    winProbability: Math.max(2, Math.min(95, 100 - rules.score)),
  };

  if (isAiAvailable()) {
    const refined = await refineDealWithAi(ctx, rules);
    if (refined) result = refined;
  }

  if (opts.persist !== false) {
    await db.query(
      `UPDATE ipy_e_deals
       SET ai_risk_score = $2, ai_risk_reasons = $3, ai_next_action = $4,
           ai_forecast_close = $5, ai_analysed_at = now()
       WHERE record_id = $1`,
      [recordId, result.riskScore, JSON.stringify(result.reasons), result.nextAction, result.forecastCloseDate],
    );

    await saveInsight({
      recordId,
      module: 'deals',
      kind: 'deal_risk',
      title: `Deal risk ${result.riskScore}/100 — ${result.winProbability}% win probability`,
      body: `${result.reasons.map((r) => `• ${r}`).join('\n')}\n\n**Do next:** ${result.nextAction}`,
      data: { forecastCloseDate: result.forecastCloseDate, winProbability: result.winProbability },
      score: result.riskScore,
      replace: true,
    });
  }

  return result;
}

async function refineDealWithAi(ctx: DealContext, rules: { score: number; reasons: string[] }): Promise<DealRisk | null> {
  const prompt = `Assess the health of this real-estate deal.

## Deal
${ctx.label}
Stage: ${ctx.stage} (${ctx.daysInStage} days in stage)
Value: ${formatIndianPrice(ctx.amount)}${ctx.discountPercent ? ` — buyer is asking for a ${ctx.discountPercent}% discount` : ''}
Age: ${Math.round(ctx.ageDays)} days
Expected close: ${ctx.expectedCloseDate ?? '—'}${ctx.daysToExpectedClose !== null ? ` (${Math.round(ctx.daysToExpectedClose)} days away)` : ''}
Buyer: ${ctx.contactName ?? '—'}
Project: ${ctx.projectName ?? '—'}
Unit: ${ctx.propertyName ?? '—'}${ctx.propertyStatus ? ` (currently ${ctx.propertyStatus})` : ''}
Notes: ${ctx.description ?? '—'}

## Engagement (last 30 days)
Completed site visits: ${ctx.siteVisits}${ctx.lastVisitInterest ? ` — last recorded interest: ${ctx.lastVisitInterest}` : ''}
Calls: ${ctx.callsLast30} attempted, ${ctx.answeredLast30} answered
Inbound messages from buyer: ${ctx.inboundMessagesLast30}
Days since any activity: ${Math.round(ctx.daysSinceActivity)}
${ctx.lastCallSummary ? `\nLast call summary: ${ctx.lastCallSummary}` : ''}
${ctx.lostReasonsInProject.length ? `\nCommon loss reasons in this project: ${ctx.lostReasonsInProject.join(', ')}` : ''}

## Rule-based baseline risk
${rules.score}/100 — ${rules.reasons.join('; ')}

Refine this. Stay within ±20 of the baseline unless the qualitative signals clearly contradict it.

Return JSON:
{
  "riskScore": <0-99, higher means more likely to stall or be lost>,
  "reasons": [<up to 4 specific, evidence-based strings>],
  "nextAction": "<the single highest-leverage action, one sentence, concrete enough to do today>",
  "forecastCloseDate": "<YYYY-MM-DD realistic close date, or null if it looks dead>",
  "winProbability": <0-100>
}`;

  const parsed = await completeJson<DealRisk>({
    feature: 'deal_risk',
    system: REAL_ESTATE_SYSTEM,
    prompt,
    fast: true,
    maxTokens: 1000,
    recordId: ctx.recordId,
  });
  if (!parsed || typeof parsed.riskScore !== 'number') return null;

  const bounded = Math.abs(parsed.riskScore - rules.score) > 30
    ? rules.score + Math.sign(parsed.riskScore - rules.score) * 30
    : parsed.riskScore;

  return {
    riskScore: Math.max(0, Math.min(99, Math.round(bounded))),
    reasons: (parsed.reasons ?? rules.reasons).slice(0, 5),
    nextAction: parsed.nextAction || defaultNextAction(ctx, rules.score),
    forecastCloseDate: isValidDate(parsed.forecastCloseDate) ? parsed.forecastCloseDate : forecastClose(ctx, rules.score),
    winProbability: Math.max(0, Math.min(100, Math.round(parsed.winProbability ?? (100 - bounded)))),
  };
}

function isValidDate(s: string | null | undefined): s is string {
  return Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime()));
}

function defaultNextAction(ctx: DealContext, risk: number): string {
  if (ctx.propertyStatus && ['Booked', 'Sold'].includes(ctx.propertyStatus)) {
    return 'The shortlisted unit is gone — call today with two comparable alternatives before they lose interest.';
  }
  if (ctx.siteVisits === 0) return 'Book a site visit this week; nothing else moves the deal as reliably.';
  if (ctx.daysSinceActivity > 14) return 'Re-establish contact with a specific reason to talk — a price update or a newly released unit.';
  if (ctx.discountPercent > 5) return 'Get discount approval or counter with a value-add (parking, club membership) instead of price.';
  if (ctx.stage === 'Negotiation') return 'Propose a time-boxed offer to create a decision deadline.';
  if (risk > 60) return 'Escalate to the sales manager for a joint call this week.';
  return 'Confirm the next concrete step and put a date on it.';
}

function forecastClose(ctx: DealContext, risk: number): string | null {
  if (risk > 85) return null;
  const stageIndex = Math.max(0, STAGE_ORDER.indexOf(ctx.stage));
  const remaining = STAGE_ORDER.slice(stageIndex).reduce((sum, s) => sum + (STAGE_BUDGET[s] ?? 14), 0);
  // Risk stretches the timeline: a 60-risk deal takes ~60% longer.
  const adjusted = remaining * (1 + risk / 100);
  return new Date(Date.now() + adjusted * 86_400_000).toISOString().slice(0, 10);
}

/** Batch analysis for the nightly workflow. */
export async function analyseOpenDeals(limit = 200): Promise<{ analysed: number }> {
  const deals = await db.query<{ record_id: string }>(
    `SELECT d.record_id FROM ipy_e_deals d JOIN ipy_record r ON r.id = d.record_id
     WHERE r.is_deleted = false AND d.is_won = false AND d.is_lost = false
     ORDER BY d.amount DESC NULLS LAST LIMIT $1`,
    [limit],
  );
  let analysed = 0;
  for (const d of deals.rows) {
    try {
      await analyseDeal(d.record_id);
      analysed++;
    } catch (err) {
      logger.warn({ err, recordId: d.record_id }, 'deal analysis failed');
    }
  }
  return { analysed };
}
