/**
 * WhatsMarketing, written from their own API documentation.
 *
 * Until 19 September 2026 this was `cloudCompatibleProvider` — a guess, made
 * honestly and labelled as one, that they proxy Meta's Cloud API unchanged
 * because most resellers of that size do. **They do not**, and the owner sent
 * their documentation (v1.0, `app.whatsmarketing.in`), so every endpoint,
 * parameter name and response field below is copied from it rather than
 * inferred. The guess was wrong in all four ways that matter:
 *
 *   * the token goes in the **form body** as `apiToken`, not a Bearer header;
 *   * requests are **form-encoded**, not JSON;
 *   * the paths are `/whatsapp/send`, `/whatsapp/send/template`,
 *     `/whatsapp/send/file` — not `/{version}/{phone-number-id}/messages`;
 *   * success is `{"status":"1"}` with the id in `wa_message_id`, and a
 *     **failure also answers HTTP 200** with `{"status":"0"}`. That last one
 *     is the dangerous one: checking `res.ok` alone would report every refused
 *     message as sent, and a rep would watch a tick appear for a message the
 *     customer never got.
 *
 * What their documentation does **not** contain is an inbound webhook. There
 * is no section for it, and §17 says delivery-status webhooks need their
 * support team to set up. So nothing here invents a callback shape:
 * `parseWebhook` reads the two shapes it can recognise and *records* anything
 * else instead of dropping it silently, which is what turns "their webhook
 * looks different" into a fixable fact rather than customers' messages
 * disappearing.
 */
import { getIntegrationConfig, getIntegrationCredentials } from '../../../core/settings/integrations.js';
import { logger } from '../../../utils/logger.js';
import {
  NotSupportedError, type MessageDeliveryState, type SendOutcome, type WhatsAppCapability,
} from '../providers/types.js';
import type {
  InboundMessage, MediaBytes, MediaRef, SendTemplateRequest, StatusUpdate, TemplateSummary,
  WebhookBatch, WebhookRequest, WebhookVerification, WhatsAppBusinessProvider,
} from './types.js';

export const WHATSMARKETING_PROVIDER = 'whatsapp_whatsmarketing';

const LABEL = 'whatsmarketing.in';
const DEFAULT_BASE = 'https://app.whatsmarketing.in/api/v1';

/*
  `templateSync` is what lets Admin → WhatsApp Templates fetch the list, and
  leaving it out is why the owner's first sync answered "whatsmarketing does
  not hand its template list back" while `listTemplates` sat there fully
  implemented. `syncTemplates` checks the capability before it calls anything,
  which is right — a capability a provider lacks should be refused early — but
  it means the set below is load-bearing, not documentation.
*/
const CAPABILITIES: ReadonlySet<WhatsAppCapability> = new Set<WhatsAppCapability>([
  'text', 'media', 'templates', 'templateSync', 'messageStatus',
]);

interface Conf { baseUrl: string; phoneNumberId: string; apiToken: string; botId: string | null }

