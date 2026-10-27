/**
 * OpenWA, the self-hosted WhatsApp gateway, as one more business provider.
 *
 * OpenWA is a **separate application**. It is linked to the company's own
 * WhatsApp number the way WhatsApp Web is — one of the (up to four) linked
 * devices beside the owner's phone — and the CRM talks to it only over HTTP
 * (to send, to ask how the session is) and over signed webhooks (to hear what
 * arrived). Nothing of OpenWA's code or database is shared with the CRM.
 *
 * What makes it different from the other four adapters, and why it has its own
 * guard-rails (`openwaGuards.ts`):
 *
 *  * It is an **ordinary chat**, not the official Business API. There is no
 *    24-hour window and no template system, so the capability set says
 *    `linkedDevice` and says nothing about `templates` or `campaigns` — which
 *    is what makes every bulk path in the CRM refuse to use it.
 *  * Because WhatsApp does not officially bless linked-device gateways, a
 *    pattern that looks like bulk sending can get the number banned. The CRM
 *    therefore only ever sends one message to one person a human chose.
 *  * It can see messages the business sent from the phone or another device.
 *    The official providers cannot, so a record read as "customer talking to
 *    nobody" before; here both sides of the chat arrive.
 *
 * The API key never leaves the server: it is read from the encrypted
 * integration card (or `OPENWA_API_KEY`) and is not part of any response.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getIntegrationConfig, getIntegrationCredentials } from '../../../core/settings/integrations.js';
import { logger } from '../../../utils/logger.js';
import {
  NotSupportedError, type MessageDeliveryState, type SendOutcome, type WhatsAppCapability,
  type WhatsAppConnectionStatus,
} from '../providers/types.js';
import type {
  GroupMessage, InboundMessage, MediaBytes, MediaRef, SendMediaByIdRequest, WebhookBatch,
  WebhookRequest, WebhookVerification, WhatsAppBusinessProvider,
} from './types.js';

export const OPENWA_PROVIDER = 'whatsapp_openwa';

const CAPABILITIES: ReadonlySet<WhatsAppCapability> = new Set<WhatsAppCapability>([
  'text', 'media', 'messageStatus', 'linkedDevice',
]);

// ---------------------------------------------------------------------------
// Pure helpers — exported because each one is something a test should pin
// ---------------------------------------------------------------------------

/**
 * A phone number as WhatsApp wants it: digits, country code first.
 *
 * Returns null rather than guessing when it cannot tell. Ten bare digits take
 * `defaultCountryCode` — the organisation's own visible setting, never a
 * hidden assumption — and anything shorter is refused.
 */
export function toWaDigits(raw: string | null | undefined, defaultCountryCode = '91'): string | null {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // 0 9891 222206 — a trunk zero in front of a national number.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) {
    const cc = defaultCountryCode.replace(/\D/g, '');
    if (!cc) return null;
    digits = cc + digits;
  }
  // E.164 allows at most 15 digits; fewer than 11 here means no country code.
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

/** `+919891222206` — the E.164 spelling of the same number. */
export function toE164(raw: string | null | undefined, defaultCountryCode = '91'): string | null {
  const digits = toWaDigits(raw, defaultCountryCode);
  return digits ? `+${digits}` : null;
}

/** OpenWA's chat id for a one-to-one chat. */
export function chatIdFor(digits: string): string {
  return `${digits}@c.us`;
}

/**
 * The phone number inside a WhatsApp id, or null when the id is not a person's
 * phone: a group, a broadcast list, a channel, or a privacy id (`…@lid`) that
 * names nobody until OpenWA resolves it.
 */
export function phoneFromJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null;
  const [user, server] = jid.split('@');
  if (server !== 'c.us' && server !== 's.whatsapp.net') return null;
  const digits = (user ?? '').split(':')[0]?.replace(/\D/g, '') ?? '';
  return digits.length >= 8 ? digits : null;
}

/**
 * OpenWA names a message two ways: the long serialised id the send call
 * returns (`true_91…@c.us_3EB0ABCD`) and the short one in webhooks
 * (`3EB0ABCD`). Storing one and looking up the other is how a message the CRM
 * sent comes back as "sent from another device", so every id is cut down to
 * the short part before it is stored or compared.
 */
