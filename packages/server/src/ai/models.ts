/**
 * Live model discovery for the integrations screen.
 *
 * Model catalogues move much faster than this CRM does. Keeping a hard-coded
 * dropdown simply replaces a text box with a stale text box, so each provider
 * is asked for its current catalogue. A small built-in list remains as an
 * offline fallback and the UI still permits a custom model id.
 *
 * OpenCode Zen is unusual: one catalogue contains models exposed through four
 * different API shapes. The CRM currently speaks OpenAI chat-completions, so we
 * deliberately hide Zen models that require /responses, /messages or Google's
 * native generateContent endpoint. Showing a model that cannot be called would
 * make the selector actively misleading.
 */
import {
  getAiProviderSettings, getSttProviderSettings, type AiProvider,
} from '../core/settings/integrations.js';
import { logger } from '../utils/logger.js';

type ConcreteAiProvider = Exclude<AiProvider, 'none'>;

export interface AiModelOption {
  id: string;
  label: string;
  contextLength: number | null;
  free: boolean;
  vision: boolean;
}

export interface AiModelCatalogue {
  models: AiModelOption[];
  /** False means the safe built-in fallback is being shown. */
  live: boolean;
  warning?: string;
}

const PROVIDER_BY_ROW: Record<string, ConcreteAiProvider> = {
  anthropic: 'anthropic',
  ai_gemini: 'gemini',
  ai_groq: 'groq',
  ai_openrouter: 'openrouter',
  ai_openai: 'openai',
};

