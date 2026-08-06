/**
 * Anthropic client wrapper.
 *
 * Every AI feature goes through here so we get: one place for model selection,
 * token accounting, structured-output parsing, graceful degradation when no API
 * key is present, and an audit row per call.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getSettings } from '../core/settings/integrations.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';

let client: Anthropic | null = null;
let clientKey: string | null = null;

function getClient(): Anthropic | null {
  const { enabled, apiKey } = getSettings().ai;
  if (!enabled || !apiKey) return null;
  // Rebuild if the admin rotated the key via the integrations panel — a stale
  // client would keep authenticating with the old one.
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

export function isAiAvailable(): boolean {
  const { enabled, apiKey } = getSettings().ai;
  return Boolean(enabled && apiKey);
}

export interface CompleteOptions {
  /** feature name for logging, e.g. 'lead_scoring' */
  feature: string;
  system: string;
  prompt: string;
  /** use the fast model for cheap, high-volume calls */
  fast?: boolean;
  maxTokens?: number;
  temperature?: number;
  userId?: string | null;
  recordId?: string | null;
  /** prefill the assistant turn — the reliable way to force JSON */
  prefill?: string;
  stopSequences?: string[];
}

export interface CompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export async function complete(opts: CompleteOptions): Promise<CompleteResult | null> {
  const api = getClient();
  if (!api) return null;

  const aiSettings = getSettings().ai;
  const model = opts.fast ? aiSettings.fastModel : aiSettings.model;
  const started = Date.now();

  try {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.prompt }];
    if (opts.prefill) messages.push({ role: 'assistant', content: opts.prefill });

    const response = await api.messages.create({
      model,
      max_tokens: opts.maxTokens ?? aiSettings.maxTokens,
      temperature: opts.temperature ?? 0.2,
      system: opts.system,
      messages,
      ...(opts.stopSequences ? { stop_sequences: opts.stopSequences } : {}),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const result: CompleteResult = {
      // Prefill isn't echoed back, so re-attach it for the caller's parser.
      text: opts.prefill ? opts.prefill + text : text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model,
    };

    await logCall(opts, result, Date.now() - started, true, null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, feature: opts.feature }, 'AI call failed');
    await logCall(opts, null, Date.now() - started, false, message);
    return null;
  }
}

/**
 * Ask for JSON and parse it. Uses an assistant prefill of `{` so the model
 * cannot open with prose, and tolerates fenced output as a fallback.
 */
export async function completeJson<T>(opts: Omit<CompleteOptions, 'prefill'>): Promise<T | null> {
  const result = await complete({
    ...opts,
    prefill: '{',
    system: `${opts.system}\n\nRespond with a single valid JSON object and nothing else. Do not wrap it in markdown fences.`,
  });
  if (!result) return null;
  return parseJson<T>(result.text);
}

export function parseJson<T>(text: string): T | null {
  const attempts = [
    text,
    text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''),
    // Last resort: grab the outermost braces.
    text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1),
  ];
  for (const candidate of attempts) {
    try {
      const trimmed = candidate.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
      return JSON.parse(trimmed) as T;
    } catch {
      continue;
    }
  }
  logger.warn({ preview: text.slice(0, 300) }, 'failed to parse AI JSON response');
  return null;
}

async function logCall(
  opts: CompleteOptions,
  result: CompleteResult | null,
  latencyMs: number,
  success: boolean,
  error: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO ipy_ai_log
      (feature, model, user_id, record_id, prompt_summary, input_tokens, output_tokens, latency_ms, success, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      opts.feature,
      result?.model ?? (opts.fast ? getSettings().ai.fastModel : getSettings().ai.model),
      opts.userId ?? null,
      opts.recordId ?? null,
      opts.prompt.slice(0, 500),
      result?.inputTokens ?? 0,
      result?.outputTokens ?? 0,
      latencyMs,
      success,
      error,
    ],
  ).catch((err) => logger.debug({ err }, 'failed to write AI log'));
}

/** Persist an insight so it shows on the record and in the timeline. */
export async function saveInsight(input: {
  recordId: string | null;
  module: string | null;
  kind: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  score?: number | null;
  confidence?: number | null;
  model?: string;
  userId?: string | null;
  /** replace any previous insight of the same kind for this record */
  replace?: boolean;
}): Promise<string | null> {
  if (input.replace && input.recordId) {
    await db.query(`DELETE FROM ipy_ai_insight WHERE record_id = $1 AND kind = $2`, [input.recordId, input.kind]);
  }
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_ai_insight
      (record_id, module_name, kind, title, body, data, score, confidence, model, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.recordId, input.module, input.kind, input.title, input.body,
      JSON.stringify(input.data ?? {}), input.score ?? null, input.confidence ?? null,
      input.model ?? getSettings().ai.model, input.userId ?? null,
    ],
  );
  return row?.id ?? null;
}

/** Shared context every prompt gets, so the model reasons like a domain expert. */
export const REAL_ESTATE_SYSTEM = `You are the AI assistant inside iPropy, a CRM used by Indian real-estate developers and brokerages.

Domain context you should assume:
- Prices are in Indian rupees. 1 lakh = 100,000; 1 crore = 10,000,000. Write ₹1.45 Cr, ₹85 L.
- Typical journey: enquiry → qualification call → site visit → revisit (often with family) → negotiation → token amount → booking → agreement → registration → possession.
- Buyers care about: carpet vs super built-up area, floor and facing, Vastu, possession date, RERA registration, home-loan eligibility, and total cost including GST, stamp duty and registration.
- A site visit is the single strongest conversion signal. A revisit with family is stronger still.
- Speed of first response is the biggest controllable factor in conversion.
- Channel partners (brokers) are a major lead source and are commission-sensitive.

Be concrete and quantitative. Reference actual values from the data you are given. Never invent inventory, prices, or facts that are not in the provided context. If information is missing, say so rather than guessing.`;