export function normaliseMessageId(id: unknown): string {
  const text = String(id ?? '').trim();
  // `true_<chat>@<server>_<id>` and, in groups, a trailing `_<participant>`.
  const long = /^(?:true|false)_[^_]*@[^_]*_([^_]+)/.exec(text);
  return long?.[1] ?? text;
}

/**
 * Is this delivery really from our OpenWA?
 *
 * The signature is an HMAC-SHA256 over the **raw** body — re-serialising the
 * parsed JSON changes the bytes and reads exactly like a wrong secret — sent
 * as `sha256=<hex>`. Compared in constant time, with the length checked first
 * because `timingSafeEqual` throws on a mismatch instead of answering false.
 */
export function verifyOpenWaSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const given = Buffer.from(match[1]!, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Replay protection. OpenWA signs the body but not a separate timestamp
 * header, so the freshness check reads the `timestamp` field *inside* the
 * signed body (dispatch time). A captured delivery therefore dies after the
 * window; inside it, message ids are de-duplicated by the unique insert.
 */
export function deliveryFreshness(
  rawBody: string, maxAgeMs: number, nowMs = Date.now(),
): { ok: true } | { ok: false; reason: 'unreadable' | 'no-timestamp' | 'stale' | 'from-the-future' } {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return { ok: false, reason: 'unreadable' }; }
  const stamp = (parsed as { timestamp?: unknown } | null)?.timestamp;
  const at = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
  if (Number.isNaN(at)) return { ok: false, reason: 'no-timestamp' };
  if (nowMs - at > maxAgeMs) return { ok: false, reason: 'stale' };
  // A few minutes of clock difference between two machines is normal.
  if (at - nowMs > 5 * 60_000) return { ok: false, reason: 'from-the-future' };
  return { ok: true };
}

function messageType(raw: unknown): InboundMessage['type'] {
  switch (String(raw ?? '').toLowerCase()) {
    case 'chat': case 'text': case 'extendedtext': case 'conversation': return 'text';
    case 'image': case 'sticker': return 'image';
    case 'video': case 'gif': return 'video';
    case 'audio': case 'ptt': case 'voice': return 'audio';
    case 'document': return 'document';
    case 'location': case 'live_location': return 'location';
    default: return 'other';
  }
}

