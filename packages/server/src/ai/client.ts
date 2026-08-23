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
import {
  getAiFallbackChain, getAiProviderSettings, getSettings, type AiProvider,
} from '../core/settings/integrations.js';
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

/**
 * One picture to look at.
 *
 * Bytes rather than a URL on purpose. Every provider accepts inline base64, and
 * only some accept a URL — and the ones that do have to be able to *reach* it,
 * which our permission-checked `/api/files/:id` is specifically designed to stop
 * them doing. Handing over the bytes we already hold avoids inventing a public
 * hole in the one endpoint that guards site photos.
 *
 * Callers are expected to have downscaled already: an iPhone frame is several
 * megabytes and costs tokens by the pixel. See `core/capture/vision.ts`.
 */
export interface VisionImage {
  data: Buffer;
  /** image/jpeg, image/png or image/webp — the three every provider accepts. */
  mimeType: string;
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
  /**
   * Pictures the model should look at, in the order the prompt refers to them.
   *
   * A provider or model with no vision support answers with a 4xx, which the
   * fallback chain treats like any other whole-provider failure and steps past —
   * so configuring a text-only model does not break the feature, it just means
   * the next provider gets the call, and `complete` returns null if none can.
   */
  images?: VisionImage[];
  /**
   * Ask this exact model rather than the provider's configured one.
   *
   * Only two callers want this: the model-test button, which is testing a
   * specific id somebody just typed, and the media pipeline, where "which model
   * reads photographs" is its own setting. Everything else should take whatever
   * the provider is pointed at, or there would be a second place deciding.
   */
  model?: string;
}

export interface CompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * A provider that has run out of quota is still out of quota a second later, but
 * the scheduler calls AI every minute forever. Observed on a free Gemini key: the
 * same 429 three times a call (`fetchWithRetry` backs off twice), several calls a
 * minute, all night — noise that buries real errors, and every attempt burns a
 * request against a quota that only resets on a timer.
 *
 * So a rate-limited provider is set aside for ten minutes. Keying by the key's
 * last characters rather than by provider name is what makes recovery immediate:
 * pasting a fresh key — the actual fix — is a different entry and is tried at
 * once. "Test connection" calls the transports directly and is never paused.
 */
const COOLDOWN_MS = 10 * 60 * 1000;
const cooldowns = new Map<string, number>();

function cooldownKey(ai: { provider: AiProvider; apiKey: string }): string {
  return `${ai.provider}:${ai.apiKey.slice(-6)}`;
}

function isCoolingDown(ai: { provider: AiProvider; apiKey: string }): boolean {
  const until = cooldowns.get(cooldownKey(ai));
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  cooldowns.delete(cooldownKey(ai));
  return false;
}

function noteRateLimit(ai: { provider: AiProvider; apiKey: string }, message: string): void {
  if (!/\b429\b|too many requests|quota|rate.?limit/i.test(message)) return;
  cooldowns.set(cooldownKey(ai), Date.now() + COOLDOWN_MS);
  logger.warn(
    { provider: ai.provider, minutes: COOLDOWN_MS / 60_000 },
    'AI provider is rate-limited; pausing it and falling back to the rule engine',
  );
}

/**
 * Reasoning models count hidden thinking against the output ceiling before
 * they write the visible answer. Small per-feature caps such as 400 or 700 can
 * therefore produce an empty, length-truncated response even though the model
 * and API key are working. This is only a ceiling, not reserved/spent tokens.
 */
export const MIN_OUTPUT_TOKENS = 2500;

export function outputTokenLimit(requested: number | undefined, configured: number): number {
  return Math.max(requested ?? configured, MIN_OUTPUT_TOKENS);
}

