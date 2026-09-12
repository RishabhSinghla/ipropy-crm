/**
 * AI content drafting: WhatsApp replies, emails, call openers, pitch decks.
 * Always drafts *from the record's real context* so the output references the
 * actual project, price and conversation history rather than generic filler.
 */
import { formatIndianPrice } from '@ipropy/shared';
import type { ScopeContext } from '../core/permissions/index.js';
import { db } from '../db/pool.js';
import { complete, isAiAvailable, REAL_ESTATE_SYSTEM } from './client.js';
import { matchForRecord } from './matching.js';
import { fenceId, fenced, untrustedRule } from './untrusted.js';

export interface DraftInput {
  channel: 'whatsapp' | 'email' | 'sms' | 'call_script';
  recordId: string;
  module: string;
  /** what the rep wants to achieve */
  goal?: string;
  tone?: 'warm' | 'professional' | 'urgent' | 'consultative';
  /** the customer's latest message, when replying */
  replyingTo?: string;
  language?: string;
  includeProperties?: boolean;
  userId?: string | null;
  /** Server-derived readable field names; never trust this from a browser. */
  visibleFields?: string[];
  /** Caller's scope, so referenced inventory stays inside what they can see. */
  scope?: ScopeContext;
}

export interface DraftResult {
  subject?: string;
  body: string;
  suggestedActions?: string[];
}

interface RecordContext {
  label: string;
  summary: string;
  ownerName: string;
  orgName: string;
  history: string;
}

async function buildContext(
  recordId: string,
  module: string,
  visibleFields?: ReadonlySet<string>,
): Promise<RecordContext | null> {
  const record = await db.queryOne<{ label: string; owner_id: string | null; module_name: string }>(
    `SELECT label, owner_id, module_name FROM ipy_record WHERE id = $1 AND is_deleted = false`,
    [recordId],
  );
  if (!record) return null;

  const summary = await buildRecordSummary(recordId, module, visibleFields);

  const [owner, org, messages, calls] = await Promise.all([
    record.owner_id
      ? db.queryOne<{ name: string; phone: string | null }>(
          `SELECT trim(first_name || ' ' || last_name) AS name, phone FROM ipy_user WHERE id = $1`,
          [record.owner_id],
        )
      : Promise.resolve(null),
    db.queryOne<{ value: string }>(`SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.name'`),
    db.query<{ direction: string; body: string | null; created_at: string }>(
      `SELECT m.direction, m.body, m.created_at
       FROM ipy_message m JOIN ipy_conversation c ON c.id = m.conversation_id
       WHERE c.record_id = $1 AND m.body IS NOT NULL
       ORDER BY m.created_at DESC LIMIT 8`,
      [recordId],
    ),
    db.query<{ ai_summary: string | null; disposition: string | null; started_at: string }>(
      `SELECT ai_summary, disposition, started_at FROM ipy_call
       WHERE record_id = $1 AND (ai_summary IS NOT NULL OR disposition IS NOT NULL)
       ORDER BY started_at DESC LIMIT 3`,
      [recordId],
    ),
  ]);

  const parts: string[] = [];
  if (messages.rows.length) {
    parts.push(`Recent conversation (newest first):\n${messages.rows
      .map((m) => `- ${m.direction === 'inbound' ? 'Customer' : 'Us'}: ${m.body}`)
      .join('\n')}`);
  }
  if (calls.rows.length) {
    parts.push(`Recent calls:\n${calls.rows
      .map((c) => `- ${new Date(c.started_at).toLocaleDateString('en-IN')}: ${c.ai_summary ?? c.disposition}`)
      .join('\n')}`);
  }
  return {
    label: record.label,
    summary,
    ownerName: owner?.name ?? 'the sales team',
    orgName: org?.value ?? 'iPropy Realty',
    history: parts.join('\n\n') || 'No prior interaction recorded.',
  };
}