function asDate(epochSeconds: unknown): Date {
  const n = Number(epochSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/**
 * A written message in a group, in the dealer feed's words. Photos, voice notes and the like carry no words to
 * read, so they are dropped here. `message.sent` (the company's own number writing in the group) is kept: the
 * feed wants what the group said, whoever said it.
 */
export function groupMessageFrom(data: Record<string, unknown>, chatId: string): GroupMessage | null {
  const groupId = chatId || String(data.from ?? '');
  const text = typeof data.body === 'string' ? data.body.trim() : '';
  const id = normaliseMessageId(data.id);
  if (!/@g\.us$/.test(groupId) || !text || !id || data.media) return null;
  const contact = (data.contact ?? {}) as { name?: unknown; pushName?: unknown };
  const named = [contact.name, contact.pushName].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const number = phoneFromJid(typeof data.author === 'string' ? data.author : data.senderPhone) ?? null;
  const chat = (data.chat ?? {}) as { name?: unknown };
  const groupName = [data.groupName, data.chatName, chat.name].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  return {
    providerMessageId: id,
    groupId,
    groupName: groupName?.trim() ?? null,
    sender: (named ?? number ?? 'Unknown').trim(),
    text,
    sentAt: asDate(data.timestamp),
  };
}

/**
 * One OpenWA delivery, in the CRM's own words.
 *
 * Groups, channels, status posts and broadcast lists are skipped on purpose:
 * this connection is for ordinary one-to-one chats with customers, and a
 * group full of strangers has no business in a CRM's contact list.
 * Media is kept as **metadata only** — type, name, size — never the inline
 * base64, so the database does not fill up with every photo anybody sends.
 */
export function parseOpenWaWebhook(body: unknown): WebhookBatch {
  const batch: WebhookBatch = { messages: [], statuses: [], sentElsewhere: [], unresolvedSenders: 0 };
  if (!body || typeof body !== 'object') return batch;
  const root = body as { event?: unknown; data?: unknown };
  const event = String(root.event ?? '');
  const data = (root.data ?? {}) as Record<string, unknown>;

  if (event.startsWith('session.')) {
    const status = event === 'session.status' ? String(data.status ?? '')
      : event === 'session.disconnected' ? 'disconnected'
        : event === 'session.qr' ? 'qr_ready' : '';
    if (status) batch.session = { status };
    return batch;
  }

  if (event === 'message.ack' || event === 'message.failed') {
    const id = normaliseMessageId(data.messageId ?? data.id);
    const raw = event === 'message.failed' ? 'failed' : String(data.status ?? '').toLowerCase();
    if (id && (raw === 'sent' || raw === 'delivered' || raw === 'read' || raw === 'failed')) {
      batch.statuses.push({
        providerMessageId: id,
        state: raw,
        at: new Date(),
        error: raw === 'failed' ? 'OpenWA reported that WhatsApp could not deliver this message.' : null,
      });
    }
    return batch;
  }

  if (event !== 'message.received' && event !== 'message.sent') return batch;

  const kind = String(data.kind ?? 'individual');
  const chatId = String(data.chatId ?? '');
  if (data.isGroup || kind === 'group' || /@g\.us$/.test(chatId)) {
    const group = groupMessageFrom(data, chatId);
    if (group) batch.groupMessages = [group];
    return batch;
  }
  if (data.isGroup || (kind !== 'individual' && kind !== 'unknown')
    || /@(g\.us|broadcast|newsletter)$/.test(chatId) || chatId === 'status@broadcast') {
    return batch;
  }

  const fromMe = Boolean(data.fromMe) || event === 'message.sent';
  // The other person in the chat, whichever way the message went.
  const peerJid = chatId || String(fromMe ? data.to ?? '' : data.from ?? '');
  let phone = phoneFromJid(peerJid);
  // A privacy id carries no number; OpenWA adds one only when asked to
  // (RESOLVE_LID_TO_PHONE=true), and only for inbound senders.
  if (!phone && !fromMe && typeof data.senderPhone === 'string') {
    phone = data.senderPhone.replace(/\D/g, '') || null;
  }
  if (!phone) {
    batch.unresolvedSenders = 1;
    return batch;
  }

  const id = normaliseMessageId(data.id);
  if (!id) return batch;

  const mediaIn = data.media as Record<string, unknown> | undefined;
  const text = typeof data.body === 'string' && data.body.length ? data.body : null;
  const media = mediaIn
    ? {
      mimeType: typeof mediaIn.mimetype === 'string' ? mediaIn.mimetype : undefined,
      filename: typeof mediaIn.filename === 'string' ? mediaIn.filename : undefined,
      caption: text ?? undefined,
      sizeBytes: Number.isFinite(Number(mediaIn.sizeBytes)) ? Number(mediaIn.sizeBytes) : undefined,
    }
    : null;
  const contact = (data.contact ?? {}) as { name?: unknown; pushName?: unknown };
  const profileName = [contact.name, contact.pushName].find((v) => typeof v === 'string' && v.trim()) as string | undefined;

  if (fromMe) {
    batch.sentElsewhere!.push({
      providerMessageId: id, to: phone, text, media, sentAt: asDate(data.timestamp),
      profileName: profileName ?? null,
    });
  } else {
    batch.messages.push({
      providerMessageId: id,
      from: phone,
      to: null,
      type: messageType(data.type),
      text: media ? null : text,
      media,
      sentAt: asDate(data.timestamp),
      profileName: profileName ?? null,
    });
  }
  return batch;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface Conf {
  baseUrl: string;
  sessionName: string;
  apiKey: string;
}

/** What the admin typed on the card, with the API key from the encrypted store or the environment. */
function conf(): Conf | null {
  const config = getIntegrationConfig(OPENWA_PROVIDER);
  const creds = getIntegrationCredentials(OPENWA_PROVIDER);
  const baseUrl = (config?.baseUrl ?? '').trim().replace(/\/+$/, '');
  const sessionName = (config?.sessionName ?? '').trim();
  const apiKey = (creds?.apiKey || process.env.OPENWA_API_KEY || '').trim();
  if (!baseUrl || !sessionName || !apiKey) return null;
  if (!/^https?:\/\/[^/@\s]+(?::\d+)?(\/.*)?$/i.test(baseUrl)) return null;
  return { baseUrl, sessionName, apiKey };
}

export function openWaWebhookMaxAgeMs(): number {
  const minutes = Number(getIntegrationConfig(OPENWA_PROVIDER)?.webhookMaxAgeMinutes);
  const clamped = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 24 * 60) : 30;
  return clamped * 60_000;
}

const notSet = (): Error => new Error(
  'Add the OpenWA address, session name and API key in Admin → Integrations first.',
);

// ---------------------------------------------------------------------------
// Health, remembered in memory and written out by `openwaHealth.ts`
// ---------------------------------------------------------------------------

export const openWaStats = {
  lastWebhookAt: null as string | null,
  lastReachedAt: null as string | null,
  lastErrorAt: null as string | null,
  lastError: null as string | null,
  rejectedWebhooks: 0,
  unresolvedSenders: 0,
  sendsOk: 0,
  sendsFailed: 0,
  /** When OpenWA's own daily allowance says sending comes back, while it is paused for a long time. */
  pausedUntil: null as string | null,
};

function reached(): void {
  openWaStats.lastReachedAt = new Date().toISOString();
  if (openWaStats.pausedUntil && Date.parse(openWaStats.pausedUntil) <= Date.now()) openWaStats.pausedUntil = null;
}
function failed(message: string): void {
  openWaStats.lastErrorAt = new Date().toISOString();
  openWaStats.lastError = message;
}

// ---------------------------------------------------------------------------
// Talking to OpenWA
// ---------------------------------------------------------------------------

/** A refusal from OpenWA, already worded for a rep. */
export class OpenWaError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null) {
    super(message);
    this.name = 'OpenWaError';
  }
}

