/**
 * Meta's own Cloud API, direct.
 *
 * The reference shape for every other adapter here, because the Indian
 * resellers are wrappers around this and mostly keep its vocabulary — a
 * template is positional `{{1}}`, a status is sent/delivered/read/failed, and
 * nothing goes out to a stranger after twenty-four hours except a template.
 *
 * **Two things are deliberately settings rather than constants.** The graph
 * version, because Meta retires them on a schedule and a hard-coded one turns
 * into a dead integration on a date nobody has in their calendar; and the base
 * URL, because a reseller that speaks this dialect can be pointed at by
 * changing one field rather than by writing a fifth adapter.
 *
 * Checked against Meta's published reference on 18 September 2026 **from
 * knowledge, not from the page** — `developers.facebook.com` is blocked by
 * this container's egress proxy, so the request shapes here are unverified
 * from inside the CRM's own tooling. The Test Connection button is what proves
 * them against the real account, and it is one click.
 */
import { getIntegrationConfig, getIntegrationCredentials } from '../../../core/settings/integrations.js';
import { logger } from '../../../utils/logger.js';
import { NotSupportedError, type SendOutcome, type WhatsAppCapability } from '../providers/types.js';
import type {
  InboundMessage, MediaBytes, MediaRef, SendMediaByIdRequest, SendTemplateRequest,
  StatusUpdate, TemplateSummary,
  WebhookBatch, WebhookRequest, WebhookVerification, WhatsAppBusinessProvider,
} from './types.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const META_PROVIDER = 'whatsapp_meta';

/*
  `templateSync` belongs here, and its absence was a plain contradiction:
  `listTemplates` below reads `GET /{waba-id}/message_templates` — Meta's own
  canonical list, and the reason the setup guide asks for a WABA id at all —
  while the missing capability made Admin → WhatsApp Templates refuse the Sync
  button with *"whatsapp_meta does not hand its template list back"*. It does.
  Found by pressing the button on 20 September 2026; nothing had ever pressed
  it, because no provider had ever been connected.
*/
const CAPABILITIES: ReadonlySet<WhatsAppCapability> = new Set<WhatsAppCapability>([
  'text', 'media', 'templates', 'templateSync', 'messageStatus', 'markRead',
]);

interface MetaConfig {
  baseUrl: string;
  version: string;
  phoneNumberId: string;
  wabaId: string | null;
  token: string;
  appSecret: string | null;
  verifyToken: string | null;
}

function config(): MetaConfig | null {
  const conf = getIntegrationConfig(META_PROVIDER);
  const creds = getIntegrationCredentials(META_PROVIDER);
  const token = creds?.accessToken ?? '';
  const phoneNumberId = conf?.phoneNumberId ?? '';
  if (!token || !phoneNumberId) return null;
  return {
    baseUrl: (conf?.baseUrl || 'https://graph.facebook.com').replace(/\/+$/, ''),
    version: conf?.apiVersion || 'v21.0',
    phoneNumberId,
    wabaId: conf?.wabaId || null,
    token,
    appSecret: creds?.appSecret || null,
    verifyToken: creds?.verifyToken || null,
  };
}

