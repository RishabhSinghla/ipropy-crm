/**
 * LLM client wrapper.
 *
 * Every AI feature goes through here so we get: one place for provider and
 * model selection, token accounting, structured-output parsing, graceful
 * degradation when nothing is configured, and an audit row per call.
 *
 * Two transports cover every supported provider. Anthropic uses its own SDK;
 * everything else — Gemini via Google's OpenAI-compatible endpoint, Groq,
 * OpenRouter, OpenAI, a local Ollama — speaks the OpenAI chat-completions
 * shape, so a single `fetch` adapter reaches all of them. Which one is in play
 * is decided in core/settings/integrations.ts, not here.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { getAiProviderSettings, getSettings, type AiProvider } from '../core/settings/integrations.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';

let client: Anthropic | null = null;
let clientKey: string | null = null;

function getAnthropic(apiKey: string): Anthropic {
  // Rebuild if the admin rotated the key via the integrations panel — a stale
  // client would keep authenticating with the old one.
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

export function isAiAvailable(): boolean {
  const { enabled, provider } = getSettings().ai;
  return Boolean(enabled && provider !== 'none');
}

/** For the admin panel and the `aiAvailable` flag the web app reads at login. */
export function aiStatus(): { available: boolean; provider: string; model: string } {
  const { enabled, provider, model } = getSettings().ai;
  return { available: Boolean(enabled && provider !== 'none'), provider, model };
}

/**
 * Round-trip one cheap completion against a named provider.
 *
 * Deliberately a real generation rather than a `/models` listing: a key can
 * list models and still be out of quota, be scoped to the wrong project, or
 * name a model that has been retired — all of which show up here as the same
 * failure the CRM would hit, which is the point of a connectivity test.
 */
export async function testAiProvider(
  provider: Exclude<AiProvider, 'none'>,
): Promise<{ ok: boolean; message: string }> {
  const settings = getAiProviderSettings(provider);
  if (!settings) {
    return {
      ok: false,
      message: provider === 'ollama'
        ? 'Enable this provider first — Ollama needs no key, but it does need to be switched on and running.'
        : 'An API key is required.',
    };
  }

  try {
    const started = Date.now();
    // 512, not a token or two. Newer reasoning models (Gemini 3.x, o-series)
    // spend the budget on internal thinking *before* emitting anything, so a
    // tight cap returns finish_reason "length" with empty content — a working
    // key that looks broken. Measured: a one-word reply cost 100 tokens, of
    // which 1 was output.
    const testOptions = {
      feature: 'connectivity_test', system: 'Reply with the single word OK.', prompt: 'Say OK.',
    };
    const result = provider === 'anthropic'
      ? await callAnthropic(settings.apiKey, settings.fastModel, 512, 0, testOptions)
      : await callOpenAiCompatible(settings.baseUrl, settings.apiKey, settings.fastModel, 512, 0, testOptions);
    if (!result.text.trim()) {
      return {
        ok: false,
        message: `${settings.fastModel} accepted the key but returned nothing. This usually means the model spent its whole token budget thinking — raise Max tokens.`,
      };
    }
    return { ok: true, message: `Connected — ${settings.fastModel} replied in ${Date.now() - started}ms.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed.' };
  }
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
  const ai = getSettings().ai;
  if (!ai.enabled || ai.provider === 'none') return null;

  const model = opts.fast ? ai.fastModel : ai.model;
  const maxTokens = opts.maxTokens ?? ai.maxTokens;
  const temperature = opts.temperature ?? 0.2;
  const started = Date.now();

  try {
    const result = ai.provider === 'anthropic'
      ? await callAnthropic(ai.apiKey, model, maxTokens, temperature, opts)
      : await callOpenAiCompatible(ai.baseUrl, ai.apiKey, model, maxTokens, temperature, opts);

    await logCall(opts, result, Date.now() - started, true, null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, feature: opts.feature, provider: ai.provider, model }, 'AI call failed');
    await logCall(opts, null, Date.now() - started, false, message);
    return null;
  }
}

async function callAnthropic(
  apiKey: string, model: string, maxTokens: number, temperature: number, opts: CompleteOptions,
): Promise<CompleteResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.prompt }];
  if (opts.prefill) messages.push({ role: 'assistant', content: opts.prefill });

  const response = await getAnthropic(apiKey).messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system: opts.system,
    messages,
    ...(opts.stopSequences ? { stop_sequences: opts.stopSequences } : {}),
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    // Prefill isn't echoed back, so re-attach it for the caller's parser.
    text: opts.prefill ? opts.prefill + text : text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model,
  };
}

/**
 * Statuses worth trying again: the provider is busy or briefly broken, not
 * refusing us. 401/403/404 are excluded deliberately — a bad key or a retired
 * model will fail identically on the tenth attempt, and retrying only delays
 * the error the operator needs to see.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Free tiers rate-limit and go briefly unavailable as a matter of course —
 * observed in practice: Gemini answered a digest fine and returned
 * 503 "experiencing high demand" for the next call seconds later. Without a
 * retry, every one of those is a feature that silently fell back to its rule
 * engine, which reads to the user as "the AI doesn't work".
 *
 * Two extra attempts with exponential backoff, honouring Retry-After when the
 * provider sends one.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await fetch(url, init);
    if (res.ok || !RETRYABLE.has(res.status)) return res;
    last = res;
    if (attempt === attempts - 1) break;

    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 10_000)
      : 400 * 2 ** attempt;
    logger.debug({ status: res.status, attempt: attempt + 1, waitMs }, 'AI provider busy, retrying');
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return last!;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/**
 * Gemini / Groq / OpenRouter / OpenAI / Ollama.
 *
 * Two differences from the Anthropic path are worth knowing about:
 *
 * - Assistant prefill is not part of the OpenAI shape. Several of these
 *   providers reject or ignore a trailing assistant turn, so `completeJson`'s
 *   "{" trick is instead expressed as an instruction and the response is
 *   normalised below. `parseJson` already tolerates fences and prose, which is
 *   what makes this safe.
 * - There is no shared SDK. Raw `fetch` keeps the dependency list unchanged and
 *   works identically against a local Ollama, which is the zero-cost option.
 */
async function callOpenAiCompatible(
  baseUrl: string, apiKey: string, model: string, maxTokens: number, temperature: number, opts: CompleteOptions,
): Promise<CompleteResult> {
  const system = opts.prefill
    ? `${opts.system}\n\nBegin your reply directly with ${opts.prefill.trim()} — no preamble, no code fences.`
    : opts.system;

  const response = await fetchWithRetry(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      // OpenRouter attributes traffic with these and rate-limits unattributed
      // callers harder; harmless everywhere else.
      'http-referer': config.appUrl,
      'x-title': 'iPropy CRM',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: opts.prompt },
      ],
      ...(opts.stopSequences ? { stop: opts.stopSequences } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }

  const json = await response.json() as ChatCompletionResponse;
  if (json.error) {
    throw new Error(typeof json.error === 'string' ? json.error : (json.error.message ?? 'provider error'));
  }

  const text = json.choices?.[0]?.message?.content ?? '';
  return {
    text,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    model,
  };
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
