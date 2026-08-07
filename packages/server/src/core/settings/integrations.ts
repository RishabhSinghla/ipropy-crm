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
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

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
  telephony: {
    provider: 'none' | 'twilio' | 'exotel';
    twilio: { accountSid: string; authToken: string; callerId: string; appSid: string };
    exotel: { sid: string; apiKey: string; apiToken: string; subdomain: string; callerId: string };
  };
  email: {
    host: string; port: number; secure: boolean; user: string; password: string; from: string;
    imap: { host: string; port: number; user: string; password: string };
  };
  ai: {
    enabled: boolean; apiKey: string; model: string; fastModel: string; maxTokens: number;
  };
  stt: {
    provider: 'none' | 'openai'; apiKey: string; baseUrl: string; model: string;
  };
  leadSources: {
    facebook: { appId: string; appSecret: string; pageAccessToken: string; verifyToken: string };
    googleAdsWebhookKey: string;
    webformPublicKey: string;
  };
  storage: {
    driver: 'local' | 's3';
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
  };
}

// ---------------------------------------------------------------------------
// Encryption — AES-256-GCM, key derived from JWT_SECRET so no new required env var
// ---------------------------------------------------------------------------

const ENC_PREFIX = 'enc:v1:';

function deriveKey(): Buffer {
  return crypto.scryptSync(config.auth.jwtSecret, 'ipropy-integration-credentials', 32);
}

function encrypt(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(value: string | undefined | null): string {
  if (!value) return '';
  if (!value.startsWith(ENC_PREFIX)) return value; // pre-encryption rows; re-encrypted on next save
  try {
    const raw = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (err) {
    logger.error({ err }, 'failed to decrypt integration credential');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Load + resolve
// ---------------------------------------------------------------------------

let rows = new Map<string, IntegrationRow>();
let snapshot: ResolvedSettings = resolve(rows);

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

function resolve(map: Map<string, IntegrationRow>): ResolvedSettings {
  const wa = map.get('meta_whatsapp');
  const twilio = map.get('twilio');
  const exotel = map.get('exotel');
  const smtp = map.get('smtp');
  const imap = map.get('imap');
  const anthropic = map.get('anthropic');
  const sttRow = map.get('stt');
  const fb = map.get('facebook_leads');
  const google = map.get('google_ads');
  const webform = map.get('webform');
  const s3 = map.get('s3');

  let telephonyProvider: 'none' | 'twilio' | 'exotel' = config.telephony.provider === 'twilio' || config.telephony.provider === 'exotel'
    ? config.telephony.provider : 'none';
  if (twilio?.isActive && twilio.credentials.accountSid && twilio.credentials.authToken) telephonyProvider = 'twilio';
  else if (exotel?.isActive && exotel.credentials.sid && exotel.credentials.apiKey && exotel.credentials.apiToken) telephonyProvider = 'exotel';

  const storageDriver = pick(s3, 'config', 'driver', config.storage.driver) === 's3' ? 's3' : 'local';

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
    ai: {
      enabled: config.ai.enabled,
      apiKey: pick(anthropic, 'credentials', 'apiKey', config.ai.apiKey),
      model: pick(anthropic, 'config', 'model', config.ai.model) || config.ai.model,
      fastModel: pick(anthropic, 'config', 'fastModel', config.ai.fastModel) || config.ai.fastModel,
      maxTokens: Number(pick(anthropic, 'config', 'maxTokens', String(config.ai.maxTokens))) || config.ai.maxTokens,
    },
    stt: {
      provider: pick(sttRow, 'config', 'provider', config.stt.provider) === 'openai' ? 'openai' : 'none',
      apiKey: pick(sttRow, 'credentials', 'apiKey', config.stt.apiKey),
      baseUrl: pick(sttRow, 'config', 'baseUrl', config.stt.baseUrl) || config.stt.baseUrl,
      model: pick(sttRow, 'config', 'model', config.stt.model) || config.stt.model,
    },
    leadSources: {
      facebook: {
        appId: pick(fb, 'config', 'appId', config.leadSources.facebook.appId),
        appSecret: pick(fb, 'credentials', 'appSecret', config.leadSources.facebook.appSecret),
        pageAccessToken: pick(fb, 'credentials', 'pageAccessToken', config.leadSources.facebook.pageAccessToken),
        verifyToken: pick(fb, 'config', 'verifyToken', config.leadSources.facebook.verifyToken) || config.leadSources.facebook.verifyToken,
      },
      googleAdsWebhookKey: pick(google, 'credentials', 'webhookKey', config.leadSources.googleAdsWebhookKey),
      webformPublicKey: pick(webform, 'config', 'key', config.leadSources.webformPublicKey) || config.leadSources.webformPublicKey,
    },
    storage: {
      driver: storageDriver,
      bucket: pick(s3, 'config', 'bucket', config.storage.s3.bucket),
      region: pick(s3, 'config', 'region', config.storage.s3.region) || config.storage.s3.region,
      accessKeyId: pick(s3, 'credentials', 'accessKeyId', config.storage.s3.accessKeyId),
      secretAccessKey: pick(s3, 'credentials', 'secretAccessKey', config.storage.s3.secretAccessKey),
      endpoint: pick(s3, 'config', 'endpoint', config.storage.s3.endpoint),
    },
  };
}

/** Synchronous — safe to call from anywhere, always returns at least the env-derived defaults. */
export function getSettings(): ResolvedSettings {
  return snapshot;
}

export async function warmup(): Promise<void> {
  rows = await load();
  snapshot = resolve(rows);
  logger.debug({ providers: rows.size }, 'integration settings loaded');
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
  stt: ['apiKey'],
  facebook_leads: ['appSecret', 'pageAccessToken'],
  google_ads: ['webhookKey'],
  s3: ['accessKeyId', 'secretAccessKey'],
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