/** Compact, human-readable snapshot of a record for prompt context. */
export async function buildRecordSummary(
  recordId: string,
  module: string,
  visibleFields?: ReadonlySet<string>,
): Promise<string> {
  const { registry } = await import('../core/metadata/registry.js');
  const meta = await registry.getModule(module);
  if (!meta) return '';

  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT r.*, e.* FROM ipy_record r JOIN ${meta.tableName} e ON e.record_id = r.id WHERE r.id = $1`,
    [recordId],
  );
  if (!row) return '';

  const custom = (row.custom_fields ?? {}) as Record<string, unknown>;
  const lines: string[] = [];

  for (const field of meta.fields) {
    if (!field.isActive || field.displayType === 'hidden') continue;
    if (visibleFields && !visibleFields.has(field.name)) continue;
    const raw = field.storage === 'column' ? row[field.columnName] : custom[field.columnName];
    if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && !raw.length)) continue;

    let display: string;
    if (field.uitype === 'reference') {
      const ref = await db.queryOne<{ label: string }>(`SELECT label FROM ipy_record WHERE id = $1`, [raw]);
      display = ref?.label ?? '';
      if (!display) continue;
    } else if (field.uitype === 'currency') {
      display = formatIndianPrice(Number(raw));
    } else if (Array.isArray(raw)) {
      display = raw.join(', ');
    } else if (typeof raw === 'object') {
      continue;
    } else {
      display = String(raw);
    }
    lines.push(`- ${field.label}: ${display}`);
  }

  return lines.join('\n');
}

const CHANNEL_RULES: Record<string, string> = {
  whatsapp: `Write for WhatsApp:
- Under 60 words. Short lines. No greeting block, no signature.
- One clear ask at the end (a question or a specific next step).
- Plain text. At most one emoji, and only if it genuinely fits.
- Never use marketing clichés ("dream home", "luxury living", "don't miss out").`,
  sms: `Write for SMS: under 160 characters, one sentence of value plus one call to action.`,
  email: `Write a business email:
- Subject line under 60 characters, specific, no clickbait.
- 3-5 short paragraphs, scannable. Use a bullet list for property details.
- Sign off with the sales rep's name.`,
  call_script: `Write a call opener a rep can read aloud:
- Opening line that earns the next 20 seconds.
- 3 qualifying questions tailored to what is already known.
- Two likely objections with a one-line response each.`,
};

export async function draftMessage(input: DraftInput): Promise<DraftResult | null> {
  if (!isAiAvailable()) return null;

  const ctx = await buildContext(
    input.recordId,
    input.module,
    input.visibleFields ? new Set(input.visibleFields) : undefined,
  );
  if (!ctx) return null;

  let propertyBlock = '';
  if (input.includeProperties) {
    const matches = await matchForRecord(input.recordId, { limit: 3, persist: false, scope: input.scope });
    if (matches.length) {
      propertyBlock = `\n## Matching inventory you may reference (do not invent others)\n${matches
        .map((m) => `- ${m.propertyLabel} — ${m.bedrooms != null ? `${m.bedrooms} BHK` : ''} — ${m.price ? formatIndianPrice(m.price) : ''}${
          m.reasons.length ? ` (${m.reasons[0]})` : ''}`)
        .join('\n')}`;
    }
  }

  // Everything here came from the customer: their name, their history, and the
  // message they just sent, which is the most obvious place to try this.
  const fence = fenceId();

  const prompt = `Draft a ${input.channel === 'call_script' ? 'call script' : `${input.channel} message`} for this CRM record.

## Who they are
${fenced(fence, 'Record', `${ctx.label}\n${ctx.summary}`)}

${fenced(fence, '## Interaction history', ctx.history)}
${propertyBlock}

${input.replyingTo ? `${fenced(fence, '## They just said', input.replyingTo)}\n` : ''}
## Goal
${input.goal ?? 'Move the conversation to the next step of the sales process.'}

## Style
Tone: ${input.tone ?? 'warm'} but businesslike. From ${ctx.ownerName} at ${ctx.orgName}.
${input.language && input.language !== 'English' ? `Write in ${input.language}.` : ''}

${CHANNEL_RULES[input.channel] ?? CHANNEL_RULES.whatsapp}

Reference specifics from the data above — the project name, price, or something they actually said. A generic message is a failed message.

${input.channel === 'email'
  ? 'Return the subject on the first line prefixed with "Subject: ", then a blank line, then the body.'
  : 'Return only the message text, nothing else.'}`;

  const result = await complete({
    feature: `draft_${input.channel}`,
    system: `${REAL_ESTATE_SYSTEM}\n\n${untrustedRule(fence)}`,
    prompt,
    temperature: 0.6,
    maxTokens: 900,
    recordId: input.recordId,
    userId: input.userId ?? null,
  });
  if (!result) return null;

  const text = result.text.trim();
  if (input.channel === 'email') {
    const match = text.match(/^Subject:\s*(.+?)\n\n?([\s\S]+)$/);
    if (match) return { subject: match[1].trim(), body: match[2].trim() };
    return { subject: `Following up — ${ctx.label}`, body: text };
  }
  return { body: text };
}

