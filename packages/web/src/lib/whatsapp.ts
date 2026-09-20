/**
 * The WhatsApp decisions that are not UI, kept where they can be proved.
 *
 * They live here rather than in the components because a component that
 * imports the app's store cannot be loaded by a `node` test at all — the store
 * reads `localStorage` as it is constructed. A rule worth a test is a rule
 * worth its own file.
 */

/** Digits only — a handle is matched on digits, never on the spacing a screen adds. */
export function waDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * Which control the WhatsApp composer offers, and why.
 *
 * Two independent facts decide it, and getting either wrong means a rep types
 * a paragraph WhatsApp will not carry:
 *
 *  * **The 24-hour window.** WhatsApp allows a free reply only for a day after
 *    the customer last wrote. After that, an approved template or nothing.
 *  * **What the live provider can do at all.** AiSensy's API sends approved
 *    templates and nothing else, window or no window, so a message box there
 *    would fail on every send.
 *
 * Kept out of the component so it can be proved without a browser — it is one
 * line of UI and the two rules behind it are the whole feature.
 */
export type ComposerMode = 'text' | 'template';

export function composerMode(capabilities: string[], windowOpen: boolean): ComposerMode {
  return capabilities.includes('text') && windowOpen ? 'text' : 'template';
}

/** What to say about a shut box, which is different in the two cases above. */
export function whyNoTextBox(capabilities: string[], providerName: string | null): string {
  return capabilities.includes('text')
    ? 'WhatsApp only carries a free reply for 24 hours after the customer last wrote, and that has passed. An approved template can still go.'
    : `${providerName ?? 'This provider'} sends approved templates only.`;
}

export interface MessageMedia {
  attachmentId?: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  /** What a customer typed under the picture. Rendered as the message body. */
  caption?: string;
}

/** `media` off a message row, which is loose JSON until it is read. */
export function readMessageMedia(value: unknown): MessageMedia | null {
  if (!value || typeof value !== 'object') return null;
  const media = value as MessageMedia;
  // No attachment id means the file never made it into the CRM — an inbound
  // collection that failed, or an old row from before this existed. Showing
  // the vendor's link instead would be a square that breaks silently later.
  return media.attachmentId ? media : null;
}

/**
 * A number a person can read, from a matching key that is not one.
 *
 * `ipy_conversation.handle` is the last ten digits — deliberately, because it
 * is what matches a contact however their mobile is stored. Printing it with a
 * `+` in front produced **`+9811533633`** on the Chats header: a plus sign
 * glued to a number that has no country code, which is not any number in the
 * world. `wa_id` is WhatsApp's own full id and is what to show when there is
 * one; without it the ten digits stand alone, unprefixed, rather than
 * pretending to a country code nobody knows.
 */
export function displayNumber(handle: string, waId?: string | null): string {
  const full = (waId ?? '').replace(/\D/g, '');
  if (full.length > 10) return `+${full.slice(0, full.length - 10)} ${full.slice(-10)}`;
  return handle;
}

/** The bubble's colour: a refused message must never look delivered. */
export function outboundTone(status: string): string {
  if (status === 'failed') return 'bg-rose-600';
  if (status === 'queued') return 'bg-emerald-600/60';
  return 'bg-emerald-600';
}

/** What became of it, in a person's words rather than a column value. */
export function wentOut(status: string): string {
  const said: Record<string, string> = {
    queued: 'sending', sent: 'sent', delivered: 'delivered', read: 'read',
  };
  return said[status] ?? status;
}

/** Where the WhatsApp page lives. Every link is built from it — see `tabHref`. */
export const WHATSAPP_BASE = '/whatsapp';

/**
 * A tab's address, **absolute, always**.
 *
 * `to="chats"` inside a route matched as `/whatsapp/*` does not resolve
 * against `/whatsapp` — it resolves against the *whole current pathname*. So
 * one click went to `/whatsapp/chats`, the next to
 * `/whatsapp/chats/campaigns`, and the catch-all redirect appended `chats`
 * again on every render until the address bar held a hundred of them and the
 * page rendered nothing at all. Live for about an hour on 20 September, found
 * by the owner clicking Campaigns once.
 *
 * **It lives here rather than beside the page on purpose.** A module that
 * imports the app's store cannot be loaded by a `node` test at all — the store
 * reads `localStorage` as it is constructed — and this repo has already paid
 * for that once, when pulling `waDigits` out of a component broke an unrelated
 * suite. A rule worth a test has to live where a test can reach it.
 */
export function tabHref(path: string): string {
  return `${WHATSAPP_BASE}/${path}`;
}
