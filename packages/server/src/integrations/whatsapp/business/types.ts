/**
 * The official WhatsApp Business route, as one contract with many adapters.
 *
 * Four services can carry it — AiSensy, Gupshup, whatsmarketing.in and Meta's
 * own Cloud API — and the business will change its mind at least once. So the
 * CRM talks to this interface and never to a vendor: swapping AiSensy for
 * Gupshup is a row in `ipy_integration`, not a rewrite, and the conversation
 * history stays because it was never the vendor's to hold.
 *
 * It extends the same `WhatsAppProvider` the agent-linked route implements
 * rather than starting a second vocabulary. The two routes are different
 * things — one business number shared by the team, against one number per rep
 * — and they stay separate on purpose (the owner's §13). What they share is
 * how a caller asks "can you do this?" and how a provider refuses.
 */
import type { SendOutcome, WhatsAppProvider } from '../providers/types.js';

/**
 * One message arriving from a customer, in the CRM's own words.
 *
 * Every adapter translates its provider's webhook into this, so the code that
 * matches a contact, writes the conversation and pings the agent is written
 * once and never learns a vendor's field names.
 */
export interface InboundMessage {
  /** The provider's id for this message. The CRM's own id is separate, always. */
  providerMessageId: string;
  /** The customer's number, digits as the provider gave them. */
  from: string;
  /** The business number it arrived on, when the provider says. */
  to: string | null;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'other';
  text: string | null;
  /** A link the CRM can fetch, or an id it must exchange for one. */
  media: { link?: string; id?: string; mimeType?: string; filename?: string; caption?: string } | null;
  /** When the customer sent it, not when the webhook arrived. */
  sentAt: Date;
  /** The customer's WhatsApp profile name, where the provider passes it on. */
  profileName: string | null;
}

/** Sent → delivered → read, or failed, for something already sent. */
export interface StatusUpdate {
  providerMessageId: string;
  state: 'sent' | 'delivered' | 'read' | 'failed';
  at: Date;
  error: string | null;
}

/** What one webhook delivery amounts to once the vendor's shape is stripped off. */
export interface WebhookBatch {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export interface SendTemplateRequest {
  to: string;
  templateName: string;
  language: string;
  /** Positional, because WhatsApp templates are positional: {{1}}, {{2}}… */
  params: string[];
  /** A header image or document, where the template has one. */
  headerMedia?: { link: string; filename?: string } | null;
}

export interface TemplateSummary {
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string | null;
  /** How many {{n}} the body carries, so the mapping screen cannot under-fill it. */
  variableCount: number;
  providerTemplateId: string | null;
}

/** What the CRM hands a provider to check a webhook it did not expect. */
export interface WebhookRequest {
  method: 'GET' | 'POST';
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  /** The body exactly as it arrived, which is what a signature is over. */
  rawBody: string;
}

export interface WebhookVerification {
  ok: boolean;
  /** Meta's subscription handshake answers its own challenge back in plain text. */
  challenge?: string;
  reason?: string;
}

export interface WhatsAppBusinessProvider extends WhatsAppProvider {
  readonly kind: 'business';
  /** The business number this connection sends from, once it is configured. */
  businessNumber(): Promise<string | null>;

  sendTemplate(request: SendTemplateRequest): Promise<SendOutcome>;
  listTemplates(): Promise<TemplateSummary[]>;

  /**
   * Is this webhook really from the provider?
   *
   * Every adapter answers for itself because they disagree: Meta signs the
   * body with an app secret and answers a subscription challenge on GET, the
   * resellers mostly carry a shared token. A webhook that authenticates nobody
   * is an open door into the CRM's conversations, and this CRM has shipped one
   * of those before — the telephony webhooks, closed on 30 August.
   */
  verifyWebhook(request: WebhookRequest): WebhookVerification;

  /** The vendor's delivery, in the CRM's own words. */
  parseWebhook(body: unknown): WebhookBatch;

  /** A cheap call that proves the credentials work, for the Test button. */
  testConnection(): Promise<{ ok: boolean; detail: string }>;
}