/** Suggest 3 quick replies for the inbox composer. */
export async function suggestReplies(conversationId: string, userId?: string): Promise<string[]> {
  if (!isAiAvailable()) return [];

  const conv = await db.queryOne<{ record_id: string | null; record_module: string | null; handle: string }>(
    `SELECT record_id, record_module, handle FROM ipy_conversation WHERE id = $1`, [conversationId],
  );
  if (!conv) return [];

  const messages = await db.query<{ direction: string; body: string | null }>(
    `SELECT direction, body FROM ipy_message
     WHERE conversation_id = $1 AND body IS NOT NULL
     ORDER BY created_at DESC LIMIT 10`,
    [conversationId],
  );
  if (!messages.rows.length) return [];

  const summary = conv.record_id && conv.record_module
    ? await buildRecordSummary(conv.record_id, conv.record_module)
    : '';

  const replyFence = fenceId();

  const prompt = `A sales rep is replying on WhatsApp. Suggest three distinct short replies.

${summary ? `${fenced(replyFence, '## Contact', summary)}\n` : ''}
${fenced(replyFence, '## Conversation (newest first)', messages.rows.map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Rep'}: ${m.body}`).join('\n'))}

Each reply must:
- be under 40 words
- take a different angle (e.g. answer directly / propose a site visit / ask a qualifying question)
- reference something specific from the conversation

Return exactly three lines, each starting with "- ". No other text.`;

  const result = await complete({
    feature: 'suggest_replies',
    system: `${REAL_ESTATE_SYSTEM}\n\n${untrustedRule(replyFence)}`,
    prompt,
    fast: true,
    temperature: 0.7,
    maxTokens: 500,
    userId: userId ?? null,
    recordId: conv.record_id,
  });
  if (!result) return [];

  return result.text
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((l) => l.length > 5)
    .slice(0, 3);
}

/** Summarise a long record timeline into a paragraph a manager can skim. */
export async function summariseRecord(
  recordId: string,
  module: string,
  userId?: string,
  visibleFields?: ReadonlySet<string>,
): Promise<string | null> {
  const [summary, timeline] = await Promise.all([
    buildRecordSummary(recordId, module, visibleFields),
    import('../core/entity/timeline.js').then((m) => m.buildTimeline(recordId, { limit: 40 })),
  ]);

  const meta = await import('../core/metadata/registry.js').then((m) => m.registry.getModule(module));
  const kind = meta?.singularLabel.toLowerCase() ?? 'record';
  const facts = summary.split('\n').map((line) => line.replace(/^-\s*/, '').trim()).filter(Boolean).slice(0, 7);
  const latest = timeline[0];
  const fallback = [
    facts.length
      ? `Current ${kind} details: ${facts.join('; ')}.`
      : `This ${kind} does not yet have enough populated CRM fields for a detailed summary.`,
    latest
      ? `Latest activity: ${latest.title}${latest.body ? ` — ${latest.body.slice(0, 180)}` : ''}.`
      : 'No activity has been logged yet.',
    `Next action: review the missing details and record the next concrete follow-up in the CRM.`,
  ].join(' ');

  // A provider outage should not turn the menu item into a dead end. The
  // factual summary above is deterministic and still useful; when AI is
  // connected it is replaced by the richer, context-aware version below.
  if (!isAiAvailable()) return fallback;

  const summaryFence = fenceId();

  const prompt = `Summarise where this ${kind} stands in iPropy CRM.

${fenced(summaryFence, '## Record', summary)}

${fenced(summaryFence, '## Activity (newest first)', timeline.map((t) => `- [${new Date(t.at).toLocaleDateString('en-IN')}] ${t.title}${t.body ? `: ${t.body.slice(0, 200)}` : ''}`).join('\n'))}

Write 3-5 sentences using only the facts above. For a lead, cover their buying journey, priorities, blockers and next action. For a property, cover availability, important facts, media/activity state and next action. For any other record, describe its current state and the single most useful next action. Be specific. If a fact is missing, say it is missing rather than inventing it. No preamble.`;

  const result = await complete({
    feature: 'summarise_record',
    system: `${REAL_ESTATE_SYSTEM}\n\n${untrustedRule(summaryFence)}`,
    prompt,
    maxTokens: 600,
    recordId,
    userId: userId ?? null,
  });
  return result?.text.trim() || fallback;
}
