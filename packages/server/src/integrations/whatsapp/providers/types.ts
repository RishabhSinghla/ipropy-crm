/**
 * One shape for every way this CRM can reach WhatsApp.
 *
 * There are two, and they are not interchangeable. Meta's Cloud API sends from
 * one approved business number and can send templates outside the 24-hour
 * window; a linked-device session sends from a person's own number and cannot.
 * Code that hard-codes either one has to be rewritten when the business
 * changes its mind — which has already happened once here (migration 060
 * removed a linked-device connector; migration 149 began another).
 *
 * So callers ask a provider what it can do rather than assuming. A capability
 * it does not have is refused loudly with `NotSupportedError`: a send that
 * quietly does nothing is the failure mode this whole file exists to prevent,
 * and it is exactly how 40,000 birthday messages queued unnoticed.
 */

export type WhatsAppCapability =
  /** Plain text to a handle. Every provider has this or it is not a provider. */
  | 'text'
  /** Images, documents, audio, video by link or upload. */
  | 'media'
  /** A pin somebody can open in their map app. */
  | 'location'
  /** Pre-approved templates, the only thing Meta allows outside 24 hours. */
  | 'templates'
  /** Telling the other side their message was read. */
  | 'markRead'
  /** Sent / delivered / read coming back for a message already sent. */
  | 'messageStatus'
  /** Reading conversations that happened before the account was linked. */
  | 'historySync'
  /** One linked account per agent, rather than one number for the business. */
  | 'perAgentAccounts';

export type WhatsAppConnectionStatus =
  | 'disconnected' | 'connecting' | 'qr' | 'pairing' | 'connected' | 'error';

/** What a provider hands back about one linked account. */
export interface WhatsAppAccountState {
  id: string;
  label: string;
  phoneNumber: string | null;
  displayName: string | null;
  status: WhatsAppConnectionStatus;
  /** The CRM user this account sends as, when the provider has per-agent accounts. */
  userId: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
}

export interface SendTextRequest {
  accountId: string | null;
  to: string;
  text: string;
}

export interface SendMediaRequest {
  accountId: string | null;
  to: string;
  type: 'image' | 'document' | 'audio' | 'video';
  link: string;
  caption?: string;
  filename?: string;
}

export interface SendOutcome {
  providerMessageId: string;
  status: 'sent' | 'queued';
}

export type MessageDeliveryState = 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';

/**
 * A capability the chosen provider does not have.
 *
 * Its own class so a caller can tell "WhatsApp is not set up" from "this
 * provider cannot do that" from "the network failed", and so the UI can hide a
 * control rather than offering one that always errors.
 */
export class NotSupportedError extends Error {
  readonly capability: WhatsAppCapability;
  readonly provider: string;

  constructor(provider: string, capability: WhatsAppCapability) {
    super(`The ${provider} WhatsApp connection cannot do "${capability}".`);
    this.name = 'NotSupportedError';
    this.provider = provider;
    this.capability = capability;
  }
}

/**
 * What every WhatsApp connection must offer.
 *
 * Deliberately small. Anything a single provider can do and the other cannot —
 * QR codes, pairing codes, template syncing — stays on that provider's own
 * module, reached through `capabilities` rather than through a method every
 * implementation has to stub out.
 */
export interface WhatsAppProvider {
  readonly name: string;
  readonly capabilities: ReadonlySet<WhatsAppCapability>;

  /** Whether this provider has what it needs to send anything at all. */
  isConfigured(): Promise<boolean>;

  /** The accounts this provider holds. One for Cloud; one per agent for Web. */
  listAccounts(): Promise<WhatsAppAccountState[]>;

  getConnectionStatus(accountId: string | null): Promise<WhatsAppConnectionStatus>;

  connectAccount(accountId: string): Promise<void>;
  disconnectAccount(accountId: string): Promise<void>;

  sendMessage(request: SendTextRequest): Promise<SendOutcome>;
  sendMedia(request: SendMediaRequest): Promise<SendOutcome>;

  markRead(providerMessageId: string, accountId: string | null): Promise<void>;
  getMessageStatus(providerMessageId: string): Promise<MessageDeliveryState>;

  /** Conversations from before linking, where the provider allows it. */
  syncSupportedHistory(accountId: string): Promise<{ conversations: number; messages: number }>;
}

/** Guard for a capability, so every provider refuses the same way. */
export function requireCapability(provider: WhatsAppProvider, capability: WhatsAppCapability): void {
  if (!provider.capabilities.has(capability)) throw new NotSupportedError(provider.name, capability);
}
