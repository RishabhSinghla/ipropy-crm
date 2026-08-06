/**
 * "Ask your CRM" — natural language over the metadata engine.
 *
 * Two capabilities:
 *   1. NL → filter: turns "hot leads in Whitefield above 1.5cr" into a real
 *      FilterGroup the list view can run, so results are exact, permission-
 *      scoped and clickable rather than hallucinated prose.
 *   2. Conversational Q&A: answers questions by running those same queries and
 *      summarising the actual rows.
 */
import type { FilterGroup, ListResult } from '@ipropy/shared';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { registry } from '../core/metadata/registry.js';
import { listRecords, type ServiceContext } from '../core/entity/recordService.js';
import { runWidget } from '../core/analytics/widgets.js';
import { complete, completeJson, isAiAvailable, REAL_ESTATE_SYSTEM } from './client.js';

export interface NlQueryResult {
  module: string;
  filter: FilterGroup;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  columns?: string[];
  explanation: string;
}

/** Describe a module's queryable surface compactly enough to fit in a prompt. */
async function describeModule(moduleName: string): Promise<string> {
  const meta = await registry.getModule(moduleName);
  if (!meta) return '';

  const fields = meta.fields
    .filter((f) => f.isActive && f.displayType !== 'hidden')
    .slice(0, 60)
    .map((f) => {
      const opts = f.options?.length
        ? ` [${f.options.slice(0, 14).map((o) => o.value).join(' | ')}]`
        : '';
      const ref = f.uitype === 'reference'
        ? ` → ${(f.config.referenceModules ?? []).join('/')}`
        : '';
      return `  ${f.name} (${f.uitype})${ref}${opts}`;
    })
    .join('\n');

  return `### ${meta.name} — ${meta.label}\n${fields}`;
}

export async function parseNaturalQuery(
  question: string,
  ctx: ServiceContext,
  hintModule?: string,
): Promise<NlQueryResult | null> {
  if (!isAiAvailable()) return null;

  const modules = await registry.getModules({ entityOnly: true });
  const relevant = hintModule
    ? modules.filter((m) => m.name === hintModule)
    : modules;

  const schema = (await Promise.all(relevant.map((m) => describeModule(m.name)))).join('\n\n');

  const prompt = `Convert this question into a CRM query.

Question: "${question}"

## Available modules and fields
${schema}

## Filter grammar
{
  "logic": "AND" | "OR",
  "conditions": [
    { "field": "<field name>", "operator": "<operator>", "value": <value>, "value2": <only for between> },
    { "logic": "OR", "conditions": [...] }
  ]
}

Operators: equals, not_equals, contains, not_contains, starts_with, ends_with, is_empty, is_not_empty,
greater_than, greater_or_equal, less_than, less_or_equal, between, in, not_in, is_true, is_false,
today, tomorrow, yesterday, this_week, this_month, this_quarter, this_year,
last_n_days, next_n_days, older_than_n_days, is_me, is_my_team, has_any, has_all

Rules:
- Amounts are rupees: "1.5 cr" is 15000000, "80 lakh" is 8000000.
- Multi-select fields (multipicklist, tags) use has_any / has_all, not equals.
- "my" or "mine" means the is_me operator on owner_id.
- Use exact picklist values from the schema above.
- Relative dates use the dedicated operators, never a hardcoded date.
- Only reference fields that appear in the schema.

Return JSON:
{
  "module": "<module name>",
  "filter": <filter object>,
  "sortBy": "<field name or null>",
  "sortDir": "asc" | "desc",
  "columns": [<4-7 field names worth showing for this question>],
  "explanation": "<one sentence describing what will be fetched>"
}`;

  const parsed = await completeJson<NlQueryResult>({
    feature: 'nl_query',
    system: REAL_ESTATE_SYSTEM,
    prompt,
    maxTokens: 1500,
    userId: ctx.user.id,
  });
  if (!parsed?.module || !parsed.filter) return null;

  // Never trust the model's field names — validate against real metadata.
  const meta = await registry.getModule(parsed.module);
  if (!meta) return null;
  const valid = new Set([
    ...meta.fields.map((f) => f.name),
    'owner_id', 'created_by', 'created_at', 'updated_at', 'last_activity_at', 'record_number', 'id',
  ]);

  const cleaned = pruneFilter(parsed.filter, valid);
  return {
    module: parsed.module,
    filter: cleaned,
    sortBy: parsed.sortBy && valid.has(parsed.sortBy) ? parsed.sortBy : undefined,
    sortDir: parsed.sortDir === 'asc' ? 'asc' : 'desc',
    columns: (parsed.columns ?? []).filter((c) => valid.has(c)).slice(0, 8),
    explanation: parsed.explanation ?? '',
  };
}