function conf(): Conf | null {
  const config = getIntegrationConfig(WHATSMARKETING_PROVIDER);
  const creds = getIntegrationCredentials(WHATSMARKETING_PROVIDER);
  const apiToken = creds?.apiToken ?? '';
  const phoneNumberId = config?.phoneNumberId ?? '';
  if (!apiToken || !phoneNumberId) return null;
  return {
    // Their own base, overridable, because a vendor moving host should be a
    // text box rather than a deploy.
    baseUrl: (config?.baseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
    phoneNumberId,
    apiToken,
    botId: config?.botId || null,
  };
}

const missing = (): Error => new Error(
  'Add the WhatsMarketing API token and Phone Number ID in Admin → Integrations first.',
);

/**
 * One POST, form-encoded, with the answer already judged.
 *
 * Every endpoint in their API is shaped this way, so the `status` check lives
 * here once. A refusal arrives as HTTP 200 with `status: "0"` and the reason
 * in `message`; raising it as an error is what stops the CRM recording a send
 * that never happened.
 */
async function call(path: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const c = conf();
  if (!c) throw missing();
  const res = await fetch(`${c.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      apiToken: c.apiToken,
      phone_number_id: c.phoneNumberId,
      ...fields,
    }).toString(),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${LABEL} refused that (HTTP ${res.status}): ${text.slice(0, 200)}`);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${LABEL} answered something that is not JSON: ${text.slice(0, 200)}`);
  }
  // Their own success flag, and it is a *string* "1" in the documentation, so
  // both are accepted rather than depending on which one their build sends.
  if (String(parsed.status) !== '1') {
    throw new Error(String(parsed.message ?? `${LABEL} refused that and gave no reason.`));
  }
  return parsed;
}

/** Digits only with the country code, which is how every endpoint wants it. */
const digits = (to: string): string => to.replace(/\D/g, '');

/**
 * Write a note on a contact in WhatsMarketing, visible in their inbox's Notes.
 *
 * `/whatsapp/subscriber/chat/add-notes`, not `/chat/add` as their document
 * says — the documented path answers 404, and this one was found on 25
 * September 2026 by sending it incomplete and reading its refusal. Their API
 * has no subscribe or unsubscribe of its own, and no field that says which a
 * contact is; a note is the one honest thing the CRM can leave there.
 */
export async function addWhatsMarketingNote(phoneWithCountryCode: string, note: string): Promise<void> {
  await call('/whatsapp/subscriber/chat/add-notes', {
    phone_number: digits(phoneWithCountryCode),
    note_text: note,
  });
}

/**
 * Each template id to the *other* id the same row publishes.
 *
 * Filled whenever the template list is read. It exists so a "template not
 * found" from their API can be retried with the id they did not want, rather
 * than handed to a person as a refusal about a template they can plainly see
 * in the CRM.
 */
const otherId = new Map<string, string>();

function outcome(answer: Record<string, unknown>): SendOutcome {
  const id = String(answer.wa_message_id ?? '');
  if (!id) throw new Error(`${LABEL} accepted the message but returned no id.`);
  /*
    `queued`, not `sent`. Their API answers as soon as it has taken the message,
    and the real sent/delivered/read comes back from the status endpoint — so
    claiming `sent` here would show the customer a tick their phone has not
    earned. The same reasoning as the Gupshup adapter.
  */
  return { providerMessageId: id, status: 'queued' };
}

/** Their documented media kinds. Audio takes no caption; the rest may. */
const CAPTIONABLE = new Set(['image', 'video', 'document']);

/**
 * Turn a template name into the numeric id their send endpoint wants.
 *
 * Their templates are addressed by `template_id`, a number from the dashboard,
 * while everything else in this CRM — and Meta itself — names a template. So
 * the list endpoint is the bridge. It is cached for a minute: a send should not
 * cost two round trips every time, and a template approved in the last sixty
 * seconds is not a case worth optimising for.
 */
let templateCache: { at: number; rows: TemplateSummary[] } | null = null;

/**
 * The cache is for *sending* only, never for the Sync button.
 *
 * An admin who presses "Sync templates" has just approved one in
 * WhatsMarketing's dashboard and is asking the CRM to go and look. Serving
 * them a minute-old list makes the button appear broken for a minute, which is
 * exactly long enough for somebody to press it four times and then ask why
 * their new template is missing. A test caught this before it shipped.
 */
async function templates({ fresh = false } = {}): Promise<TemplateSummary[]> {
  if (!fresh && templateCache && Date.now() - templateCache.at < 60_000) return templateCache.rows;
  /*
    `/whatsapp/get/template/list`, from their live developer console — the PDF
    the owner first sent calls it `/whatsapp/template/list`, which 404s. Their
    console is the newer of the two and is what this follows wherever they
    disagree.
  */
  const answer = await call('/whatsapp/get/template/list', {});

  /*
    Everything in their API answers under `message`, and that key is a string
    on a failure, one object when there is a single row, and an array when
    there are several. All three are normalised here rather than at four call
    sites — the single-object case is the one that would quietly yield no
    templates at all for an account that has exactly one.
  */
  const payload = answer.message;
  const list = (Array.isArray(payload) ? payload
    : payload && typeof payload === 'object' ? [payload] : []) as Record<string, unknown>[];

  const rows = list.map((row): TemplateSummary => {
    const body = String(row.body_content ?? row.body ?? '') || null;
    /*
      They publish `variable_map` — `{"header":[],"body":[...]}` — which is the
      authoritative count of blanks. The {{n}} scan is the fallback for a row
      that does not carry it, because a body with no placeholders and a body
      with three is the difference between a template that sends and one Meta
      refuses.
    */
    const map = row.variable_map as { body?: unknown[] } | undefined;
    const declared = Array.isArray(map?.body) ? map.body.length : null;
    return {
      name: String(row.template_name ?? row.name ?? ''),
      language: String(row.locale ?? row.language ?? 'en'),
      category: String(row.category ?? row.check_wp_type ?? 'UTILITY'),
      status: String(row.status ?? 'APPROVED'),
      bodyText: body,
      variableCount: declared ?? (body ? (body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length : 0),
      /*
        **Two ids, and which one `/whatsapp/send/template` wants is not
        documented anywhere.** A row carries `template_id` (Meta's long id,
        `1574812586925817`) and `id` (their own row, `340813`). This sent
        Meta's, on the strength of the parameter sharing its name, and on
        20 September their API answered *"Message template not found."* with a
        template that had synced from them minutes earlier.

        So both are kept, and `sendTemplate` tries the other one when the
        first is refused — see `otherId`. A comment claiming to know which
        is what put a red bubble in front of the owner.
      */
      providerTemplateId: String(row.template_id ?? row.id ?? '') || null,
    };
  }).filter((t) => t.name || t.providerTemplateId);

  /*
    Which other id this template also has, so a refusal can be retried rather
    than handed to somebody as "not found" for a template they can see.
  */
  otherId.clear();
  for (const row of list) {
    const a = String(row.template_id ?? '');
    const b = String(row.id ?? '');
    if (a && b && a !== b) { otherId.set(a, b); otherId.set(b, a); }
  }

  templateCache = { at: Date.now(), rows };
  return rows;
}

export const whatsMarketingProvider: WhatsAppBusinessProvider = {
  name: WHATSMARKETING_PROVIDER,
  kind: 'business',
  capabilities: CAPABILITIES,

  async isConfigured() { return conf() !== null; },
  async businessNumber() { return getIntegrationConfig(WHATSMARKETING_PROVIDER)?.businessNumber ?? null; },

  async listAccounts() {
    const c = conf();
    return [{
      id: WHATSMARKETING_PROVIDER,
      label: LABEL,
      phoneNumber: getIntegrationConfig(WHATSMARKETING_PROVIDER)?.businessNumber ?? null,
      displayName: null,
      status: c ? 'connected' as const : 'disconnected' as const,
      userId: null,
      lastConnectedAt: null,
      lastError: null,
    }];
  },
  async getConnectionStatus() { return conf() ? 'connected' : 'disconnected'; },
  async connectAccount() { /* credentials only — nothing to open */ },
  async disconnectAccount() { /* credentials only — nothing to close */ },

  async sendMessage({ to, text }) {
    return outcome(await call('/whatsapp/send', { phone_number: digits(to), message: text }));
  },

  async sendMedia({ to, type, link, caption, filename }) {
    /*
      `media_url` and not an upload: their send endpoint takes a public HTTPS
      link and fetches it themselves. The CRM already publishes one for exactly
      this, signed over the id and the expiry and valid fifteen minutes
      (`business/media.ts`), because every reseller works this way.

      `filename` has nowhere to go in their API — there is no parameter for it —
      so it rides in the caption for a document rather than being dropped, which
      is the difference between a customer seeing "Brochure — B-110" and seeing
      an untitled PDF.
    */
    const fields: Record<string, string> = {
      phone_number: digits(to),
      media_url: link,
      media_type: type,
    };
    /*
      `media_name` is REQUIRED for a document — their console says so, and a
      document sent without it is refused. It is also what the customer sees as
      the filename, so "Brochure B-110.pdf" rather than an untitled PDF. The
      earlier version of this adapter smuggled the name into the caption, which
      was both wrong and a refused send.
    */
    if (type === 'document') fields.media_name = filename || 'document.pdf';
    if (caption && CAPTIONABLE.has(type)) fields.media_caption_text = caption;
    return outcome(await call('/whatsapp/send/file', fields));
  },

  async sendTemplate({ to, templateName, params }: SendTemplateRequest): Promise<SendOutcome> {
    /*
      Their template id is a number from the dashboard, so a name has to be
      resolved through the list endpoint first. A name that resolves to nothing
      is refused *here*, naming the template — rather than posting an empty
      `template_id` and letting their API answer "Template not found", which
      says nothing about which one.
    */
    const found = (await templates()).find(
      (t) => t.name === templateName || t.providerTemplateId === templateName,
    );
    const templateId = found?.providerTemplateId;
    if (!templateId) {
      throw new Error(
        `WhatsMarketing has no template called "${templateName}". `
        + 'Sync the template list in Admin → WhatsApp Templates and try again.',
      );
    }

    /*
      Variables are `templateVariable-{name}-{position}`. Meta's own templates
      are positional ({{1}}, {{2}}), which is what this CRM stores and what
      `params` carries, so the position is the part that has to be right. The
      name half is documented only by example — their own sample uses
      `User-Name-1` — and no response field publishes it, so `var` is used
      rather than a made-up business word. If their API turns out to key on the
      name rather than the position, this is the one line that changes, and the
      failure is loud (their "Template not found" / a blank in the message)
      rather than silent.
    */
    const send = async (id: string): Promise<Record<string, unknown>> => {
      const fields: Record<string, string> = { template_id: id, phone_number: digits(to) };
      params.forEach((value, i) => { fields[`templateVariable-var-${i + 1}`] = value; });
      return call('/whatsapp/send/template', fields);
    };

    /*
      **Their two ids, and a refusal that names neither.**

      A template row carries `template_id` (Meta's long id) and `id` (their own
      row), and nothing in their documentation says which one
      `/whatsapp/send/template` wants. On 20 September Meta's was sent — the
      parameter shares its name — and their API answered *"Message template not
      found."* about a template that had synced from them minutes earlier.
      That is unarguable; it is not proof that the other id is right.

      So the other one is tried, **once, and only on that exact refusal**. A
      blanket retry would double every real failure; this one is narrow enough
      that the worst case is a second refusal nobody sees. When it works the
      log says which id did it, which is how this stops being a guess and
      becomes a fact somebody can write down.
    */
    try {
      return outcome(await send(templateId));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const other = otherId.get(templateId);
      if (!other || !/template not found/i.test(why)) throw err;

      logger.warn(
        { templateName, tried: templateId, retryingWith: other },
        'whatsmarketing refused a template id; trying the other id it publishes',
      );
      const second = await send(other);
      logger.info(
        { templateName, worked: other },
        'whatsmarketing accepted the other template id — record this in CLAUDE.md',
      );
      return outcome(second);
    }
  },

  async listTemplates() { return templates({ fresh: true }); },

  // Their `/whatsapp/upload/media` exists and returns a media_id, but their
  // send endpoint takes a link just as happily, and the CRM already has the
  // signed link. One path, not two.
  mediaTransport: 'link',
  async uploadMedia() { throw new NotSupportedError(WHATSMARKETING_PROVIDER, 'media'); },
  async sendMediaById() { throw new NotSupportedError(WHATSMARKETING_PROVIDER, 'media'); },

  async fetchMedia(ref: MediaRef): Promise<MediaBytes | null> {
    /*
      Whatever an inbound message refers to is collected once, now, and kept as
      the CRM's own attachment — the owner's rule that the history must never
      depend on the vendor's dashboard. Their API documents no media-download
      endpoint, so a link is all there is to work with.
    */
    if (!ref.link) return null;
    const res = await fetch(ref.link);
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    // Matches the inbound ceiling the other adapters use: a webhook is not the
    // place to discover somebody sent a 300MB file.
    if (data.byteLength > 32 * 1024 * 1024) return null;
    return {
      data,
      mimeType: ref.mimeType || res.headers.get('content-type') || 'application/octet-stream',
      filename: ref.filename ?? null,
    };
  },

  async markRead() { throw new NotSupportedError(WHATSMARKETING_PROVIDER, 'markRead'); },

  async getMessageStatus(providerMessageId: string): Promise<MessageDeliveryState> {
    /*
      Their live console takes the message id alone. The PDF also asked for a
      `whatsapp_bot_id`, and requiring it meant every tick read "unknown" for
      anyone who had not hunted down a Bot ID that their own console does not
      ask for. Sending it anyway when it is configured costs nothing.
    */
    const c = conf();
    if (!c) return 'unknown';
    try {
      const answer = await call('/whatsapp/get/message-status', {
        wa_message_id: providerMessageId,
        ...(c.botId ? { whatsapp_bot_id: c.botId } : {}),
      });
      const state = String(
        (answer.message as Record<string, unknown> | undefined)?.message_status ?? '',
      ).toLowerCase();
      return (['sent', 'delivered', 'read', 'failed'] as const)
        .find((s) => s === state) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  },

  async syncSupportedHistory() { throw new NotSupportedError(WHATSMARKETING_PROVIDER, 'historySync'); },

  verifyWebhook(request: WebhookRequest): WebhookVerification {
    /*
      A shared token, because their documentation describes no signature — and
      an unauthenticated webhook is an open door into the team's conversations.
      This CRM has shipped one of those before (the telephony webhooks, closed
      on 30 August), so an unconfigured token refuses rather than waves through.
    */
    const secret = getIntegrationCredentials(WHATSMARKETING_PROVIDER)?.webhookToken;
    if (!secret) return { ok: false, reason: 'no-webhook-token' };
    const given = request.headers['x-webhook-token']
      ?? request.headers['x-api-key']
      ?? request.query.token;
    if (!given || given.length !== secret.length) return { ok: false, reason: 'bad-webhook-token' };
    // Constant time, so the answer cannot be guessed a character at a time.
    let same = 0;
    for (let i = 0; i < secret.length; i += 1) same |= secret.charCodeAt(i) ^ given.charCodeAt(i);
    return same === 0 ? { ok: true } : { ok: false, reason: 'bad-webhook-token' };
  },

  parseWebhook(body: unknown): WebhookBatch {
    return parseWhatsMarketingWebhook(body);
  },

  async testConnection() {
    /*
      The token is checkable on its own, and checking it on its own is the
      whole point. Their Phone Number ID lives on a different page of their
      dashboard from the key, so somebody pasting the key first and pressing
      Test deserves "your key works, now I need the other thing" rather than a
      flat refusal that tells them nothing about the half they have done.
    */
    const creds = getIntegrationCredentials(WHATSMARKETING_PROVIDER);
    const token = creds?.apiToken ?? '';
    if (!token) return { ok: false, detail: 'Add the WhatsMarketing API token first.' };

    const base = (getIntegrationConfig(WHATSMARKETING_PROVIDER)?.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    if (!getIntegrationConfig(WHATSMARKETING_PROVIDER)?.phoneNumberId) {
      try {
        const res = await fetch(`${base}/user/package/list`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ apiToken: token }).toString(),
        });
        const parsed = JSON.parse(await res.text()) as Record<string, unknown>;
        return String(parsed.status) === '1'
          ? {
            ok: false,
            detail: 'Your API token works. Now add the Phone Number ID — WhatsMarketing → '
              + 'Connect Account → click your WhatsApp number → copy "Phone Number ID".',
          }
          : { ok: false, detail: String(parsed.message ?? 'WhatsMarketing did not accept that token.') };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    }

    const c = conf();
    if (!c) return { ok: false, detail: 'Add the API token and Phone Number ID first.' };
    /*
      Their documented credential check, and it costs nothing: §2 Step 3 of
      their guide uses this exact call to prove a token works. A GET with the
      token on the query string, which is the one endpoint of theirs that is
      not a form POST.
    */
    try {
      const res = await fetch(
        `${c.baseUrl}/user/myInfo?apiToken=${encodeURIComponent(c.apiToken)}`,
      );
      const text = await res.text();
      if (!res.ok) return { ok: false, detail: `WhatsMarketing refused that (HTTP ${res.status}).` };
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* below */ }
      if (String(parsed.status) !== '1') {
        return { ok: false, detail: String(parsed.message ?? 'WhatsMarketing did not accept the token.') };
      }
      return { ok: true, detail: 'WhatsMarketing accepted the token.' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  },
};

/**
 * Their delivery, in the CRM's own words — and loud when it is neither shape.
 *
 * Exported for its test. Their documentation has **no inbound webhook section
 * at all**, so rather than inventing a callback body this reads the two shapes
 * that can be recognised without guessing:
 *
 *  * the Meta Cloud shape, in case they pass Meta's own callback through, as
 *    several resellers do; and
 *  * a flat object using the parameter names their *sending* API already uses
 *    — `phone_number`, `message`, `wa_message_id` — since a vendor's callback
 *    almost always reuses its own vocabulary.
 *
 * Anything else returns empty **and is logged with the body**. That is the
 * point: an unrecognised delivery becomes a fact somebody can read and fix in
 * one go, instead of a customer's message quietly never arriving. Dropping it
 * silently is the failure mode this codebase keeps meeting.
 */
export function parseWhatsMarketingWebhook(body: unknown): WebhookBatch {
  const empty: WebhookBatch = { messages: [], statuses: [] };
  if (!body || typeof body !== 'object') return empty;
  const root = body as Record<string, unknown>;

  // Meta's own shape, recognised by its envelope rather than by hope.
  if (root.object === 'whatsapp_business_account' || Array.isArray(root.entry)) {
    return empty; // handled by the Meta adapter's route, not this one
  }

  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];

  const rows: Record<string, unknown>[] = Array.isArray(root.messages)
    ? root.messages as Record<string, unknown>[]
    : [root];

  for (const row of rows) {
    const id = String(row.wa_message_id ?? row.message_id ?? row.id ?? '');
    const from = String(row.phone_number ?? row.from ?? row.sender ?? '').replace(/\D/g, '');

    // A status update names a state; a message carries text or media.
    const state = String(row.message_status ?? row.status_type ?? '').toLowerCase();
    if (id && ['sent', 'delivered', 'read', 'failed'].includes(state)) {
      statuses.push({
        providerMessageId: id,
        state: state as StatusUpdate['state'],
        at: readDate(row.delivery_status_updated_at ?? row.timestamp),
        error: row.failed_reason ? String(row.failed_reason) : null,
      });
      continue;
    }

    if (!from) continue;
    const link = row.media_url ? String(row.media_url) : undefined;
    const type = String(row.media_type ?? row.type ?? (link ? 'other' : 'text')).toLowerCase();
    messages.push({
      providerMessageId: id || `wm-${from}-${Date.now()}`,
      from,
      to: row.phone_number_id ? String(row.phone_number_id) : null,
      type: (['text', 'image', 'document', 'audio', 'video', 'location'] as const)
        .find((t) => t === type) ?? (link ? 'other' : 'text'),
      text: row.message ? String(row.message) : (row.text ? String(row.text) : null),
      media: link
        ? { link, mimeType: row.mime_type ? String(row.mime_type) : undefined,
          caption: row.media_caption_text ? String(row.media_caption_text) : undefined }
        : null,
      sentAt: readDate(row.timestamp ?? row.created_at),
      profileName: row.name ? String(row.name) : (row.first_name ? String(row.first_name) : null),
    });
  }

  if (!messages.length && !statuses.length) {
    logger.warn(
      { body: JSON.stringify(body).slice(0, 2000) },
      'whatsmarketing webhook in a shape this adapter does not recognise — nothing was stored',
    );
  }
  return { messages, statuses };
}

/** Their timestamps are "2026-07-08 13:21:03" or epoch seconds, per the docs. */
function readDate(raw: unknown): Date {
  if (typeof raw === 'number') return new Date(raw * 1000);
  if (typeof raw === 'string' && raw) {
    // A space instead of a T is valid in their examples and invalid to `Date`
    // in some runtimes, so it is normalised rather than trusted.
    const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}
