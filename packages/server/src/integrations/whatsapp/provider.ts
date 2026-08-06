/**
 * WhatsApp provider — Meta Cloud API.
 *
 * Kept behind a narrow interface so a different BSP (Gupshup, 360dialog, Twilio)
 * can be dropped in without touching the conversation service. When no
 * credentials are configured the provider runs in "log" mode: messages are
 * recorded in the CRM and marked sent, so the whole product is demoable and
 * testable without a Meta account.
 */
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { IntegrationError } from '../../utils/errors.js';
import { db } from '../../db/pool.js';

export interface SendTextInput {
  to: string;
  text: string;
  previewUrl?: boolean;
}

export interface SendTemplateInput {
  to: string;
  templateName: string;
  language?: string;
  /** ordered body variables, {{1}}, {{2}}, … */
  bodyParams?: string[];
  headerParam?: string;
  headerType?: 'text' | 'image' | 'document' | 'video';
  buttonParams?: string[];
}

export interface SendMediaInput {
  to: string;
  type: 'image' | 'document' | 'audio' | 'video';
  link: string;
  caption?: string;
  filename?: string;
}

export interface SendInteractiveInput {
  to: string;
  bodyText: string;
  buttons: { id: string; title: string }[];
  headerText?: string;
  footerText?: string;
}

export interface SendResult {
  providerMessageId: string | null;
  status: 'sent' | 'failed';
  error?: string;
  simulated?: boolean;
}

interface Credentials {
  phoneNumberId: string;
  accessToken: string;
  apiVersion: string;
  businessAccountId?: string;
}

/**
 * Credentials come from the integrations table first (so they're editable in
 * the admin panel) and fall back to environment variables.
 */
async function getCredentials(): Promise<Credentials | null> {
  const row = await db.queryOne<{ config: Record<string, string>; credentials: Record<string, string>; is_active: boolean }>(
    `SELECT config, credentials, is_active FROM ipy_integration WHERE provider = 'meta_whatsapp' LIMIT 1`,
  );

  const phoneNumberId = row?.credentials?.phoneNumberId || config.whatsapp.phoneNumberId;
  const accessToken = row?.credentials?.accessToken || config.whatsapp.accessToken;

  if (!phoneNumberId || !accessToken) return null;
  if (row && row.is_active === false) return null;

  return {
    phoneNumberId,
    accessToken,
    apiVersion: row?.config?.apiVersion || config.whatsapp.apiVersion,
    businessAccountId: row?.credentials?.businessAccountId || config.whatsapp.businessAccountId,
  };
}

export async function isConfigured(): Promise<boolean> {
  return (await getCredentials()) !== null;
}