/** OpenWA's own answer turned into a sentence a rep can act on. */
export function explainOpenWaRefusal(status: number, body: Record<string, unknown>): string {
  const code = typeof body.code === 'string' ? body.code : null;
  const detail = typeof body.message === 'string' ? body.message : Array.isArray(body.message) ? body.message.join('; ') : '';
  if (status === 429 || code === 'SEND_PACING_LIMITED') {
    const wait = Number(body.retryAfterSeconds);
    if (Number.isFinite(wait) && wait > 600) {
      /*
        A long wait is the new-number daily allowance, not a hiccup. A count of
        seconds ("49,728") tells nobody anything; the time sending comes back does.
      */
      const back = new Date(Date.now() + wait * 1000).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short',
      });
      return `This WhatsApp number has reached today's sending allowance — a protection for newly linked numbers that grows every day. Chat sending resumes around ${back} (India time). Customers' messages still arrive.`;
    }
    return 'WhatsApp is being protected from sending too fast, so OpenWA paused this message'
      + (Number.isFinite(wait) && wait > 0 ? ` — try again in about ${Math.ceil(wait)} seconds.` : ' — try again shortly.');
  }
  if (status === 401 || status === 403) return 'OpenWA did not accept the CRM\'s API key. Check it in Admin → Integrations.';
  if (status === 404) return `OpenWA does not know that session. ${detail}`.trim();
  if (status === 413) return 'That file is too large for OpenWA to send.';
  if (status === 400 && /not (active|ready|connected)/i.test(detail)) {
    return 'The WhatsApp session in OpenWA is not connected right now. Open OpenWA and re-link the phone.';
  }
  return `OpenWA refused that (HTTP ${status})${detail ? `: ${detail}` : '.'}`;
}

async function api<T>(
  c: Conf, path: string, init: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-api-key': c.apiKey,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const message = `The CRM cannot reach OpenWA at ${c.baseUrl}. Is it running? (${(err as Error).name === 'TimeoutError' ? 'it did not answer in time' : 'connection refused'})`;
    failed(message);
    throw new OpenWaError(message, null, 'UNREACHABLE');
  }
  reached();
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const message = explainOpenWaRefusal(res.status, parsed);
    const longWait = Number(parsed.retryAfterSeconds);
    if (parsed.code === 'SEND_PACING_LIMITED' && Number.isFinite(longWait) && longWait > 600) {
      openWaStats.pausedUntil = new Date(Date.now() + longWait * 1000).toISOString();
    }
    // A rate limit is OpenWA doing its job, not the connection being unwell.
    if (res.status !== 429) failed(message);
    throw new OpenWaError(message, res.status, typeof parsed.code === 'string' ? parsed.code : null);
  }
  return parsed as T;
}