/** Drop any condition naming a field that doesn't exist. */
function pruneFilter(group: FilterGroup, valid: Set<string>): FilterGroup {
  const conditions = group.conditions
    .map((node) => {
      if ('conditions' in node) {
        const nested = pruneFilter(node as FilterGroup, valid);
        return nested.conditions.length ? nested : null;
      }
      const cond = node as { field: string };
      return valid.has(cond.field.split('.')[0]) ? node : null;
    })
    .filter((n): n is NonNullable<typeof n> => n !== null);
  return { logic: group.logic === 'OR' ? 'OR' : 'AND', conditions };
}

// ---------------------------------------------------------------------------
// Conversational Q&A
// ---------------------------------------------------------------------------

export interface AskResult {
  answer: string;
  query?: NlQueryResult;
  results?: ListResult;
  chart?: unknown;
}

export async function ask(
  question: string,
  ctx: ServiceContext,
  opts: { contextRecordId?: string; contextModule?: string; threadId?: string } = {},
): Promise<AskResult> {
  if (!isAiAvailable()) {
    return { answer: 'The AI assistant needs an Anthropic API key. Add ANTHROPIC_API_KEY to your environment to enable it.' };
  }

  // Record-scoped question: answer from that record's own context.
  if (opts.contextRecordId && opts.contextModule) {
    return askAboutRecord(question, ctx, opts.contextRecordId, opts.contextModule);
  }

  const query = await parseNaturalQuery(question, ctx);
  if (!query) {
    return { answer: "I couldn't turn that into a query. Try naming the module — for example \"show me leads in Whitefield above 1.5 Cr\"." };
  }

  let results: ListResult | undefined;
  try {
    results = await listRecords(ctx, query.module, {
      filter: query.filter,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
      pageSize: 25,
      page: 1,
      columns: query.columns,
    });
  } catch (err) {
    logger.warn({ err, query }, 'NL query execution failed');
    return { answer: `I built a query but it failed to run: ${err instanceof Error ? err.message : 'unknown error'}`, query };
  }

  const meta = await registry.getModule(query.module);
  const sample = results.rows.slice(0, 15).map((r) => {
    const parts = (query.columns ?? []).map((c) => `${c}: ${r.display?.[c] ?? r.values[c] ?? '—'}`);
    return `- ${r.label}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  }).join('\n');

  const answerPrompt = `The user asked: "${question}"

I ran this query against ${meta?.label ?? query.module} and got ${results.total} matching records.

${results.rows.length ? `Sample (first ${Math.min(15, results.rows.length)}):\n${sample}` : 'No records matched.'}

Answer the question directly in 2-4 sentences. Lead with the number. Point out anything notable in the data — a concentration, an outlier, a gap. Do not list every record; the user can see the table. Do not invent data beyond what is shown.`;

  const answer = await complete({
    feature: 'ask_crm',
    system: REAL_ESTATE_SYSTEM,
    prompt: answerPrompt,
    fast: true,
    maxTokens: 700,
    userId: ctx.user.id,
  });

  return {
    answer: answer?.text.trim() ?? `Found ${results.total} matching ${meta?.label ?? query.module}.`,
    query,
    results,
  };
}

async function askAboutRecord(
  question: string,
  ctx: ServiceContext,
  recordId: string,
  module: string,
): Promise<AskResult> {
  const { buildRecordSummary } = await import('./drafting.js');
  const { buildTimeline } = await import('../core/entity/timeline.js');

  const [summary, timeline] = await Promise.all([
    buildRecordSummary(recordId, module),
    buildTimeline(recordId, { limit: 30 }),
  ]);

  const prompt = `The user is looking at a ${module} record and asked: "${question}"

## Record
${summary}

## Recent activity
${timeline.map((t) => `- [${new Date(t.at).toLocaleDateString('en-IN')}] ${t.title}${t.body ? `: ${t.body.slice(0, 250)}` : ''}`).join('\n')}

Answer using only what is above. If the answer isn't in the data, say so plainly. Be concise.`;

  const answer = await complete({
    feature: 'ask_record',
    system: REAL_ESTATE_SYSTEM,
    prompt,
    maxTokens: 900,
    recordId,
    userId: ctx.user.id,
  });

  return { answer: answer?.text.trim() ?? 'I could not answer that from this record.' };
}

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------

export interface DailyDigest {
  greeting: string;
  priorities: { title: string; reason: string; recordId?: string; module?: string }[];
  summary: string;
  stats: Record<string, number>;
}

export async function dailyDigest(ctx: ServiceContext): Promise<DailyDigest | null> {
  const userId = ctx.user.id;

  const [overdueFollowups, todayVisits, hotLeads, atRiskDeals, overdueTasks, stats] = await Promise.all([
    listRecords(ctx, 'leads', {
      filter: { logic: 'AND', conditions: [
        { field: 'owner_id', operator: 'is_me' },
        { field: 'next_followup_at', operator: 'older_than_n_days', value: 0 },
        { field: 'is_converted', operator: 'is_false' },
      ] },
      sortBy: 'ai_score', sortDir: 'desc', pageSize: 5,
    }).catch(() => null),

    listRecords(ctx, 'site_visits', {
      filter: { logic: 'AND', conditions: [
        { field: 'owner_id', operator: 'is_me' },
        { field: 'scheduled_at', operator: 'today' },
      ] },
      sortBy: 'scheduled_at', sortDir: 'asc', pageSize: 5,
    }).catch(() => null),

    listRecords(ctx, 'leads', {
      filter: { logic: 'AND', conditions: [
        { field: 'owner_id', operator: 'is_me' },
        { field: 'ai_score', operator: 'greater_or_equal', value: 70 },
        { field: 'is_converted', operator: 'is_false' },
      ] },
      sortBy: 'ai_score', sortDir: 'desc', pageSize: 5,
    }).catch(() => null),

    listRecords(ctx, 'deals', {
      filter: { logic: 'AND', conditions: [
        { field: 'owner_id', operator: 'is_me' },
        { field: 'ai_risk_score', operator: 'greater_or_equal', value: 60 },
        { field: 'is_won', operator: 'is_false' },
        { field: 'is_lost', operator: 'is_false' },
      ] },
      sortBy: 'amount', sortDir: 'desc', pageSize: 5,
    }).catch(() => null),

    listRecords(ctx, 'activities', {
      filter: { logic: 'AND', conditions: [
        { field: 'owner_id', operator: 'is_me' },
        { field: 'due_date', operator: 'older_than_n_days', value: 0 },
        { field: 'status', operator: 'not_in', value: ['Completed', 'Cancelled'] },
      ] },
      pageSize: 5,
    }).catch(() => null),

    db.queryOne<{ open_leads: number; open_deals: number; pipeline_value: number; mtd_bookings: number }>(
      `SELECT
        (SELECT COUNT(*)::int FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id
         WHERE r.owner_id = $1 AND r.is_deleted = false AND l.is_converted = false
           AND l.status NOT IN ('Junk','Lost')) AS open_leads,
        (SELECT COUNT(*)::int FROM ipy_e_deals d JOIN ipy_record r ON r.id = d.record_id
         WHERE r.owner_id = $1 AND r.is_deleted = false AND d.is_won = false AND d.is_lost = false) AS open_deals,
        (SELECT COALESCE(SUM(d.amount),0)::numeric FROM ipy_e_deals d JOIN ipy_record r ON r.id = d.record_id
         WHERE r.owner_id = $1 AND r.is_deleted = false AND d.is_won = false AND d.is_lost = false) AS pipeline_value,
        (SELECT COUNT(*)::int FROM ipy_e_bookings b JOIN ipy_record r ON r.id = b.record_id
         WHERE r.owner_id = $1 AND r.is_deleted = false
           AND b.booking_date >= date_trunc('month', CURRENT_DATE)) AS mtd_bookings`,
      [userId],
    ),
  ]);

  const priorities: DailyDigest['priorities'] = [];

  for (const v of todayVisits?.rows ?? []) {
    priorities.push({
      title: `Site visit: ${v.label}`,
      reason: `Scheduled ${new Date(String(v.values.scheduled_at)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} today`,
      recordId: v.id, module: 'site_visits',
    });
  }
  for (const l of overdueFollowups?.rows ?? []) {
    priorities.push({
      title: `Overdue follow-up: ${l.label}`,
      reason: `Score ${l.values.ai_score ?? '—'} · due ${new Date(String(l.values.next_followup_at)).toLocaleDateString('en-IN')}`,
      recordId: l.id, module: 'leads',
    });
  }
  for (const d of atRiskDeals?.rows ?? []) {
    priorities.push({
      title: `At-risk deal: ${d.label}`,
      reason: String(d.values.ai_next_action ?? `Risk score ${d.values.ai_risk_score}`),
      recordId: d.id, module: 'deals',
    });
  }
  for (const l of hotLeads?.rows ?? []) {
    if (priorities.some((p) => p.recordId === l.id)) continue;
    priorities.push({
      title: `Hot lead: ${l.label}`,
      reason: `AI score ${l.values.ai_score}`,
      recordId: l.id, module: 'leads',
    });
  }

  const digestStats = {
    openLeads: stats?.open_leads ?? 0,
    openDeals: stats?.open_deals ?? 0,
    pipelineValue: Number(stats?.pipeline_value ?? 0),
    bookingsThisMonth: stats?.mtd_bookings ?? 0,
    visitsToday: todayVisits?.total ?? 0,
    overdueFollowups: overdueFollowups?.total ?? 0,
    overdueTasks: overdueTasks?.total ?? 0,
  };

  const hour = new Date().getHours();
  const greeting = `Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${ctx.user.firstName}`;

  if (!isAiAvailable()) {
    return {
      greeting,
      priorities: priorities.slice(0, 6),
      summary: `You have ${digestStats.visitsToday} site visit(s) today, ${digestStats.overdueFollowups} overdue follow-up(s) and ${digestStats.openDeals} open deals worth ₹${(digestStats.pipelineValue / 10_000_000).toFixed(2)} Cr.`,
      stats: digestStats,
    };
  }

  const summary = await complete({
    feature: 'daily_digest',
    system: REAL_ESTATE_SYSTEM,
    prompt: `Write a short daily briefing for a real-estate sales rep.

## Their numbers
${JSON.stringify(digestStats, null, 2)}

## What needs attention
${priorities.slice(0, 8).map((p) => `- ${p.title} — ${p.reason}`).join('\n') || 'Nothing flagged.'}

Write 2-3 sentences. Open with the single most time-critical thing. Be direct and specific — no motivational filler.`,
    fast: true,
    maxTokens: 400,
    userId,
  });

  return {
    greeting,
    priorities: priorities.slice(0, 6),
    summary: summary?.text.trim() ?? '',
    stats: digestStats,
  };
}

/** Free-text insight over a dashboard scope, used by the ai_insights widget. */
export async function dashboardInsight(
  ctx: ServiceContext,
  scope: string,
  customPrompt?: string,
): Promise<string> {
  if (!isAiAvailable()) return 'Add an Anthropic API key to enable AI insights.';

  const facts: string[] = [];

  if (scope === 'sales_overview' || !scope) {
    const widgets: { label: string; type: string; config: Record<string, unknown> }[] = [
      { label: 'Leads this month', type: 'metric', config: { module: 'leads', aggregate: 'count', dateField: 'created_at', comparePrevious: true, filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'this_month' }] } } },
      { label: 'Pipeline by stage', type: 'bar', config: { module: 'deals', groupBy: 'stage', aggregate: 'sum', aggregateField: 'amount', filter: { logic: 'AND', conditions: [{ field: 'is_won', operator: 'is_false' }, { field: 'is_lost', operator: 'is_false' }] } } },
      { label: 'Leads by source', type: 'donut', config: { module: 'leads', groupBy: 'lead_source', aggregate: 'count', filter: { logic: 'AND', conditions: [{ field: 'created_at', operator: 'last_n_days', value: 90 }] } } },
      { label: 'Bookings this month', type: 'metric', config: { module: 'bookings', aggregate: 'sum', aggregateField: 'agreement_value', dateField: 'booking_date', comparePrevious: true, filter: { logic: 'AND', conditions: [{ field: 'booking_date', operator: 'this_month' }] } } },
      { label: 'Available inventory', type: 'metric', config: { module: 'properties', aggregate: 'count', filter: { logic: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'Available' }] } } },
    ];
    for (const w of widgets) {
      try {
        const data = await runWidget(ctx, w.type, w.config as never);
        facts.push(`${w.label}: ${JSON.stringify(
          data.series ? data.series.map((s) => `${s.label}=${Math.round(s.value)}`) : { value: data.value, previous: data.previousValue, change: data.changePercent },
        )}`);
      } catch { /* a failing widget shouldn't break the insight */ }
    }
  }

  if (scope === 'my_day') {
    const digest = await dailyDigest(ctx);
    if (digest) facts.push(`Personal stats: ${JSON.stringify(digest.stats)}`, `Priorities: ${digest.priorities.map((p) => p.title).join('; ')}`);
  }

  const result = await complete({
    feature: 'dashboard_insight',
    system: REAL_ESTATE_SYSTEM,
    prompt: `${customPrompt ?? 'Analyse the current state of the business and surface what matters.'}

## Live data
${facts.join('\n') || 'No data available.'}

Write 3-4 short bullet points. Each must cite a number from the data and say what to do about it. No generic advice.`,
    maxTokens: 700,
    userId: ctx.user.id,
  });

  return result?.text.trim() ?? 'No insights available right now.';
}