async function call(
  conf: MetaConfig, path: string, init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${conf.baseUrl}/${conf.version}/${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${conf.token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* Meta answers JSON; a proxy may not */ }
  if (!res.ok) {
    const error = parsed.error as { message?: string } | undefined;
    throw new Error(error?.message || `WhatsApp refused that (${res.status})`);
  }
  return parsed;
}

/** The id Meta hands back for a send, which is what every status then names. */
function sentId(answer: Record<string, unknown>): string {
  const messages = answer.messages as { id?: string }[] | undefined;
  const id = messages?.[0]?.id;
  if (!id) throw new Error('WhatsApp accepted the message but returned no id.');
  return id;
}

/**
 * A raw fetch against the graph, for the two calls that are not JSON.
 *
 * `call()` above parses a JSON answer and sends a JSON body. Media does
 * neither: going out it is multipart, coming back it is the file itself.
 */
async function raw(
  conf: MetaConfig, url: string, init?: { method: 'POST'; body: FormData },
): Promise<Response> {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${conf.token}` },
    body: init?.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WhatsApp refused that (${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res;
}

export const metaCloudProvider: WhatsAppBusinessProvider = {
  name: META_PROVIDER,
  kind: 'business',
  capabilities: CAPABILITIES,

  async isConfigured() { return config() !== null; },

  async businessNumber() {
    const conf = config();
    if (!conf) return null;
    try {
      const answer = await call(conf, conf.phoneNumberId, { method: 'GET' });
      return (answer.display_phone_number as string) ?? null;
    } catch {
      return null;
    }
  },

  async listAccounts() {
    const conf = config();
    if (!conf) return [];
    return [{
      id: conf.phoneNumberId,
      label: 'Business WhatsApp',
      phoneNumber: null,
      displayName: null,
      status: 'connected' as const,
      // One number for the whole team: that is what makes this the business
      // route rather than the per-agent one.
      userId: null,
      lastConnectedAt: null,
      lastError: null,
    }];
  },

  async getConnectionStatus() { return config() ? 'connected' : 'disconnected'; },

  async connectAccount() { /* Connecting is pasting credentials; there is no session to open. */ },
  async disconnectAccount() { /* Likewise: switching the card off is the disconnect. */ },

  async sendMessage({ to, text }): Promise<SendOutcome> {
    const conf = config();
    if (!conf) throw new Error('The WhatsApp Business connection is not set up.');
    const answer = await call(conf, `${conf.phoneNumberId}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/\D/g, ''),
        type: 'text',
        text: { body: text, preview_url: true },
      },
    });
    return { providerMessageId: sentId(answer), status: 'sent' };
  },

  async sendMedia({ to, type, link, caption, filename }): Promise<SendOutcome> {
    const conf = config();
    if (!conf) throw new Error('The WhatsApp Business connection is not set up.');
    const media: Record<string, unknown> = { link };
    if (caption && type !== 'audio') media.caption = caption;
    if (filename && type === 'document') media.filename = filename;
    const answer = await call(conf, `${conf.phoneNumberId}/messages`, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type, [type]: media },
    });
    return { providerMessageId: sentId(answer), status: 'sent' };
  },

  mediaTransport: 'upload',

  async uploadMedia(file: MediaBytes): Promise<string> {
    const conf = config();
    if (!conf) throw new Error('The WhatsApp Business connection is not set up.');
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', file.mimeType);
    // A Blob, not the Buffer: undici needs a real file part with a name, and
    // a bare Buffer is sent as a plain field that Meta answers 400 to.
    form.set('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename ?? 'file');
    const res = await raw(conf, `${conf.baseUrl}/${conf.version}/${conf.phoneNumberId}/media`, {
      method: 'POST', body: form,
    });
    const answer = await res.json() as { id?: string };
    if (!answer.id) throw new Error('WhatsApp took the file but returned no id for it.');
    return answer.id;
  },

  async sendMediaById({ to, type, mediaId, caption, filename }: SendMediaByIdRequest): Promise<SendOutcome> {
    const conf = config();
    if (!conf) throw new Error('The WhatsApp Business connection is not set up.');
    const media: Record<string, unknown> = { id: mediaId };
    if (caption && type !== 'audio') media.caption = caption;
    if (filename && type === 'document') media.filename = filename;
    const answer = await call(conf, `${conf.phoneNumberId}/messages`, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type, [type]: media },
    });
    return { providerMessageId: sentId(answer), status: 'sent' };
  },

  async fetchMedia(ref: MediaRef): Promise<MediaBytes | null> {
    const conf = config();
    if (!conf) return null;
    if (!ref.id && !ref.link) return null;
    /*
      Two hops, and the second one still needs the token. Meta hands back a
      lookaside URL that looks public and is not — fetching it without the
      Authorization header answers 401, which reads exactly like a wrong
      access token rather than a missing header.
    */
    let url = ref.link ?? '';
    let mimeType = ref.mimeType ?? '';
    let filename = ref.filename ?? null;
    if (ref.id) {
      const found = await call(conf, ref.id, { method: 'GET' });
      url = String(found.url ?? '');
      mimeType = String(found.mime_type ?? mimeType);
      if (!url) return null;
    }
    const res = await raw(conf, url);
    const data = Buffer.from(await res.arrayBuffer());
    return {
      data,
      mimeType: mimeType || res.headers.get('content-type') || 'application/octet-stream',
      filename,
    };
  },

  async sendTemplate({ to, templateName, language, params, headerMedia }: SendTemplateRequest): Promise<SendOutcome> {
    const conf = config();
    if (!conf) throw new Error('The WhatsApp Business connection is not set up.');
    const components: Record<string, unknown>[] = [];
    if (headerMedia) {
      components.push({
        type: 'header',
        parameters: [{ type: 'document', document: { link: headerMedia.link, filename: headerMedia.filename } }],
      });
    }
    if (params.length) {
      components.push({ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) });
    }
    const answer = await call(conf, `${conf.phoneNumberId}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        to: to.replace(/\D/g, ''),
        type: 'template',
        template: { name: templateName, language: { code: language }, components },
      },
    });
    return { providerMessageId: sentId(answer), status: 'sent' };
  },

  async listTemplates(): Promise<TemplateSummary[]> {
    const conf = config();
    if (!conf?.wabaId) return [];
    const answer = await call(conf, `${conf.wabaId}/message_templates?limit=200`, { method: 'GET' });
    const data = (answer.data ?? []) as Record<string, unknown>[];
    return data.map((row) => {
      const components = (row.components ?? []) as { type?: string; text?: string }[];
      const body = components.find((c) => c.type === 'BODY')?.text ?? null;
      return {
        name: String(row.name ?? ''),
        language: String(row.language ?? 'en'),
        category: String(row.category ?? 'UTILITY'),
        status: String(row.status ?? 'UNKNOWN'),
        bodyText: body,
        variableCount: countVariables(body),
        providerTemplateId: row.id ? String(row.id) : null,
      };
    });
  },

  async markRead(providerMessageId) {
    const conf = config();
    if (!conf) throw new NotSupportedError(META_PROVIDER, 'markRead');
    await call(conf, `${conf.phoneNumberId}/messages`, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', status: 'read', message_id: providerMessageId },
    });
  },

  async getMessageStatus() {
    // Statuses arrive on the webhook; there is nothing to poll, and pretending
    // otherwise would have the CRM asking a question Meta does not answer.
    return 'unknown';
  },

  async syncSupportedHistory() {
    throw new NotSupportedError(META_PROVIDER, 'historySync');
  },

  verifyWebhook(request: WebhookRequest): WebhookVerification {
    const conf = config();
    if (!conf) return { ok: false, reason: 'not-configured' };

    /*
      Meta subscribes by asking a question: a GET carrying the token the admin
      typed, expecting its own challenge back as plain text. Anything else on a
      GET is somebody guessing.
    */
    if (request.method === 'GET') {
      const mode = request.query['hub.mode'];
      const token = request.query['hub.verify_token'];
      const challenge = request.query['hub.challenge'];
      if (mode === 'subscribe' && conf.verifyToken && token === conf.verifyToken && challenge) {
        return { ok: true, challenge };
      }
      return { ok: false, reason: 'bad-verify-token' };
    }

    /*
      And every delivery is signed with the app secret, over the raw body —
      re-serialising the parsed JSON changes the bytes and the signature then
      never matches, which reads exactly like a wrong secret.
    */
    if (!conf.appSecret) return { ok: false, reason: 'no-app-secret' };
    const header = request.headers['x-hub-signature-256'] ?? '';
    const expected = `sha256=${createHmac('sha256', conf.appSecret).update(request.rawBody).digest('hex')}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
    return { ok: true };
  },

  parseWebhook(body: unknown): WebhookBatch {
    const messages: InboundMessage[] = [];
    const statuses: StatusUpdate[] = [];
    const entries = ((body as { entry?: unknown[] })?.entry ?? []) as Record<string, unknown>[];

    for (const entry of entries) {
      for (const change of ((entry.changes ?? []) as Record<string, unknown>[])) {
        const value = (change.value ?? {}) as Record<string, unknown>;
        const businessNumber = ((value.metadata ?? {}) as Record<string, string>).display_phone_number ?? null;
        const contacts = (value.contacts ?? []) as { wa_id?: string; profile?: { name?: string } }[];

        for (const message of ((value.messages ?? []) as Record<string, unknown>[])) {
          const type = String(message.type ?? 'other');
          const from = String(message.from ?? '');
          const profile = contacts.find((c) => c.wa_id === from)?.profile?.name ?? null;
          messages.push({
            providerMessageId: String(message.id ?? ''),
            from,
            to: businessNumber,
            type: mediaKind(type),
            text: readText(message, type),
            media: readMedia(message, type),
            // Meta sends seconds; a millisecond reading puts every message in 1970.
            sentAt: new Date(Number(message.timestamp ?? 0) * 1000),
            profileName: profile,
          });
        }

        for (const status of ((value.statuses ?? []) as Record<string, unknown>[])) {
          const state = String(status.status ?? '');
          if (state !== 'sent' && state !== 'delivered' && state !== 'read' && state !== 'failed') continue;
          const errors = (status.errors ?? []) as { title?: string; message?: string }[];
          statuses.push({
            providerMessageId: String(status.id ?? ''),
            state,
            at: new Date(Number(status.timestamp ?? 0) * 1000),
            error: errors[0]?.message ?? errors[0]?.title ?? null,
          });
        }
      }
    }
    return { messages, statuses };
  },

  async testConnection() {
    const conf = config();
    if (!conf) return { ok: false, detail: 'Add the access token and phone number id first.' };
    try {
      const answer = await call(conf, conf.phoneNumberId, { method: 'GET' });
      const number = (answer.display_phone_number as string) ?? conf.phoneNumberId;
      const name = (answer.verified_name as string) ?? '';
      return { ok: true, detail: `Connected to ${number}${name ? ` (${name})` : ''}.` };
    } catch (err) {
      logger.warn({ err }, 'WhatsApp Cloud API test failed');
      return { ok: false, detail: (err as Error).message };
    }
  },
};