export interface OpenWaSession {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  restriction: { kind: string; code: string } | null;
  lastError: string | null;
}

function readSession(raw: Record<string, unknown>): OpenWaSession {
  const restriction = raw.restriction as { kind?: string; code?: string } | null | undefined;
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    status: String(raw.status ?? 'unknown'),
    phone: typeof raw.phone === 'string' && raw.phone ? raw.phone : null,
    pushName: typeof raw.pushName === 'string' ? raw.pushName : null,
    restriction: restriction?.kind ? { kind: restriction.kind, code: restriction.code ?? '' } : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
  };
}

let sessionCache: { key: string; at: number; session: OpenWaSession } | null = null;

/** The configured session, looked up by name. Cached briefly: it is asked on every send and screen. */
export async function openWaSession({ fresh = false } = {}): Promise<OpenWaSession> {
  const c = conf();
  if (!c) throw notSet();
  const key = `${c.baseUrl}|${c.sessionName}`;
  if (!fresh && sessionCache && sessionCache.key === key && Date.now() - sessionCache.at < 10_000) {
    return sessionCache.session;
  }
  const list = await api<Record<string, unknown>[]>(c, `/api/sessions?name=${encodeURIComponent(c.sessionName)}`);
  const row = Array.isArray(list) ? list[0] : undefined;
  if (!row) {
    throw new OpenWaError(`OpenWA has no session called "${c.sessionName}". Check the session name in Admin → Integrations.`, 404, 'NO_SESSION');
  }
  const session = readSession(row);
  sessionCache = { key, at: Date.now(), session };
  return session;
}

/** One call to the linked session, with the session's id filled in. Reads only — nothing here sends. */
async function onSession<T>(path: (sessionId: string) => string, timeoutMs = 20_000): Promise<T> {
  const c = conf();
  if (!c) throw notSet();
  const session = await openWaSession();
  return api<T>(c, path(session.id), { timeoutMs });
}

/** Every group the company number is in. */
export async function openWaGroups(): Promise<{ id: string; name: string }[]> {
  const rows = await onSession<{ id?: unknown; name?: unknown }[]>((sid) => `/api/sessions/${sid}/groups?limit=1000`, 30_000);
  return (Array.isArray(rows) ? rows : [])
    .filter((g) => typeof g.id === 'string' && /@g\.us$/.test(g.id))
    .map((g) => ({ id: String(g.id), name: typeof g.name === 'string' ? g.name.trim() : '' }));
}

export interface OpenWaHistoryLine { id: string; sender: string; text: string; sentAt: Date }

/**
 * The newest messages of one group, read live from WhatsApp, oldest first. `deep` reaches further back
 * (up to 2,000) and is slower and riskier for the number, so the history job asks for it once per group.
 */
export async function openWaGroupHistory(groupId: string, limit: number, deep = false, timeoutMs = 120_000): Promise<OpenWaHistoryLine[]> {
  const rows = await onSession<Record<string, unknown>[]>(
    (sid) => `/api/sessions/${sid}/messages/${encodeURIComponent(groupId)}/history?limit=${limit}${deep ? '&deep=true' : ''}`,
    timeoutMs,
  );
  const lines: OpenWaHistoryLine[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = typeof row.body === 'string' ? row.body.trim() : '';
    const id = normaliseMessageId(row.id);
    if (!text || !id || messageType(row.type) !== 'text') continue;
    const contact = (row.contact ?? {}) as { name?: unknown; pushName?: unknown };
    const named = [contact.name, contact.pushName].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    const number = phoneFromJid(typeof row.author === 'string' ? row.author : row.from);
    lines.push({ id, sender: (named ?? number ?? 'Unknown').trim(), text, sentAt: asDate(row.timestamp) });
  }
  return lines;
}

