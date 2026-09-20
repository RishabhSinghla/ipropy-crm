/**
 * The Indian BSPs, as thin adapters over the same contract.
 *
 * All three sell the same official WhatsApp Business account with their own
 * front door on it, so what differs is the envelope: a URL, where the key
 * goes, and whether a plain text message is even offered through the API.
 *
 * Every claim here is what each vendor's **own live documentation** said on
 * 18 September 2026, and where a vendor does not document something the
 * adapter refuses it rather than guessing an endpoint. A guessed endpoint
 * fails at the worst moment — with a customer waiting — and looks like a
 * broken CRM rather than a missing feature.
 *
 *  * AiSensy: `POST https://backend.aisensy.com/campaign/t1/api/v2`, the API
 *    campaign, which sends an **approved template** and nothing else. So its
 *    adapter has `templates` and not `text`: a rep typing a free reply has to
 *    go through the Cloud-API-shaped route, and the UI is told that rather
 *    than discovering it on send.
 *  * Gupshup: `POST https://api.gupshup.io/wa/api/v1/msg`, form-encoded, with
 *    the key in an `apikey` header and the message as a JSON string — text and
 *    media both, which is why it carries both capabilities.
 *  * whatsmarketing.in: **no public developer documentation could be found**
 *    from here. Most resellers of this size proxy the Cloud API unchanged, so
 *    it is offered as the Cloud-compatible adapter with its own base URL —
 *    point it at whatever host they give you, press Test, and the answer is
 *    immediate. Nothing is invented; if their shape differs, the Test button
 *    says so before anybody relies on it.
 */
import { getIntegrationConfig, getIntegrationCredentials } from '../../../core/settings/integrations.js';
import { logger } from '../../../utils/logger.js';
import { NotSupportedError, type SendOutcome, type WhatsAppCapability } from '../providers/types.js';
import type {
  InboundMessage, MediaBytes, MediaRef, SendTemplateRequest, StatusUpdate, TemplateSummary,
  WebhookBatch, WebhookRequest, WebhookVerification, WhatsAppBusinessProvider,
} from './types.js';
import { countVariables, metaCloudProvider } from './metaCloud.js';
import { timingSafeEqual } from 'node:crypto';

/**
 * Collect an inbound file from a plain URL.
 *
 * Every reseller here hands a link rather than an id to exchange, and the link
 * is theirs — it stops working when the account moves or the vendor expires
 * it. So the CRM fetches it once, now, and keeps its own copy; the link is
 * never what the conversation stores.
 *
 * Capped, because a webhook is not a place to discover somebody has sent a
 * 300MB file: the fetch is abandoned rather than held in memory.
 */
const INBOUND_LIMIT = 32 * 1024 * 1024;

async function fetchByLink(ref: MediaRef, headers?: Record<string, string>): Promise<MediaBytes | null> {
  if (!ref.link) return null;
  const res = await fetch(ref.link, { headers });
  if (!res.ok) return null;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > INBOUND_LIMIT) return null;
  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > INBOUND_LIMIT) return null;
  return {
    data,
    mimeType: ref.mimeType || res.headers.get('content-type') || 'application/octet-stream',
    filename: ref.filename ?? null,
  };
}

export const AISENSY_PROVIDER = 'whatsapp_aisensy';
export const GUPSHUP_PROVIDER = 'whatsapp_gupshup';

/**
 * A shared secret on the webhook, which is all the resellers offer.
 *
 * Compared in constant time and by length first, because a comparison that
 * returns early leaks the secret one character at a time to anybody patient.
 */