/** `{{1}} {{2}}` → 2. The mapping screen needs it and so does a campaign. */
export function countVariables(body: string | null): number {
  if (!body) return 0;
  const seen = new Set<string>();
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) seen.add(match[1]);
  return seen.size;
}

function mediaKind(type: string): InboundMessage['type'] {
  return type === 'text' || type === 'image' || type === 'document'
    || type === 'audio' || type === 'video' || type === 'location'
    ? type
    : 'other';
}

function readText(message: Record<string, unknown>, type: string): string | null {
  if (type === 'text') return ((message.text ?? {}) as { body?: string }).body ?? null;
  if (type === 'button') return ((message.button ?? {}) as { text?: string }).text ?? null;
  if (type === 'interactive') {
    const interactive = (message.interactive ?? {}) as Record<string, { title?: string }>;
    return interactive.button_reply?.title ?? interactive.list_reply?.title ?? null;
  }
  const media = (message[type] ?? {}) as { caption?: string };
  return media.caption ?? null;
}

function readMedia(message: Record<string, unknown>, type: string): InboundMessage['media'] {
  if (!['image', 'document', 'audio', 'video'].includes(type)) return null;
  const media = (message[type] ?? {}) as { id?: string; mime_type?: string; filename?: string; caption?: string };
  // An id, not a link: Cloud API media is fetched with the token, in a second
  // call, and the CRM stores its own copy rather than a URL that expires.
  return { id: media.id, mimeType: media.mime_type, filename: media.filename, caption: media.caption };
}