/** Is this number on WhatsApp? One outbound query about a third party: call it slowly (see `numberCheck.ts`). */
export async function openWaCheckNumber(digits: string): Promise<{ exists: boolean; waId: string | null }> {
  const row = await onSession<{ exists?: unknown; whatsappId?: unknown }>(
    (sid) => `/api/sessions/${sid}/contacts/check/${encodeURIComponent(digits)}`,
  );
  return { exists: row.exists === true, waId: typeof row.whatsappId === 'string' ? row.whatsappId : null };
}

/**
 * The name this person set for themselves on WhatsApp. Deliberately **not** `name`, which is what the company's
 * own address book calls them: that is the CRM's own data coming back, not a fact about the person.
 */
export async function openWaPushName(waId: string): Promise<string | null> {
  try {
    const row = await onSession<{ pushName?: unknown }>((sid) => `/api/sessions/${sid}/contacts/${encodeURIComponent(waId)}`);
    return typeof row.pushName === 'string' && row.pushName.trim() ? row.pushName.trim().slice(0, 120) : null;
  } catch (err) {
    if (err instanceof OpenWaError && err.status === 404) return null;
    throw err;
  }
}

/** The address of the person's profile picture, or null when they have none or hide it. */
export async function openWaProfilePictureUrl(waId: string): Promise<string | null> {
  const row = await onSession<{ url?: unknown }>((sid) => `/api/sessions/${sid}/contacts/${encodeURIComponent(waId)}/profile-picture`);
  return typeof row.url === 'string' && row.url ? row.url : null;
}

/** `+91 ••••• ••123` — enough to recognise the number, not enough to copy it. */
export function maskPhone(digits: string | null): string | null {
  if (!digits) return null;
  const d = digits.replace(/\D/g, '');
  if (d.length < 7) return '••••';
  return `+${d.slice(0, d.length - 10 > 0 ? d.length - 10 : 2)} ••••• •${d.slice(-3)}`;
}

/** Plain-language form of OpenWA's status words. */
export function describeSessionStatus(status: string): string {
  switch (status) {
    case 'ready': return 'ready — the phone is linked and OpenWA can send and receive';
    case 'qr_ready': return 'waiting for the QR code to be scanned (open OpenWA and scan it from WhatsApp → Linked devices)';
    case 'disconnected': return 'disconnected — the phone was unlinked or OpenWA lost the connection';
    case 'initializing': case 'authenticating': return 'starting up';
    case 'action_required': return 'needs attention in OpenWA';
    case 'failed': return 'failed to start';
    default: return status;
  }
}

function connectionStatus(status: string): WhatsAppConnectionStatus {
  switch (status) {
    case 'ready': return 'connected';
    case 'qr_ready': return 'qr';
    case 'initializing': case 'authenticating': return 'connecting';
    case 'disconnected': case 'created': return 'disconnected';
    default: return 'error';
  }
}

// Files are handed over before the send, then collected by id, to fit the
// shared "upload then send by id" contract without ever writing them to disk.
const pendingUploads = new Map<string, { data: Buffer; mimeType: string; filename: string | null; at: number }>();
function dropOldUploads(): void {
  for (const [id, up] of pendingUploads) if (Date.now() - up.at > 5 * 60_000) pendingUploads.delete(id);
}

const ROUTE_FOR: Record<string, string> = {
  image: 'send-image', video: 'send-video', audio: 'send-audio', document: 'send-document',
};

/**
 * The bytes of one received file, fetched **when a person asks to see it** —
 * never at arrival. OpenWA stores the media; the CRM stores nothing until
 * somebody presses Load, and then only streams it through.
 */