function tokenMatches(expected: string | null | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sharedVerify(provider: string, request: WebhookRequest): WebhookVerification {
  const creds = getIntegrationCredentials(provider);
  const secret = creds?.webhookToken;
  if (!secret) return { ok: false, reason: 'no-webhook-token' };
  const given = request.headers['x-webhook-token']
    ?? request.headers['x-api-key']
    ?? request.query.token;
  return tokenMatches(secret, given) ? { ok: true } : { ok: false, reason: 'bad-webhook-token' };
}

// ---------------------------------------------------------------------------
// AiSensy — approved templates through the campaign API
// ---------------------------------------------------------------------------

const AISENSY_CAPABILITIES: ReadonlySet<WhatsAppCapability> = new Set<WhatsAppCapability>([
  'templates', 'messageStatus',
]);

export const aisensyProvider: WhatsAppBusinessProvider = {
  name: AISENSY_PROVIDER,
  kind: 'business',
  capabilities: AISENSY_CAPABILITIES,

  async isConfigured() { return Boolean(getIntegrationCredentials(AISENSY_PROVIDER)?.apiKey); },
  async businessNumber() { return getIntegrationConfig(AISENSY_PROVIDER)?.businessNumber ?? null; },

  async listAccounts() {
    const number = getIntegrationConfig(AISENSY_PROVIDER)?.businessNumber ?? null;
    return [{
      id: AISENSY_PROVIDER, label: 'AiSensy', phoneNumber: number, displayName: null,
      status: getIntegrationCredentials(AISENSY_PROVIDER)?.apiKey ? 'connected' as const : 'disconnected' as const,
      userId: null, lastConnectedAt: null, lastError: null,
    }];
  },
  async getConnectionStatus() {
    return getIntegrationCredentials(AISENSY_PROVIDER)?.apiKey ? 'connected' : 'disconnected';
  },
  async connectAccount() { /* credentials only */ },
  async disconnectAccount() { /* credentials only */ },

  async sendMessage() {
    // Documented as a campaign API: it sends approved templates. Refused here
    // rather than attempted, so the composer can offer the template picker
    // instead of failing a rep's typed reply after they pressed send.
    throw new NotSupportedError(AISENSY_PROVIDER, 'text');
  },
  async sendMedia() { throw new NotSupportedError(AISENSY_PROVIDER, 'media'); },

  mediaTransport: 'link',
  async uploadMedia() { throw new NotSupportedError(AISENSY_PROVIDER, 'media'); },
  async sendMediaById() { throw new NotSupportedError(AISENSY_PROVIDER, 'media'); },
  // Inbound is a different question from outbound: AiSensy cannot *send* a
  // file through its campaign API, and a customer can still send one in.
  async fetchMedia(ref: MediaRef) { return fetchByLink(ref); },

  async sendTemplate({ to, templateName, params, headerMedia }: SendTemplateRequest): Promise<SendOutcome> {
    const key = getIntegrationCredentials(AISENSY_PROVIDER)?.apiKey;
    const conf = getIntegrationConfig(AISENSY_PROVIDER);
    if (!key) throw new Error('Add the AiSensy API key first.');
    const res = await fetch(conf?.baseUrl || 'https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: key,
        // AiSensy sends *campaigns*, so the template is named by the campaign
        // an admin created for it. Falling back to the template name keeps a
        // one-to-one setup working without a second field to fill in.
        campaignName: conf?.[`campaign_${templateName}`] || conf?.campaignName || templateName,
        destination: to.replace(/\D/g, ''),
        userName: conf?.senderName || 'iPropy',
        source: 'iPropy CRM',
        templateParams: params,
        ...(headerMedia ? { media: { url: headerMedia.link, filename: headerMedia.filename ?? 'file' } } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AiSensy refused that (${res.status}): ${text.slice(0, 200)}`);
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* some answers are plain text */ }
    return {
      // No provider id in the campaign answer, so the CRM's own id is what the
      // conversation is keyed on and a status webhook matches on the number.
      providerMessageId: String(parsed.messageId ?? parsed.id ?? ''),
      status: 'queued',
    };
  },

  async listTemplates() { throw new NotSupportedError(AISENSY_PROVIDER, 'templateSync'); },
  async markRead() { throw new NotSupportedError(AISENSY_PROVIDER, 'markRead'); },
  async getMessageStatus() { return 'unknown'; },
  async syncSupportedHistory() { throw new NotSupportedError(AISENSY_PROVIDER, 'historySync'); },

  verifyWebhook(request) { return sharedVerify(AISENSY_PROVIDER, request); },
  parseWebhook(body) { return parseCloudShaped(body); },

  async testConnection() {
    const key = getIntegrationCredentials(AISENSY_PROVIDER)?.apiKey;
    if (!key) return { ok: false, detail: 'Add the AiSensy API key first.' };
    // AiSensy publishes no credential-check endpoint, and sending a live
    // template to prove a key would message a real customer. So this reports
    // what it actually knows and says what still has to be proved.
    return {
      ok: true,
      detail: 'Key saved. AiSensy has no test endpoint, so the first template send is the real check.',
    };
  },
};

// ---------------------------------------------------------------------------
// Gupshup — text and media, form-encoded
// ---------------------------------------------------------------------------

/*
  Same contradiction as Meta's: `listTemplates` below really does read
  Gupshup's own template list, and without `templateSync` the Sync button told
  an admin the opposite.
*/
const GUPSHUP_CAPABILITIES: ReadonlySet<WhatsAppCapability> = new Set<WhatsAppCapability>([
  'text', 'media', 'templates', 'templateSync', 'messageStatus',
]);

function gupshupForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export const gupshupProvider: WhatsAppBusinessProvider = {
  name: GUPSHUP_PROVIDER,
  kind: 'business',
  capabilities: GUPSHUP_CAPABILITIES,

  async isConfigured() {
    const creds = getIntegrationCredentials(GUPSHUP_PROVIDER);
    return Boolean(creds?.apiKey && getIntegrationConfig(GUPSHUP_PROVIDER)?.source);
  },
  async businessNumber() { return getIntegrationConfig(GUPSHUP_PROVIDER)?.source ?? null; },

  async listAccounts() {
    const conf = getIntegrationConfig(GUPSHUP_PROVIDER);
    return [{
      id: GUPSHUP_PROVIDER, label: 'Gupshup', phoneNumber: conf?.source ?? null, displayName: conf?.appName ?? null,
      status: getIntegrationCredentials(GUPSHUP_PROVIDER)?.apiKey ? 'connected' as const : 'disconnected' as const,
      userId: null, lastConnectedAt: null, lastError: null,
    }];
  },
  async getConnectionStatus() {
    return getIntegrationCredentials(GUPSHUP_PROVIDER)?.apiKey ? 'connected' : 'disconnected';
  },
  async connectAccount() { /* credentials only */ },
  async disconnectAccount() { /* credentials only */ },

  async sendMessage({ to, text }): Promise<SendOutcome> { return gupshupSend(to, { type: 'text', text }); },

  async sendMedia({ to, type, link, caption, filename }): Promise<SendOutcome> {
    const message = type === 'image'
      ? { type: 'image', originalUrl: link, previewUrl: link, caption }
      : type === 'video'
        ? { type: 'video', url: link, caption }
        : type === 'audio'
          ? { type: 'audio', url: link }
          : { type: 'file', url: link, filename: filename ?? 'document' };
    return gupshupSend(to, message);
  },

  mediaTransport: 'link',
  async uploadMedia() {
    // Gupshup fetches a URL; it publishes no upload endpoint, so the CRM
    // publishes the file on a signed, short-lived link instead.
    throw new NotSupportedError(GUPSHUP_PROVIDER, 'media');
  },
  async sendMediaById() { throw new NotSupportedError(GUPSHUP_PROVIDER, 'media'); },
  async fetchMedia(ref: MediaRef) { return fetchByLink(ref); },

  async sendTemplate({ to, templateName, params }: SendTemplateRequest): Promise<SendOutcome> {
    const creds = getIntegrationCredentials(GUPSHUP_PROVIDER);
    const conf = getIntegrationConfig(GUPSHUP_PROVIDER);
    if (!creds?.apiKey || !conf?.source) throw new Error('Add the Gupshup key and source number first.');
    const res = await fetch(`${conf.baseUrl || 'https://api.gupshup.io'}/wa/api/v1/template/msg`, {
      method: 'POST',
      headers: { apikey: creds.apiKey, 'content-type': 'application/x-www-form-urlencoded' },
      body: gupshupForm({
        channel: 'whatsapp',
        source: conf.source,
        destination: to.replace(/\D/g, ''),
        'src.name': conf.appName ?? '',
        template: JSON.stringify({ id: templateName, params }),
      }),
    });
    return gupshupAnswer(res);
  },

  async listTemplates(): Promise<TemplateSummary[]> {
    const creds = getIntegrationCredentials(GUPSHUP_PROVIDER);
    const conf = getIntegrationConfig(GUPSHUP_PROVIDER);
    if (!creds?.apiKey || !conf?.appName) throw new NotSupportedError(GUPSHUP_PROVIDER, 'templateSync');
    const res = await fetch(`${conf.baseUrl || 'https://api.gupshup.io'}/wa/app/${conf.appName}/template`, {
      headers: { apikey: creds.apiKey },
    });
    if (!res.ok) throw new Error(`Gupshup refused the template list (${res.status}).`);
    const answer = await res.json() as { templates?: Record<string, unknown>[] };
    return (answer.templates ?? []).map((row) => ({
      name: String(row.elementName ?? row.id ?? ''),
      language: String(row.languageCode ?? 'en'),
      category: String(row.category ?? 'UTILITY'),
      status: String(row.status ?? 'UNKNOWN'),
      bodyText: row.data ? String(row.data) : null,
      variableCount: countVariables(row.data ? String(row.data) : null),
      providerTemplateId: row.id ? String(row.id) : null,
    }));
  },

  async markRead() { throw new NotSupportedError(GUPSHUP_PROVIDER, 'markRead'); },
  async getMessageStatus() { return 'unknown'; },
  async syncSupportedHistory() { throw new NotSupportedError(GUPSHUP_PROVIDER, 'historySync'); },

  verifyWebhook(request) { return sharedVerify(GUPSHUP_PROVIDER, request); },

  parseWebhook(body): WebhookBatch {
    const messages: InboundMessage[] = [];
    const statuses: StatusUpdate[] = [];
    const event = (body ?? {}) as Record<string, unknown>;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const type = String(event.type ?? '');

    if (type === 'message') {
      const inner = (payload.payload ?? {}) as Record<string, string>;
      const sender = (payload.sender ?? {}) as { phone?: string; name?: string };
      messages.push({
        providerMessageId: String(payload.id ?? ''),
        from: String(sender.phone ?? payload.source ?? ''),
        to: String(payload.destination ?? '') || null,
        type: String(payload.type ?? 'text') === 'text' ? 'text' : 'other',
        text: inner.text ?? inner.caption ?? null,
        media: inner.url ? { link: inner.url, caption: inner.caption } : null,
        sentAt: new Date(Number(event.timestamp ?? Date.now())),
        profileName: sender.name ?? null,
      });
    }

    if (type === 'message-event') {
      const state = String(payload.type ?? '');
      const mapped = state === 'sent' ? 'sent'
        : state === 'delivered' ? 'delivered'
          : state === 'read' ? 'read'
            : state === 'failed' || state === 'enqueued' ? 'failed' : null;
      if (mapped && mapped !== 'failed') {
        statuses.push({
          providerMessageId: String(payload.id ?? ''), state: mapped,
          at: new Date(Number(event.timestamp ?? Date.now())), error: null,
        });
      } else if (mapped === 'failed') {
        statuses.push({
          providerMessageId: String(payload.id ?? ''), state: 'failed',
          at: new Date(Number(event.timestamp ?? Date.now())),
          error: String((payload.payload as { reason?: string })?.reason ?? 'failed'),
        });
      }
    }
    return { messages, statuses };
  },

  async testConnection() {
    const creds = getIntegrationCredentials(GUPSHUP_PROVIDER);
    const conf = getIntegrationConfig(GUPSHUP_PROVIDER);
    if (!creds?.apiKey) return { ok: false, detail: 'Add the Gupshup API key first.' };
    try {
      const res = await fetch(`${conf?.baseUrl || 'https://api.gupshup.io'}/wa/app`, {
        headers: { apikey: creds.apiKey },
      });
      if (!res.ok) return { ok: false, detail: `Gupshup refused the key (${res.status}).` };
      return { ok: true, detail: 'Key accepted by Gupshup.' };
    } catch (err) {
      logger.warn({ err }, 'Gupshup test failed');
      return { ok: false, detail: (err as Error).message };
    }
  },
};

async function gupshupSend(to: string, message: Record<string, unknown>): Promise<SendOutcome> {
  const creds = getIntegrationCredentials(GUPSHUP_PROVIDER);
  const conf = getIntegrationConfig(GUPSHUP_PROVIDER);
  if (!creds?.apiKey || !conf?.source) throw new Error('Add the Gupshup key and source number first.');
  const res = await fetch(`${conf.baseUrl || 'https://api.gupshup.io'}/wa/api/v1/msg`, {
    method: 'POST',
    headers: { apikey: creds.apiKey, 'content-type': 'application/x-www-form-urlencoded' },
    body: gupshupForm({
      channel: 'whatsapp',
      source: conf.source,
      destination: to.replace(/\D/g, ''),
      'src.name': conf.appName ?? '',
      message: JSON.stringify(message),
    }),
  });
  return gupshupAnswer(res);
}

async function gupshupAnswer(res: Response): Promise<SendOutcome> {
  const text = await res.text();
  if (!res.ok) throw new Error(`Gupshup refused that (${res.status}): ${text.slice(0, 200)}`);
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* plain text on some errors */ }
  const id = String(parsed.messageId ?? '');
  if (!id) throw new Error('Gupshup accepted the message but returned no id.');
  // Gupshup accepts asynchronously and confirms on the webhook, so "submitted"
  // is queued rather than sent — saying sent here would show a tick the
  // customer's phone has not earned.
  return { providerMessageId: id, status: 'queued' };
}

// ---------------------------------------------------------------------------
// whatsmarketing.in and anything else that speaks the Cloud API's dialect
// ---------------------------------------------------------------------------

/**
 * A Cloud-API-shaped reseller, pointed at its own host.
 *
 * Exists because no developer documentation for whatsmarketing.in could be
 * found from here, and because the next reseller the business tries should not
 * need a fifth adapter. Give it the base URL, the phone number id and the
 * token their dashboard shows, press Test, and it either answers or it does
 * not — which is a truthful ten seconds rather than an invented endpoint.
 */
export function cloudCompatibleProvider(provider: string, label: string): WhatsAppBusinessProvider {
  const CAPS: ReadonlySet<WhatsAppCapability> = new Set<WhatsAppCapability>([
    'text', 'media', 'templates', 'messageStatus',
  ]);

  const conf = (): { baseUrl: string; version: string; phoneNumberId: string; token: string } | null => {
    const config = getIntegrationConfig(provider);
    const creds = getIntegrationCredentials(provider);
    if (!creds?.accessToken || !config?.phoneNumberId || !config?.baseUrl) return null;
    return {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      version: config.apiVersion || 'v21.0',
      phoneNumberId: config.phoneNumberId,
      token: creds.accessToken,
    };
  };

  const post = async (body: unknown): Promise<SendOutcome> => {
    const c = conf();
    if (!c) throw new Error(`Add the ${label} base URL, phone number id and token first.`);
    const res = await fetch(`${c.baseUrl}/${c.version}/${c.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${label} refused that (${res.status}): ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
    const id = parsed.messages?.[0]?.id;
    if (!id) throw new Error(`${label} accepted the message but returned no id.`);
    return { providerMessageId: id, status: 'sent' };
  };

  return {
    name: provider,
    kind: 'business',
    capabilities: CAPS,
    async isConfigured() { return conf() !== null; },
    async businessNumber() { return getIntegrationConfig(provider)?.businessNumber ?? null; },
    async listAccounts() {
      return [{
        id: provider, label, phoneNumber: getIntegrationConfig(provider)?.businessNumber ?? null,
        displayName: null, status: conf() ? 'connected' as const : 'disconnected' as const,
        userId: null, lastConnectedAt: null, lastError: null,
      }];
    },
    async getConnectionStatus() { return conf() ? 'connected' : 'disconnected'; },
    async connectAccount() { /* credentials only */ },
    async disconnectAccount() { /* credentials only */ },
    async sendMessage({ to, text }) {
      return post({ messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type: 'text', text: { body: text } });
    },
    async sendMedia({ to, type, link, caption, filename }) {
      const media: Record<string, unknown> = { link };
      if (caption && type !== 'audio') media.caption = caption;
      if (filename && type === 'document') media.filename = filename;
      return post({ messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type, [type]: media });
    },
    async sendTemplate({ to, templateName, language, params }) {
      return post({
        messaging_product: 'whatsapp',
        to: to.replace(/\D/g, ''),
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
          components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [],
        },
      });
    },
    mediaTransport: 'link',
    async uploadMedia() { throw new NotSupportedError(provider, 'media'); },
    async sendMediaById() { throw new NotSupportedError(provider, 'media'); },
    async fetchMedia(ref: MediaRef) {
      /*
        This adapter speaks the Cloud API's shape, so its webhooks carry a
        media *id* rather than a link — and the id is exchanged for a URL that
        still needs the account's own token. Both hops go to the reseller's
        own host, never to Meta's.
      */
      const c = conf();
      if (!c) return null;
      const auth = { authorization: `Bearer ${c.token}` };
      if (ref.link) return fetchByLink(ref, auth);
      if (!ref.id) return null;
      const found = await fetch(`${c.baseUrl}/${c.version}/${ref.id}`, { headers: auth });
      if (!found.ok) return null;
      const answer = await found.json() as { url?: string; mime_type?: string };
      if (!answer.url) return null;
      return fetchByLink({ ...ref, link: answer.url, mimeType: ref.mimeType || answer.mime_type }, auth);
    },
    async listTemplates() { throw new NotSupportedError(provider, 'templateSync'); },
    async markRead() { throw new NotSupportedError(provider, 'markRead'); },
    async getMessageStatus() { return 'unknown'; },
    async syncSupportedHistory() { throw new NotSupportedError(provider, 'historySync'); },
    verifyWebhook(request) { return sharedVerify(provider, request); },
    parseWebhook(body) { return parseCloudShaped(body); },
    async testConnection() {
      const c = conf();
      if (!c) return { ok: false, detail: `Add the ${label} base URL, phone number id and token first.` };
      try {
        const res = await fetch(`${c.baseUrl}/${c.version}/${c.phoneNumberId}`, {
          headers: { authorization: `Bearer ${c.token}` },
        });
        return res.ok
          ? { ok: true, detail: `${label} answered on that number.` }
          : { ok: false, detail: `${label} refused the credentials (${res.status}).` };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}

/*
  WhatsMarketing used to be `cloudCompatibleProvider` here — an honest guess
  that they proxy Meta's Cloud API, which their own documentation (sent by the
  owner on 19 September 2026) shows they do not. It has a real adapter now, in
  `whatsMarketing.ts`. `cloudCompatibleProvider` stays: it is still the right
  answer for the next reseller that genuinely does proxy the Cloud API, and it
  is what the CRM offers before anybody has read a vendor's docs.
*/

/**
 * The Cloud API's webhook shape, which the resellers that wrap it also send.
 *
 * The Meta adapter's own parser, called directly rather than copied — a second
 * parser that drifts is inbound messages landing in one route and not the
 * other. There is no cycle: `metaCloud` imports nothing from here.
 */
function parseCloudShaped(body: unknown): WebhookBatch {
  return metaCloudProvider.parseWebhook(body);
}
