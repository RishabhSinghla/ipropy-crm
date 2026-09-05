/**
 * DB-backed integration settings — the alternative to editing `.env`.
 *
 * `ipy_integration` has always existed and the WhatsApp provider already read
 * from it, but nothing ever wrote to it: there was no admin endpoint, so the
 * table's seeded rows sat at `is_active = false` forever regardless of what an
 * admin configured, and every other integration (telephony, email, AI,
 * lead-source webhook keys) still only read `process.env` directly.
 *
 * This module is the one place that resolves "what credentials are actually in
 * effect": a DB row's `credentials`/`config`, admin-editable at runtime, take
 * priority; `.env` values remain a fallback for anyone who still sets them.
 * `ANTHROPIC_API_KEY` empty and no DB row is the normal dev state and every
 * feature must keep degrading gracefully in that case.
 *
 * Credentials are encrypted at rest (AES-256-GCM) with a key derived from
 * JWT_SECRET, so plugging this in needs no new required environment variable —
 * consistent with "configure everything from the UI, not the codebase".
 *
 * Resolution is synchronous (`getSettings()`) because callers like the AI
 * client and telephony adapters are invoked from many places, several of them
 * hot paths that were written as plain synchronous checks. A snapshot is
 * loaded at boot (`warmup`) and reloaded eagerly whenever an admin saves
 * (`invalidate`), mirroring the metadata registry's cache-then-invalidate
 * pattern but exposed synchronously instead of behind an async getter.
 */
import { config } from '../../config.js';
import { db } from '../../db/pool.js';
import { makeSecretBox } from '../secretbox.js';
import { logger } from '../../utils/logger.js';

export type AiProvider = 'none' | 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'opencode' | 'openai' | 'ollama';