export async function fetchOpenWaMedia(
  chatDigits: string, messageId: string, maxBytes = 16 * 1024 * 1024,
): Promise<{ data: Buffer; mimeType: string }> {
  const c = conf();
  if (!c) throw notSet();
  const session = await openWaSession();
  let res: Response;
  try {
    res = await fetch(
      `${c.baseUrl}/api/sessions/${encodeURIComponent(session.id)}/messages/${encodeURIComponent(chatIdFor(chatDigits))}/${encodeURIComponent(messageId)}/media`,
      { headers: { 'x-api-key': c.apiKey }, signal: AbortSignal.timeout(30_000) },
    );
  } catch {
    throw new OpenWaError(`The CRM cannot reach OpenWA at ${c.baseUrl}. Is it running?`, null, 'UNREACHABLE');
  }
  if (res.status === 404) {
    throw new OpenWaError('OpenWA no longer has that file (it may be too large or was deleted).', 404, 'NO_MEDIA');
  }
  if (!res.ok) throw new OpenWaError(explainOpenWaRefusal(res.status, {}), res.status, null);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw new OpenWaError('That file is too large to preview here.', 413, 'TOO_LARGE');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > maxBytes) throw new OpenWaError('That file is too large to preview here.', 413, 'TOO_LARGE');
  return { data, mimeType: res.headers.get('content-type') ?? 'application/octet-stream' };
}