const FALLBACK_MODELS: Record<ConcreteAiProvider | 'stt', string[]> = {
  anthropic: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  gemini: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
  groq: ['openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
  openrouter: ['openrouter/free'],
  openai: ['gpt-4o-mini'],
  stt: ['whisper-large-v3-turbo', 'whisper-large-v3', 'whisper-1'],
};

interface RawModel {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  input_token_limit?: unknown;
  supportedGenerationMethods?: unknown;
  architecture?: { input_modalities?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown };
  api?: unknown;
  transport?: unknown;
  endpoint?: unknown;
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function zeroPrice(value: unknown): boolean {
  return value === 0 || value === '0' || value === '0.0' || value === '0.000000';
}

function option(raw: RawModel, fallbackId = ''): AiModelOption | null {
  const id = String(raw.id ?? fallbackId).replace(/^models\//, '').trim();
  if (!id) return null;
  const modalities = Array.isArray(raw.architecture?.input_modalities)
    ? raw.architecture.input_modalities.map(String)
    : [];
  return {
    id,
    label: String(raw.name ?? raw.displayName ?? id),
    contextLength: asNumber(raw.context_length ?? raw.context_window ?? raw.input_token_limit),
    free: id.endsWith('-free') || id.endsWith(':free')
      || (zeroPrice(raw.pricing?.prompt) && zeroPrice(raw.pricing?.completion)),
    vision: modalities.includes('image'),
  };
}

/** Pure and exported because a bad filter silently creates broken UI choices. */
export function isOpenCodeChatCompletionModel(raw: RawModel | string): boolean {
  const model = typeof raw === 'string' ? { id: raw } : raw;
  const id = String(model.id ?? '').toLowerCase();
  const declaredApi = `${String(model.api ?? '')} ${String(model.transport ?? '')} ${String(model.endpoint ?? '')}`.toLowerCase();
  if (/chat.?completions|openai.?chat/.test(declaredApi)) return true;
  if (/\/responses|\/messages|generatecontent|anthropic|google/.test(declaredApi)) return false;

  // The Zen catalogue documents these families as OpenAI chat-completions.
  // GPT, Claude, Qwen and Gemini use other Zen endpoints and are excluded.
  return /^(?:deepseek|mimo|minimax|glm|kimi|grok|nemotron|north)-/.test(id)
    || id === 'big-pickle';
}

function isGeneralChatModel(provider: ConcreteAiProvider, raw: RawModel, id: string): boolean {
  const lower = id.toLowerCase();
  if (provider === 'gemini') {
    const methods = Array.isArray(raw.supportedGenerationMethods)
      ? raw.supportedGenerationMethods.map(String)
      : [];
    return methods.includes('generateContent');
  }
  if (provider === 'openrouter' || provider === 'anthropic') return true;
  // OpenAI-compatible catalogues often mix chat, audio, image and embedding
  // models. Only the first category can be used by ai/client.ts today.
  return !/(?:embedding|whisper|transcri|tts|dall-e|image-|moderation|realtime|audio)/i.test(lower);
}

export function parseModelCatalogue(
  provider: ConcreteAiProvider,
  body: unknown,
): AiModelOption[] {
  const payload = body as { data?: unknown; models?: unknown };
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

  const found = new Map<string, AiModelOption>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as RawModel;
    const parsed = option(raw, String(raw.name ?? ''));
    if (!parsed || !isGeneralChatModel(provider, raw, parsed.id)) continue;
    found.set(parsed.id, parsed);
  }
  return [...found.values()].sort((a, b) => Number(b.free) - Number(a.free) || a.label.localeCompare(b.label));
}

function fallback(provider: ConcreteAiProvider | 'stt', configured: string[] = [], warning?: string): AiModelCatalogue {
  const ids = [...new Set([...configured.filter(Boolean), ...FALLBACK_MODELS[provider]])];
  return {
    live: false,
    ...(warning ? { warning } : {}),
    models: ids.map((id) => ({
      id,
      label: id,
      contextLength: null,
      free: id.endsWith('-free') || id.endsWith(':free'),
      vision: provider === 'gemini',
    })),
  };
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
  return response.json();
}

async function liveAiModels(provider: ConcreteAiProvider): Promise<AiModelOption[]> {
  const settings = getAiProviderSettings(provider);
  if (!settings) throw new Error('Save an API key first.');

  if (provider === 'anthropic') {
    const body = await fetchJson('https://api.anthropic.com/v1/models?limit=1000', {
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
    });
    return parseModelCatalogue(provider, body);
  }

  if (provider === 'gemini') {
    const body = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(settings.apiKey)}`,
      {},
    );
    return parseModelCatalogue(provider, body);
  }

  return parseModelCatalogue(
    provider,
    await fetchJson(`${settings.baseUrl.replace(/\/$/, '')}/models`, {
      authorization: `Bearer ${settings.apiKey}`,
    }),
  );
}

async function liveSttModels(): Promise<AiModelOption[]> {
  const settings = getSttProviderSettings();
  if (!settings.apiKey) throw new Error('Save the speech API key first.');
  const body = await fetchJson(`${settings.baseUrl.replace(/\/$/, '')}/models`, {
    authorization: `Bearer ${settings.apiKey}`,
  }) as { data?: unknown };
  const list = Array.isArray(body.data) ? body.data : [];
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const parsed = option(item as RawModel);
    return parsed && /whisper|transcri|speech.?to.?text/i.test(parsed.id) ? [parsed] : [];
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Return a usable catalogue even if the vendor is down. This endpoint powers
 * admin UI only, so catalogue failure must never disable actual completions.
 */
export async function listIntegrationModels(rowProvider: string): Promise<AiModelCatalogue | null> {
  if (rowProvider === 'stt') {
    const stt = getSttProviderSettings();
    try {
      const models = await liveSttModels();
      if (!models.length) throw new Error('The provider returned no transcription models.');
      return { models, live: true };
    } catch (err) {
      const warning = err instanceof Error ? err.message : 'Could not load models.';
      logger.debug({ err, provider: rowProvider }, 'AI model catalogue unavailable');
      return fallback('stt', [stt.model], warning);
    }
  }

  const provider = PROVIDER_BY_ROW[rowProvider];
  if (!provider) return null;
  const settings = getAiProviderSettings(provider);
  const configured = settings ? [settings.model, settings.fastModel] : [];
  try {
    const models = await liveAiModels(provider);
    if (!models.length) throw new Error('The provider returned no compatible chat models.');
    // Keep a configured legacy/custom id visible even if the vendor omits it.
    const byId = new Map(models.map((model) => [model.id, model]));
    for (const id of configured) {
      if (id && !byId.has(id)) byId.set(id, fallback(provider, [id]).models[0]!);
    }
    return { models: [...byId.values()], live: true };
  } catch (err) {
    const warning = err instanceof Error ? err.message : 'Could not load models.';
    logger.debug({ err, provider }, 'AI model catalogue unavailable');
    return fallback(provider, configured, warning);
  }
}