interface IntegrationRow {
  id: string;
  provider: string;
  kind: string;
  label: string;
  isActive: boolean;
  config: Record<string, string>;
  credentials: Record<string, string>;
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface ResolvedSettings {
  whatsapp: {
    phoneNumberId: string;
    businessAccountId: string;
    accessToken: string;
    verifyToken: string;
    appSecret: string;
    apiVersion: string;
    active: boolean;
  };
  /**
   * WhatsApp through a phone that is already signed in, rather than through
   * Meta. Separate from `whatsapp` above because the two are different channels
   * that happen to reach the same app, and a number can only be on one of them.
   */
  telephony: {
    provider: 'none' | 'twilio' | 'exotel';
    twilio: { accountSid: string; authToken: string; callerId: string; appSid: string };
    exotel: { sid: string; apiKey: string; apiToken: string; subdomain: string; callerId: string;
      /** Shared secret on the callback URL. Exotel does not sign, so this is the only proof. */
      webhookSecret: string };
  };
  email: {
    host: string; port: number; secure: boolean; user: string; password: string; from: string;
    imap: { host: string; port: number; user: string; password: string };
  };
  ai: {
    enabled: boolean;
    /** 'none' when nothing is configured — every feature falls back to its rule engine. */
    provider: AiProvider;
    apiKey: string;
    /** OpenAI-compatible base URL; empty for Anthropic, which uses its own SDK. */
    baseUrl: string;
    model: string;
    fastModel: string;
    maxTokens: number;
  };
  stt: {
    provider: 'none' | 'openai'; apiKey: string; baseUrl: string; model: string;
  };
  /** Where crashes get reported. A DSN is not a secret — it can only write. */
  sentry: { dsn: string; environment: string };
  automation: {
    /** Where to tell n8n a shoot has finished. Blank switches the call off. */
    n8nWebhookUrl: string;
    /** What n8n must present on the way back in. Blank refuses every callback. */
    n8nCallbackSecret: string;
  };
  leadSources: {
    facebook: { appId: string; appSecret: string; pageAccessToken: string; verifyToken: string };
    googleAdsWebhookKey: string;
    /** One secret for every property portal. None of them signs a request. */
    portalWebhookKey: string;
    webformPublicKey: string;
  };
  storage: {
    driver: 'local' | 's3' | 'onedrive';
    /** Property folders live in OneDrive regardless of what serves the files. */
    foldersInOneDrive: boolean;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    onedrive: {
      tenantId: string;
      clientId: string;
      clientSecret: string;
      driveId: string;
      driveUser: string;
      rootFolder: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Encryption — AES-256-GCM, key derived from JWT_SECRET so no new required env var
// ---------------------------------------------------------------------------

// The salt is load-bearing: change it and every credential already stored
// becomes undecryptable.
const { encrypt, decrypt } = makeSecretBox('ipropy-integration-credentials');

// ---------------------------------------------------------------------------
// Load + resolve
// ---------------------------------------------------------------------------

let rows = new Map<string, IntegrationRow>();
// Declared after the AI lookup tables below, which `resolve` reads: these are
// `const`, so calling resolve() any earlier hits their temporal dead zone.
let snapshot: ResolvedSettings;

async function load(): Promise<Map<string, IntegrationRow>> {
  const res = await db.query<{
    id: string; provider: string; kind: string; label: string; is_active: boolean;
    config: Record<string, string>; credentials: Record<string, string>;
    status: string; last_sync_at: string | null; last_error: string | null;
  }>(`SELECT id, provider, kind, label, is_active, config, credentials, status, last_sync_at, last_error FROM ipy_integration`);

  const map = new Map<string, IntegrationRow>();
  for (const r of res.rows) {
    const creds: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.credentials ?? {})) creds[k] = decrypt(v);
    map.set(r.provider, {
      id: r.id, provider: r.provider, kind: r.kind, label: r.label, isActive: r.is_active,
      config: r.config ?? {}, credentials: creds, status: r.status,
      lastSyncAt: r.last_sync_at, lastError: r.last_error,
    });
  }
  return map;
}

/** DB value wins when the row exists, is active, and the field is non-empty. */
function pick(row: IntegrationRow | undefined, source: 'config' | 'credentials', key: string, envFallback: string): string {
  const v = row?.[source]?.[key];
  if (row?.isActive && v) return v;
  return envFallback;
}

/**
 * Same as `pick`, but ignores the active toggle.
 *
 * "Test connection" must read the key saved on *that card*, active or not.
 * With `pick`, a provider that was toggled off reported "An API key is
 * required" while the field right above it said "Saved (••••1234)" — a
 * contradiction on screen, and no way to test a provider before enabling it.
 * Choosing which provider goes live still respects the toggle; only reading
 * one provider's own settings ignores it.
 */
function pickStored(row: IntegrationRow | undefined, source: 'config' | 'credentials', key: string, envFallback: string): string {
  return row?.[source]?.[key] || envFallback;
}

/**
 * Which LLM the CRM talks to.
 *
 * Anthropic is the reference implementation but not a requirement: every other
 * provider here speaks the OpenAI chat-completions shape, so one adapter covers
 * Gemini (via Google's OpenAI-compatible endpoint), Groq, OpenRouter, a local
 * Ollama, and OpenAI itself. That matters because the free tiers live outside
 * Anthropic — an operator with no budget can still run every AI feature.
 *
 * Order below is deliberate: a paid Anthropic key, if present, is the best
 * output, then the free tiers by daily quota, then a local model, which costs
 * nothing but needs a machine to run on. `AI_PROVIDER` pins one explicitly.
 */
const AI_PROVIDER_ORDER: Exclude<AiProvider, 'none'>[] = [
  'anthropic', 'gemini', 'groq', 'opencode', 'openrouter', 'openai', 'ollama',
];

const AI_BASE_URLS: Record<Exclude<AiProvider, 'none' | 'anthropic'>, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  opencode: 'https://opencode.ai/zen/v1',
  openai: config.ai.openaiCompatible.baseUrl,
  ollama: config.ai.ollama.baseUrl,
};

const AI_ENV_DEFAULTS: Record<Exclude<AiProvider, 'none'>, { apiKey: string; model: string; fastModel: string }> = {
  anthropic: { apiKey: config.ai.apiKey, model: config.ai.model, fastModel: config.ai.fastModel },
  gemini: config.ai.gemini,
  groq: config.ai.groq,
  openrouter: config.ai.openrouter,
  opencode: config.ai.opencode,
  openai: {
    apiKey: config.ai.openaiCompatible.apiKey,
    model: config.ai.openaiCompatible.model,
    fastModel: config.ai.openaiCompatible.fastModel,
  },
  // Local models authenticate with nothing; the request still wants a string.
  ollama: { apiKey: 'ollama', model: config.ai.ollama.model, fastModel: config.ai.ollama.fastModel },
};

function aiCandidate(
  map: Map<string, IntegrationRow>,
  provider: Exclude<AiProvider, 'none'>,
  /** read the card's own saved settings even if it is toggled off */
  ignoreToggle = false,
): ResolvedSettings['ai'] | null {
  const row = map.get(aiRowKey(provider));
  const env = AI_ENV_DEFAULTS[provider];
  const read = ignoreToggle ? pickStored : pick;
  const apiKey = read(row, 'credentials', 'apiKey', env.apiKey);
  // Ollama is the one provider that is legitimately keyless, so it counts as
  // configured when its row is switched on rather than when a secret exists.
  const configured = provider === 'ollama'
    ? Boolean(row?.isActive) || config.ai.provider === 'ollama'
    : Boolean(apiKey);
  if (!configured) return null;
  return {
    enabled: config.ai.enabled,
    provider,
    apiKey,
    baseUrl: provider === 'anthropic'
      ? ''
      : (read(row, 'config', 'baseUrl', AI_BASE_URLS[provider]) || AI_BASE_URLS[provider]),
    model: read(row, 'config', 'model', env.model) || env.model,
    fastModel: read(row, 'config', 'fastModel', env.fastModel) || env.fastModel,
    maxTokens: Number(read(row, 'config', 'maxTokens', String(config.ai.maxTokens))) || config.ai.maxTokens,
  };
}

/**
 * Settings for one specific provider regardless of which one won resolution —
 * what the admin panel's "Test connection" needs, since it tests the card the
 * admin clicked, not whatever the CRM happens to be using.
 */
export function getAiProviderSettings(provider: Exclude<AiProvider, 'none'>): ResolvedSettings['ai'] | null {
  return aiCandidate(rows, provider, true);
}

/** Saved speech settings, even while the card is disabled, for model discovery. */
export function getSttProviderSettings(): ResolvedSettings['stt'] {
  const row = rows.get('stt');
  return {
    provider: 'openai',
    apiKey: pickStored(row, 'credentials', 'apiKey', config.stt.apiKey),
    baseUrl: pickStored(row, 'config', 'baseUrl', config.stt.baseUrl) || config.stt.baseUrl,
    model: pickStored(row, 'config', 'model', config.stt.model) || config.stt.model,
  };
}

/** Saved OneDrive card values, even before the admin enables the connector. */
export function getOneDriveProviderSettings(): ResolvedSettings['storage']['onedrive'] {
  const row = rows.get('onedrive');
  return {
    tenantId: pickStored(row, 'config', 'tenantId', config.storage.onedrive.tenantId),
    clientId: pickStored(row, 'config', 'clientId', config.storage.onedrive.clientId),
    clientSecret: pickStored(row, 'credentials', 'clientSecret', config.storage.onedrive.clientSecret),
    driveId: pickStored(row, 'config', 'driveId', config.storage.onedrive.driveId),
    driveUser: pickStored(row, 'config', 'driveUser', config.storage.onedrive.driveUser),
    rootFolder: pickStored(row, 'config', 'rootFolder', config.storage.onedrive.rootFolder) || 'iPropy Properties',
  };
}

/**
 * Every provider that has enough configuration to be usable, best first.
 *
 * `complete()` walks this so one misconfigured provider cannot take the whole
 * AI layer down — which is exactly what happened when an OpenAI-compatible
 * entry pointing at `http://localhost:…` was left active on a deployed server:
 * it won resolution, every call failed, and a perfectly good Gemini key sat
 * unused behind it.
 */
export function getAiFallbackChain(): ResolvedSettings['ai'][] {
  const chosen = snapshot.ai;
  const chain: ResolvedSettings['ai'][] = [];
  const seen = new Set<AiProvider>();

  const add = (candidate: ResolvedSettings['ai'] | null): void => {
    if (!candidate || seen.has(candidate.provider) || isUnreachable(candidate)) return;
    seen.add(candidate.provider);
    chain.push(candidate);
  };

  if (chosen.provider !== 'none') add(chosen);
  for (const provider of AI_PROVIDER_ORDER) add(aiCandidate(rows, provider));

  /*
    Last resort: providers that hold a usable key but are switched off.

    The reasoning was that being unable to answer while holding a working key is
    worse than quietly using it. An outside review pointed out the other half of
    that, and it is the more important half: an admin who switches a provider off
    is drawing a line about who may see lead notes and call recordings, not
    expressing a preference. A switch that means "off, unless" is not a switch.

    So it is now a decision somebody makes rather than one baked in.
    `useDisabledProviders` **defaults to on**, deliberately, because turning it
    off blind would be its own outage — an OpenRouter card sitting inactive while
    holding the key is exactly the shape this fallback was written for, and that
    is the live configuration here. Switch it off once every provider you want
    used is switched on.
  */
  if (allowDisabledProviders) {
    for (const provider of AI_PROVIDER_ORDER) add(aiCandidate(rows, provider, true));
  }

  return chain;
}

/*
  Read once at load and cached with the rest of the snapshot, because the
  fallback chain is built on nearly every AI call and must not become a query.
*/
let allowDisabledProviders = true;

export function setAllowDisabledProviders(allow: boolean): void {
  allowDisabledProviders = allow;
}

export function disabledProvidersAllowed(): boolean {
  return allowDisabledProviders;
}

/**
 * A loopback address cannot be reached from a hosted server.
 *
 * This is not hypothetical: an OpenAI-compatible entry pointing at
 * `http://localhost:20128/v1` was left active on the deployed CRM, won
 * provider selection, and made every AI feature fail while the panel cheerfully
 * reported "Active". In development it is a perfectly normal setup (Ollama,
 * a local proxy), so the rule only applies in production.
 */
function isUnreachable(candidate: ResolvedSettings['ai']): boolean {
  if (!config.isProd || !candidate.baseUrl) return false;
  try {
    const host = new URL(candidate.baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return true; // an unparseable base URL cannot be called either
  }
}

/**
 * Whisper-compatible transcription endpoints, keyed by AI provider.
 *
 * Both of these serve OpenAI's `/audio/transcriptions` shape on the same key
 * that answers chat, so a provider already configured for text needs nothing
 * added to also handle speech. Groq is listed first because its free tier
 * covers speech and Gemini's does not expose this endpoint at all.
 */
const STT_CAPABLE: { provider: Exclude<AiProvider, 'none'>; baseUrl: string; model: string }[] = [
  { provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  // Nemotron's streaming multilingual model costs $0.012 an hour of audio and
  // was trained on code-mixed speech, which is what a Faridabad sales call
  // actually sounds like. Below Groq only because Groq's free tier costs
  // nothing at all; either is a rounding error against a month of calls.
  {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b',
  },
  { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
];

/**
 * Speech-to-text, falling back to a key that is already here.
 *
 * The microphone in Ask iPropy and the voice note on a site visit were both
 * built, shipped and dead: they needed a *separate* `stt` integration nobody
 * had filled in, so pressing the button recorded audio and got back "speech-to
 * -text is not configured". Meanwhile a Groq key sat in the next row of the
 * same table, transcribing free of charge, unused.
 *
 * So an explicitly configured `stt` card still wins — someone who sets one has
 * decided something. Absent that, this reaches for any AI provider that can
 * already do the job, rather than making a person configure the same vendor
 * twice to use two of its endpoints.
 */
function resolveStt(map: Map<string, IntegrationRow>, sttRow: IntegrationRow | undefined): ResolvedSettings['stt'] {
  const explicitKey = pick(sttRow, 'credentials', 'apiKey', config.stt.apiKey);
  const provider = pick(sttRow, 'config', 'provider', config.stt.provider) === 'openai' ? 'openai' : 'none';

  if (explicitKey) {
    return {
      provider,
      apiKey: explicitKey,
      baseUrl: pick(sttRow, 'config', 'baseUrl', config.stt.baseUrl) || config.stt.baseUrl,
      model: pick(sttRow, 'config', 'model', config.stt.model) || config.stt.model,
    };
  }

  for (const candidate of STT_CAPABLE) {
    const ai = aiCandidate(map, candidate.provider);
    if (!ai?.apiKey) continue;
    return {
      // 'openai' here names the wire format, not the vendor — it is what
      // isSttConfigured checks and what the client speaks.
      provider: 'openai',
      apiKey: ai.apiKey,
      // The provider's own base URL if it set one, so a proxy or a regional
      // endpoint is honoured; otherwise the vendor's documented default.
      baseUrl: ai.baseUrl || candidate.baseUrl,
      model: candidate.model,
    };
  }

  return { provider: 'none', apiKey: '', baseUrl: config.stt.baseUrl, model: config.stt.model };
}

function resolveAi(map: Map<string, IntegrationRow>): ResolvedSettings['ai'] {
  if (config.ai.provider) {
    const pinned = aiCandidate(map, config.ai.provider);
    if (pinned) return pinned;
  }
  // An admin who ticks a provider on in the UI outranks the default order.
  for (const provider of AI_PROVIDER_ORDER) {
    if (map.get(aiRowKey(provider))?.isActive) {
      const chosen = aiCandidate(map, provider);
      if (chosen) return chosen;
    }
  }
  for (const provider of AI_PROVIDER_ORDER) {
    const chosen = aiCandidate(map, provider);
    if (chosen) return chosen;
  }

  return {
    enabled: config.ai.enabled,
    provider: 'none',
    apiKey: '',
    baseUrl: '',
    model: config.ai.model,
    fastModel: config.ai.fastModel,
    maxTokens: config.ai.maxTokens,
  };
}

/** The `ipy_integration.provider` value backing each AI provider. */
export function aiRowKey(provider: Exclude<AiProvider, 'none'>): string {
  return provider === 'anthropic' ? 'anthropic' : `ai_${provider}`;
}

function resolve(map: Map<string, IntegrationRow>): ResolvedSettings {
  const wa = map.get('meta_whatsapp');
  const twilio = map.get('twilio');
  const exotel = map.get('exotel');
  const smtp = map.get('smtp');
  const imap = map.get('imap');
  const sttRow = map.get('stt');
  const fb = map.get('facebook_leads');
  const google = map.get('google_ads');
  const webform = map.get('webform');
  const s3 = map.get('s3');
  const onedrive = map.get('onedrive');
  const n8n = map.get('n8n');

  let telephonyProvider: 'none' | 'twilio' | 'exotel' = config.telephony.provider === 'twilio' || config.telephony.provider === 'exotel'
    ? config.telephony.provider : 'none';
  if (twilio?.isActive && twilio.credentials.accountSid && twilio.credentials.authToken) telephonyProvider = 'twilio';
  else if (exotel?.isActive && exotel.credentials.sid && exotel.credentials.apiKey && exotel.credentials.apiToken) telephonyProvider = 'exotel';

  const oneDriveConfigured = Boolean(
    pick(onedrive, 'config', 'tenantId', config.storage.onedrive.tenantId)
    && pick(onedrive, 'config', 'clientId', config.storage.onedrive.clientId)
    && pick(onedrive, 'credentials', 'clientSecret', config.storage.onedrive.clientSecret)
    && (
      pick(onedrive, 'config', 'driveId', config.storage.onedrive.driveId)
      || pick(onedrive, 'config', 'driveUser', config.storage.onedrive.driveUser)
    ),
  );
  const requestedStorageDriver = config.storage.driver;

  // Two different jobs, and they stopped being the same question the moment the
  // team started working in OneDrive by hand.
  //
  //  * `driver` is what the CRM and the public website *serve* from. That wants
  //    R2: no charge for traffic, and it can sit on your own domain. Serving a
  //    listing's photos out of OneDrive means an authenticated Microsoft API
  //    call per image, with rate limits, and it falls over the first time a
  //    property gets shared around.
  //  * `foldersInOneDrive` is where the *people* work: the folder somebody
  //    opens to drop originals in, and the details file that tells them which
  //    property it is. R2 cannot do that at all — its folders are not real,
  //    they are prefixes that appear once a file exists, so there is nothing to
  //    open and nothing to drop into.
  //
  // Turning the OneDrive card on used to force the serving driver with it,
  // which meant you could have browsable folders or a fast website, never both.
  const foldersInOneDrive = Boolean(onedrive?.isActive && oneDriveConfigured);
  const storageDriver: ResolvedSettings['storage']['driver'] =
    pick(s3, 'config', 'driver', requestedStorageDriver) === 's3'
      ? 's3'
      : requestedStorageDriver === 'onedrive' && oneDriveConfigured
        ? 'onedrive'
        : 'local';

  return {
    whatsapp: {
      phoneNumberId: pick(wa, 'credentials', 'phoneNumberId', config.whatsapp.phoneNumberId),
      businessAccountId: pick(wa, 'credentials', 'businessAccountId', config.whatsapp.businessAccountId),
      accessToken: pick(wa, 'credentials', 'accessToken', config.whatsapp.accessToken),
      verifyToken: pick(wa, 'config', 'verifyToken', config.whatsapp.verifyToken) || config.whatsapp.verifyToken,
      appSecret: pick(wa, 'credentials', 'appSecret', config.whatsapp.appSecret),
      apiVersion: pick(wa, 'config', 'apiVersion', config.whatsapp.apiVersion) || config.whatsapp.apiVersion,
      active: Boolean(wa?.isActive),
    },
    telephony: {
      provider: telephonyProvider,
      twilio: {
        accountSid: pick(twilio, 'credentials', 'accountSid', config.telephony.twilio.accountSid),
        authToken: pick(twilio, 'credentials', 'authToken', config.telephony.twilio.authToken),
        callerId: pick(twilio, 'config', 'callerId', config.telephony.twilio.callerId),
        appSid: pick(twilio, 'config', 'appSid', config.telephony.twilio.appSid),
      },
      exotel: {
        sid: pick(exotel, 'credentials', 'sid', config.telephony.exotel.sid),
        apiKey: pick(exotel, 'credentials', 'apiKey', config.telephony.exotel.apiKey),
        apiToken: pick(exotel, 'credentials', 'apiToken', config.telephony.exotel.apiToken),
        subdomain: pick(exotel, 'config', 'subdomain', config.telephony.exotel.subdomain) || config.telephony.exotel.subdomain,
        callerId: pick(exotel, 'config', 'callerId', config.telephony.exotel.callerId),
        webhookSecret: pick(exotel, 'credentials', 'webhookSecret', config.telephony.exotel.webhookSecret),
      },
    },
    email: {
      host: pick(smtp, 'config', 'host', config.email.host),
      port: Number(pick(smtp, 'config', 'port', String(config.email.port))) || config.email.port,
      secure: (pick(smtp, 'config', 'secure', String(config.email.secure)) || 'false') === 'true',
      user: pick(smtp, 'credentials', 'user', config.email.user),
      password: pick(smtp, 'credentials', 'password', config.email.password),
      from: pick(smtp, 'config', 'from', config.email.from) || config.email.from,
      imap: {
        host: pick(imap, 'config', 'host', config.email.imap.host),
        port: Number(pick(imap, 'config', 'port', String(config.email.imap.port))) || config.email.imap.port,
        user: pick(imap, 'credentials', 'user', config.email.imap.user),
        password: pick(imap, 'credentials', 'password', config.email.imap.password),
      },
    },
    ai: resolveAi(map),
    stt: resolveStt(map, sttRow),
    sentry: {
      dsn: pick(map.get('sentry'), 'config', 'dsn', config.sentry.dsn),
      environment: pick(map.get('sentry'), 'config', 'environment', config.sentry.environment),
    },
    automation: {
      n8nWebhookUrl: pick(n8n, 'config', 'webhookUrl', config.automation.n8nWebhookUrl),
      // In credentials, not config: it is the only thing standing between the
      // open webhooks router and anything that can raise a notification.
      n8nCallbackSecret: pick(n8n, 'credentials', 'callbackSecret', config.automation.n8nCallbackSecret),
    },
    leadSources: {
      facebook: {
        appId: pick(fb, 'config', 'appId', config.leadSources.facebook.appId),
        appSecret: pick(fb, 'credentials', 'appSecret', config.leadSources.facebook.appSecret),
        pageAccessToken: pick(fb, 'credentials', 'pageAccessToken', config.leadSources.facebook.pageAccessToken),
        verifyToken: pick(fb, 'config', 'verifyToken', config.leadSources.facebook.verifyToken) || config.leadSources.facebook.verifyToken,
      },
      googleAdsWebhookKey: pick(google, 'credentials', 'webhookKey', config.leadSources.googleAdsWebhookKey),
      portalWebhookKey: pick(map.get('webform'), 'credentials', 'portalWebhookKey', config.leadSources.portalWebhookKey),
      webformPublicKey: pick(webform, 'config', 'key', config.leadSources.webformPublicKey) || config.leadSources.webformPublicKey,
    },
    storage: {
      driver: storageDriver,
      foldersInOneDrive,
      bucket: pick(s3, 'config', 'bucket', config.storage.s3.bucket),
      region: pick(s3, 'config', 'region', config.storage.s3.region) || config.storage.s3.region,
      accessKeyId: pick(s3, 'credentials', 'accessKeyId', config.storage.s3.accessKeyId),
      secretAccessKey: pick(s3, 'credentials', 'secretAccessKey', config.storage.s3.secretAccessKey),
      endpoint: pick(s3, 'config', 'endpoint', config.storage.s3.endpoint),
      onedrive: {
        tenantId: pick(onedrive, 'config', 'tenantId', config.storage.onedrive.tenantId),
        clientId: pick(onedrive, 'config', 'clientId', config.storage.onedrive.clientId),
        clientSecret: pick(onedrive, 'credentials', 'clientSecret', config.storage.onedrive.clientSecret),
        driveId: pick(onedrive, 'config', 'driveId', config.storage.onedrive.driveId),
        driveUser: pick(onedrive, 'config', 'driveUser', config.storage.onedrive.driveUser),
        rootFolder: pick(onedrive, 'config', 'rootFolder', config.storage.onedrive.rootFolder) || 'iPropy Properties',
      },
    },
  };
}

snapshot = resolve(rows);

/** Synchronous — safe to call from anywhere, always returns at least the env-derived defaults. */
export function getSettings(): ResolvedSettings {
  return snapshot;
}

export async function warmup(): Promise<void> {
  rows = await load();
  snapshot = resolve(rows);

  /*
    Whether a switched-off provider may still be used as a last resort. Read
    here rather than per call, because the fallback chain is rebuilt on nearly
    every AI request and must not become a query.
  */
  const row = await db.queryOne<{ value: unknown }>(
    `SELECT value FROM ipy_setting WHERE key = 'ai.use_disabled_providers'`,
  ).catch(() => null);
  // Absent means on, which is the behaviour that existed before it was a choice.
  allowDisabledProviders = row ? row.value !== false : true;

  /*
    Error reporting follows the stored DSN, so pasting one on the integrations
    page turns it on without a redeploy. The environment variable still wins:
    it is read before the database and catches boot failures this cannot.
  */
  const { configureSentry } = await import('../observability/sentry.js');
  configureSentry(
    config.sentry.dsn || snapshot.sentry.dsn,
    config.sentry.environment || snapshot.sentry.environment,
  );

  logger.debug(
    { providers: rows.size, allowDisabledProviders },
    'integration settings loaded',
  );
}

/** Reload immediately (not lazily) — callers need the new value before their response returns. */
export async function invalidate(): Promise<void> {
  await warmup();
}

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------

const SECRET_FIELDS: Record<string, string[]> = {
  meta_whatsapp: ['accessToken', 'appSecret'],
  twilio: ['authToken'],
  exotel: ['apiKey', 'apiToken'],
  smtp: ['password'],
  imap: ['password'],
  anthropic: ['apiKey'],
  ai_gemini: ['apiKey'],
  ai_groq: ['apiKey'],
  ai_openrouter: ['apiKey'],
  ai_opencode: ['apiKey'],
  ai_openai: ['apiKey'],
  ai_ollama: [],
  stt: ['apiKey'],
  facebook_leads: ['appSecret', 'pageAccessToken'],
  google_ads: ['webhookKey'],
  s3: ['accessKeyId', 'secretAccessKey'],
  onedrive: ['clientSecret'],
};

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

export interface IntegrationSummary {
  provider: string; kind: string; label: string; isActive: boolean;
  status: string; lastSyncAt: string | null; lastError: string | null;
  config: Record<string, string>;
  /** field name -> masked preview; full secret values never leave the server */
  credentialFields: Record<string, { set: boolean; preview: string }>;
}

function summarize(row: IntegrationRow): IntegrationSummary {
  const secretKeys = SECRET_FIELDS[row.provider] ?? Object.keys(row.credentials);
  const credentialFields: Record<string, { set: boolean; preview: string }> = {};
  for (const key of new Set([...secretKeys, ...Object.keys(row.credentials)])) {
    const v = row.credentials[key] ?? '';
    credentialFields[key] = { set: Boolean(v), preview: mask(v) };
  }
  return {
    provider: row.provider, kind: row.kind, label: row.label, isActive: row.isActive,
    status: row.status, lastSyncAt: row.lastSyncAt, lastError: row.lastError,
    config: row.config, credentialFields,
  };
}

export async function listIntegrations(): Promise<IntegrationSummary[]> {
  if (!rows.size) await warmup();
  return [...rows.values()].map(summarize).sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

export async function getIntegrationSummary(provider: string): Promise<IntegrationSummary | null> {
  if (!rows.size) await warmup();
  const row = rows.get(provider);
  return row ? summarize(row) : null;
}

/**
 * Merge-save: only the fields present in `credentials` are updated, so an
 * admin can rotate a single secret without re-entering everything else (and
 * the client never has to receive the existing plaintext to round-trip it).
 * Saving with any non-empty credential implicitly activates the provider
 * unless `isActive` is explicitly passed — configuring something in the UI is
 * the signal that it should be used.
 */
export async function saveIntegration(
  provider: string,
  input: { config?: Record<string, string>; credentials?: Record<string, string>; isActive?: boolean },
): Promise<void> {
  const existing = await db.queryOne<{ id: string; kind: string; label: string; config: Record<string, string>; credentials: Record<string, string> }>(
    `SELECT id, kind, label, config, credentials FROM ipy_integration WHERE provider = $1`,
    [provider],
  );
  if (!existing) throw new Error(`Unknown integration provider '${provider}'`);

  const mergedConfig = { ...(existing.config ?? {}), ...(input.config ?? {}) };

  const existingCreds: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing.credentials ?? {})) existingCreds[k] = decrypt(v);
  const mergedCredsPlain: Record<string, string> = { ...existingCreds };
  for (const [k, v] of Object.entries(input.credentials ?? {})) {
    if (v !== undefined && v !== null) mergedCredsPlain[k] = v;
  }
  const mergedCredsEncrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(mergedCredsPlain)) if (v) mergedCredsEncrypted[k] = encrypt(v);

  const hasAnyCredential = Object.values(mergedCredsPlain).some((v) => v);
  const isActive = input.isActive ?? (hasAnyCredential ? true : existing ? undefined : false);

  await db.query(
    `UPDATE ipy_integration
     SET config = $2, credentials = $3, is_active = COALESCE($4, is_active), updated_at = now()
     WHERE id = $1`,
    [existing.id, JSON.stringify(mergedConfig), JSON.stringify(mergedCredsEncrypted), isActive ?? null],
  );

  // A corrected storage credential should replay folders that exhausted their
  // earlier retries; the user must not need a database repair after fixing a key.
  if (provider === 'onedrive' || provider === 's3') {
    await db.query(
      `UPDATE ipy_property_storage
          SET status = 'pending', attempts = 0, last_error = NULL, locked_at = NULL, updated_at = now()
        WHERE status = 'failed' OR provisioned_driver IS DISTINCT FROM $1`,
      [provider === 'onedrive' ? 'onedrive' : 's3'],
    );
  }

  await invalidate();
}

export async function setIntegrationActive(provider: string, isActive: boolean): Promise<void> {
  await db.query(`UPDATE ipy_integration SET is_active = $2, updated_at = now() WHERE provider = $1`, [provider, isActive]);
  await invalidate();
}

export async function recordIntegrationResult(provider: string, ok: boolean, message?: string): Promise<void> {
  await db.query(
    `UPDATE ipy_integration
     SET status = $2, last_sync_at = CASE WHEN $2 = 'connected' THEN now() ELSE last_sync_at END,
         last_error = $3, updated_at = now()
     WHERE provider = $1`,
    [provider, ok ? 'connected' : 'error', ok ? null : (message ?? 'Unknown error')],
  );
  await invalidate();
}