export const openWaProvider: WhatsAppBusinessProvider = {
  name: OPENWA_PROVIDER,
  kind: 'business',
  capabilities: CAPABILITIES,

  async isConfigured() { return conf() !== null; },
  async businessNumber() {
    try { return (await openWaSession()).phone; } catch { return null; }
  },

  async listAccounts() {
    try {
      const s = await openWaSession();
      return [{
        id: s.id, label: s.name, phoneNumber: s.phone, displayName: s.pushName,
        status: connectionStatus(s.status), userId: null, lastConnectedAt: null, lastError: s.lastError,
      }];
    } catch { return []; }
  },
  async getConnectionStatus() {
    try { return connectionStatus((await openWaSession()).status); } catch { return 'error'; }
  },
  async connectAccount() { throw new NotSupportedError(OPENWA_PROVIDER, 'perAgentAccounts'); },
  async disconnectAccount() { throw new NotSupportedError(OPENWA_PROVIDER, 'perAgentAccounts'); },

  /** Refuse early, with a reason, when the phone is not linked. */
  async preflight() {
    const s = await openWaSession({ fresh: true });
    if (s.status !== 'ready') {
      throw new OpenWaError(
        `WhatsApp is not connected in OpenWA right now (${describeSessionStatus(s.status)}). Nothing was sent.`,
        null, 'SESSION_NOT_READY',
      );
    }
    if (s.restriction?.kind === 'reachout_timelock') {
      // Existing chats still work; this is only worth a log line.
      logger.info({ restriction: s.restriction }, 'WhatsApp has limited new conversations on this number');
    }
  },

  async sendMessage(request): Promise<SendOutcome> {
    const c = conf();
    if (!c) throw notSet();
    const digits = toWaDigits(request.to);
    if (!digits) throw new Error('That number has no country code, so WhatsApp cannot be sure who to send to.');
    const session = await openWaSession();
    try {
      const out = await api<{ messageId?: string }>(c, `/api/sessions/${encodeURIComponent(session.id)}/messages/send-text`, {
        method: 'POST',
        body: { chatId: chatIdFor(digits), text: request.text },
        // So a retry after a timeout cannot deliver the same words twice.
        headers: { 'idempotency-key': randomUUID() },
      });
      const id = normaliseMessageId(out.messageId);
      if (!id) throw new OpenWaError('OpenWA accepted the message but returned no id.', null, 'NO_ID');
      openWaStats.sendsOk += 1;
      return { providerMessageId: id, status: 'sent' };
    } catch (err) {
      openWaStats.sendsFailed += 1;
      throw err;
    }
  },

  async sendMedia(): Promise<SendOutcome> { throw new NotSupportedError(OPENWA_PROVIDER, 'media'); },

  mediaTransport: 'upload',
  async uploadMedia(file: MediaBytes): Promise<string> {
    dropOldUploads();
    const id = randomUUID();
    pendingUploads.set(id, { data: file.data, mimeType: file.mimeType, filename: file.filename, at: Date.now() });
    return id;
  },
  async sendMediaById(request: SendMediaByIdRequest): Promise<SendOutcome> {
    const c = conf();
    if (!c) throw notSet();
    const up = pendingUploads.get(request.mediaId);
    if (!up) throw new Error('That file expired before it could be sent. Please attach it again.');
    pendingUploads.delete(request.mediaId);
    const digits = toWaDigits(request.to);
    if (!digits) throw new Error('That number has no country code, so WhatsApp cannot be sure who to send to.');
    const session = await openWaSession();
    try {
      const out = await api<{ messageId?: string }>(
        c, `/api/sessions/${encodeURIComponent(session.id)}/messages/${ROUTE_FOR[request.type] ?? 'send-document'}`,
        {
          method: 'POST',
          timeoutMs: 60_000,
          body: {
            chatId: chatIdFor(digits),
            base64: up.data.toString('base64'),
            mimetype: up.mimeType,
            filename: request.filename ?? up.filename ?? undefined,
            caption: request.caption || undefined,
          },
          headers: { 'idempotency-key': randomUUID() },
        },
      );
      const id = normaliseMessageId(out.messageId);
      if (!id) throw new OpenWaError('OpenWA accepted the file but returned no id.', null, 'NO_ID');
      openWaStats.sendsOk += 1;
      return { providerMessageId: id, status: 'sent' };
    } catch (err) {
      openWaStats.sendsFailed += 1;
      throw err;
    }
  },

  /**
   * Metadata only. A photo someone sends is not downloaded until a person asks
   * to see it (the chat panel's "Load" button) — otherwise every image in
   * every chat would land in storage whether anybody ever opened it or not.
   */
  async fetchMedia(_ref: MediaRef): Promise<MediaBytes | null> { return null; },

  async sendTemplate() { throw new NotSupportedError(OPENWA_PROVIDER, 'templates'); },
  async listTemplates() { return []; },

  async markRead() { throw new NotSupportedError(OPENWA_PROVIDER, 'markRead'); },
  async getMessageStatus(): Promise<MessageDeliveryState> { return 'unknown'; },
  async syncSupportedHistory() { throw new NotSupportedError(OPENWA_PROVIDER, 'historySync'); },

  verifyWebhook(request: WebhookRequest): WebhookVerification {
    if (request.method === 'GET') return { ok: true, challenge: 'ok' };
    const secret = getIntegrationCredentials(OPENWA_PROVIDER)?.webhookSecret ?? '';
    // No secret configured means refuse, not wave through: an unsigned door
    // into the team's conversations is the thing this CRM has been burned by.
    if (!secret) { openWaStats.rejectedWebhooks += 1; return { ok: false, reason: 'no-webhook-secret' }; }
    if (!verifyOpenWaSignature(request.rawBody, request.headers['x-openwa-signature'], secret)) {
      openWaStats.rejectedWebhooks += 1;
      return { ok: false, reason: 'bad-signature' };
    }
    const fresh = deliveryFreshness(request.rawBody, openWaWebhookMaxAgeMs());
    if (!fresh.ok) { openWaStats.rejectedWebhooks += 1; return { ok: false, reason: fresh.reason }; }
    openWaStats.lastWebhookAt = new Date().toISOString();
    return { ok: true };
  },

  parseWebhook(body: unknown): WebhookBatch {
    const batch = parseOpenWaWebhook(body);
    openWaStats.unresolvedSenders += batch.unresolvedSenders ?? 0;
    if (batch.unresolvedSenders) {
      logger.warn('OpenWA delivered a message whose sender has no phone number; set RESOLVE_LID_TO_PHONE=true in OpenWA');
    }
    return batch;
  },

  async testConnection() {
    const c = conf();
    if (!c) {
      return { ok: false, detail: 'Add the OpenWA address, session name and API key first (and switch the card on).' };
    }
    try {
      const s = await openWaSession({ fresh: true });
      const number = maskPhone(s.phone);
      const secretSet = Boolean(getIntegrationCredentials(OPENWA_PROVIDER)?.webhookSecret);
      return {
        ok: s.status === 'ready',
        detail: `Session "${s.name}" is ${describeSessionStatus(s.status)}.`
          + (number ? ` Linked number: ${number}.` : '')
          + (secretSet ? '' : ' No webhook secret is set yet, so incoming messages will be refused.'),
      };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  },
};

/** For tests that swap the configuration between cases. */
export function __resetOpenWaCaches(): void {
  sessionCache = null;
  pendingUploads.clear();
}

/** Whether OpenWA is the provider handling the CRM's WhatsApp at the moment. */
export function isOpenWa(provider: { name: string } | null | undefined): boolean {
  return provider?.name === OPENWA_PROVIDER;
}