async function post(payload: Record<string, unknown>): Promise<SendResult> {
  const creds = await getCredentials();

  if (!creds) {
    // Simulation mode — the CRM still records the message so flows are testable.
    logger.info({ payload }, '[whatsapp:simulated] no credentials configured; message logged only');
    return { providerMessageId: `sim_${crypto.randomUUID()}`, status: 'sent', simulated: true };
  }

  const url = `https://graph.facebook.com/${creds.apiVersion}/${creds.phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      signal: AbortSignal.timeout(20_000),
    });

    const body = await res.json().catch(() => ({})) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };

    if (!res.ok) {
      const message = body.error?.error_data?.details ?? body.error?.message ?? `HTTP ${res.status}`;
      logger.error({ status: res.status, error: body.error }, 'whatsapp send failed');
      return { providerMessageId: null, status: 'failed', error: message };
    }

    return { providerMessageId: body.messages?.[0]?.id ?? null, status: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'whatsapp request failed');
    return { providerMessageId: null, status: 'failed', error: message };
  }
}

export async function sendText(input: SendTextInput): Promise<SendResult> {
  return post({
    recipient_type: 'individual',
    to: normalise(input.to),
    type: 'text',
    text: { preview_url: input.previewUrl ?? true, body: input.text },
  });
}

export async function sendTemplate(input: SendTemplateInput): Promise<SendResult> {
  const components: Record<string, unknown>[] = [];

  if (input.headerParam) {
    const type = input.headerType ?? 'text';
    components.push({
      type: 'header',
      parameters: [
        type === 'text'
          ? { type: 'text', text: input.headerParam }
          : { type, [type]: { link: input.headerParam } },
      ],
    });
  }

  if (input.bodyParams?.length) {
    components.push({
      type: 'body',
      parameters: input.bodyParams.map((text) => ({ type: 'text', text })),
    });
  }

  input.buttonParams?.forEach((param, index) => {
    components.push({
      type: 'button', sub_type: 'url', index: String(index),
      parameters: [{ type: 'text', text: param }],
    });
  });

  return post({
    to: normalise(input.to),
    type: 'template',
    template: {
      name: input.templateName,
      language: { code: input.language ?? 'en' },
      ...(components.length ? { components } : {}),
    },
  });
}

export async function sendMedia(input: SendMediaInput): Promise<SendResult> {
  return post({
    to: normalise(input.to),
    type: input.type,
    [input.type]: {
      link: input.link,
      ...(input.caption ? { caption: input.caption } : {}),
      ...(input.filename && input.type === 'document' ? { filename: input.filename } : {}),
    },
  });
}

/** Quick-reply buttons — the highest-response-rate format for follow-ups. */
export async function sendInteractive(input: SendInteractiveInput): Promise<SendResult> {
  return post({
    to: normalise(input.to),
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(input.headerText ? { header: { type: 'text', text: input.headerText } } : {}),
      body: { text: input.bodyText },
      ...(input.footerText ? { footer: { text: input.footerText } } : {}),
      action: {
        buttons: input.buttons.slice(0, 3).map((b) => ({
          type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

export async function markRead(providerMessageId: string): Promise<void> {
  const creds = await getCredentials();
  if (!creds) return;
  await post({ status: 'read', message_id: providerMessageId }).catch(() => undefined);
}

/** Download an inbound media file and return a data reference. */
export async function fetchMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string } | null> {
  const creds = await getCredentials();
  if (!creds) return null;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${creds.apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const meta = await metaRes.json() as { url?: string; mime_type?: string };
    if (!meta.url) return null;
    return { url: meta.url, mimeType: meta.mime_type ?? 'application/octet-stream' };
  } catch (err) {
    logger.error({ err, mediaId }, 'failed to resolve whatsapp media');
    return null;
  }
}

/** Pull the approved template list from Meta into the local catalogue. */
export async function syncTemplates(): Promise<{ synced: number }> {
  const creds = await getCredentials();
  if (!creds?.businessAccountId) {
    throw new IntegrationError('whatsapp', 'A WhatsApp Business Account ID is required to sync templates');
  }

  const url = `https://graph.facebook.com/${creds.apiVersion}/${creds.businessAccountId}/message_templates?limit=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
  if (!res.ok) throw new IntegrationError('whatsapp', `Template sync failed (HTTP ${res.status})`);

  const body = await res.json() as {
    data?: {
      name: string; language: string; category: string; status: string; id: string;
      components?: { type: string; format?: string; text?: string; buttons?: { type: string; text: string; url?: string }[] }[];
    }[];
  };

  let synced = 0;
  for (const t of body.data ?? []) {
    const header = t.components?.find((c) => c.type === 'HEADER');
    const bodyComp = t.components?.find((c) => c.type === 'BODY');
    const footer = t.components?.find((c) => c.type === 'FOOTER');
    const buttons = t.components?.find((c) => c.type === 'BUTTONS')?.buttons ?? [];

    await db.query(
      `INSERT INTO ipy_whatsapp_template
        (name, language, category, status, header_format, header_text, body_text, footer_text, buttons, provider_template_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (name, language) DO UPDATE SET
         category = EXCLUDED.category, status = EXCLUDED.status,
         header_format = EXCLUDED.header_format, header_text = EXCLUDED.header_text,
         body_text = EXCLUDED.body_text, footer_text = EXCLUDED.footer_text,
         buttons = EXCLUDED.buttons, provider_template_id = EXCLUDED.provider_template_id`,
      [
        t.name, t.language, t.category, t.status,
        header?.format ?? null, header?.text ?? null,
        bodyComp?.text ?? '', footer?.text ?? null,
        JSON.stringify(buttons), t.id,
      ],
    );
    synced++;
  }

  await db.query(
    `UPDATE ipy_integration SET last_sync_at = now(), status = 'connected', last_error = NULL
     WHERE provider = 'meta_whatsapp'`,
  );
  return { synced };
}

/** Verify Meta's X-Hub-Signature-256 header before trusting a webhook body. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = config.whatsapp.appSecret;
  // Without a configured secret we cannot verify; allow only outside production.
  if (!secret) return !config.isProd;
  if (!signature?.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.slice(7);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function normalise(phone: string): string {
  // Meta expects digits only, country code included, no leading +.
  return phone.replace(/[^\d]/g, '');
}