/**
 * Run a completion, falling through to the next configured provider if the
 * chosen one fails outright.
 *
 * The failure this prevents is real and was hard to diagnose from the UI: an
 * OpenAI-compatible entry pointing at `http://localhost:…` was left active on
 * a deployed server, so it won provider selection, every request failed, and a
 * working Gemini key sat unused behind it. The panel showed "Active" and the
 * assistant just said it couldn't help.
 *
 * Only whole-provider failures fall through (unreachable host, bad key,
 * retired model). A provider that answers is trusted — retrying elsewhere on a
 * merely unhelpful answer would double the bill for no gain.
 */
export async function complete(opts: CompleteOptions): Promise<CompleteResult | null> {
  const settings = getSettings().ai;
  if (!settings.enabled) return null;

  const chain = getAiFallbackChain().filter((ai) => !isCoolingDown(ai));
  if (!chain.length) return null;

  let lastError = 'No provider answered.';

  for (const [index, ai] of chain.entries()) {
    const model = opts.model ?? (opts.fast ? ai.fastModel : ai.model);
    const maxTokens = outputTokenLimit(opts.maxTokens, ai.maxTokens);
    const temperature = opts.temperature ?? 0.2;
    const started = Date.now();

    try {
      const result = ai.provider === 'anthropic'
        ? await callAnthropic(ai.apiKey, model, maxTokens, temperature, opts)
        : await callOpenAiCompatible(ai.baseUrl, ai.apiKey, model, maxTokens, temperature, opts);

      await logCall(opts, result, Date.now() - started, true, null);
      if (index > 0) {
        logger.warn({ feature: opts.feature, provider: ai.provider }, 'primary AI provider failed; answered from fallback');
      }
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err, feature: opts.feature, provider: ai.provider, model }, 'AI call failed');
      await logCall(opts, null, Date.now() - started, false, lastError);
      noteRateLimit(ai, lastError);
    }
  }

  logger.error({ feature: opts.feature, tried: chain.map((c) => c.provider) }, 'every AI provider failed');
  return null;
}

async function callAnthropic(
  apiKey: string, model: string, maxTokens: number, temperature: number, opts: CompleteOptions,
): Promise<CompleteResult> {
  // Images before the text, which is what Anthropic's own guidance asks for:
  // a question read after the pictures is answered about the pictures.
  const content: Anthropic.ContentBlockParam[] = opts.images?.length
    ? [
      ...opts.images.map((image): Anthropic.ImageBlockParam => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimeType as Anthropic.Base64ImageSource['media_type'],
          data: image.data.toString('base64'),
        },
      })),
      { type: 'text', text: opts.prompt },
    ]
    : [{ type: 'text', text: opts.prompt }];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];
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

  if (!text.trim()) {
    throw new Error(`Model returned no text (stop reason: ${response.stop_reason ?? 'unknown'}). Increase its output allowance or choose another model.`);
  }

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
  choices?: { finish_reason?: string | null; message?: { content?: string | null } }[];
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
export type OpenAiContent = string | ({ type: 'text'; text: string } | {
  type: 'image_url'; image_url: { url: string };
})[];

/**
 * The user turn, as a plain string when there are no pictures.
 *
 * Kept as a string in the text-only case deliberately. The content-array form
 * is part of the spec, but it is the newer half of it and several of the
 * smaller OpenAI-compatible servers — the free tiers this product is expected
 * to run on — only ever implemented the string. Sending an array to all of them
 * would be correct and would break working setups, for no gain.
 */
export function userContent(opts: Pick<CompleteOptions, 'prompt' | 'images'>): OpenAiContent {
  if (!opts.images?.length) return opts.prompt;
  return [
    ...opts.images.map((image) => ({
      type: 'image_url' as const,
      image_url: { url: `data:${image.mimeType};base64,${image.data.toString('base64')}` },
    })),
    { type: 'text' as const, text: opts.prompt },
  ];
}

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
        { role: 'user', content: userContent(opts) },
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

  const choice = json.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (!text.trim()) {
    throw new Error(`Model returned no text (finish reason: ${choice?.finish_reason ?? 'unknown'}). Increase its output allowance or choose another model.`);
  }
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
