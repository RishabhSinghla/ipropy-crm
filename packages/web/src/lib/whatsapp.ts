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
 *  * **What the live provider can do at all.** Some providers' APIs send approved
 *    templates and nothing else, window or no window, so a message box there
 *    would fail on every send.
 *
 * Kept out of the component so it can be proved without a browser — it is one
 * line of UI and the two rules behind it are the whole feature.
 */
export type ComposerMode = 'text' | 'template';

export function composerMode(capabilities: string[], windowOpen: boolean): ComposerMode {
  // A linked device (OpenWA) is an ordinary chat, so there is no 24-hour window
  // to wait out; the server enforces its own brakes instead.
  return capabilities.includes('text') && (windowOpen || capabilities.includes('linkedDevice'))
    ? 'text'
    : 'template';
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
  /** Linked-device messages keep only this much until somebody asks for the file. */
  sizeBytes?: number;
  filename?: string;
}

/**
 * A file OpenWA told us about but the CRM has not fetched: type, name, size.
 * Shown as a chip with a Load button — fetched only when somebody asks.
 */
export function readRemoteFile(value: unknown): { mimeType: string; fileName: string; sizeBytes?: number } | null {
  if (!value || typeof value !== 'object') return null;
  const media = value as MessageMedia;
  if (media.attachmentId) return null;
  const mimeType = media.mimeType;
  if (!mimeType) return null;
  return { mimeType, fileName: media.fileName ?? media.filename ?? 'file', sizeBytes: media.sizeBytes ?? media.size };
}

/**
 * The little ticks under a sent message: one for sent, two for delivered, two
 * (blue, drawn by the caller) for read. A refused message gets none.
 */
export function ticks(status: string): { marks: string; read: boolean } {
  if (status === 'read') return { marks: '✓✓', read: true };
  if (status === 'delivered') return { marks: '✓✓', read: false };
  if (status === 'sent') return { marks: '✓', read: false };
  return { marks: '', read: false };
}

/** Plain words for the banner above the chat when the OpenWA link is not healthy. */
export function linkBanner(link: { state: string; message: string; pausedUntil?: string | null } | null | undefined): string | null {
  // Linked and well, but OpenWA's daily allowance for a new number is used up: say
  // when it comes back rather than let people press Send and meet a refusal.
  if (link?.pausedUntil && Date.parse(link.pausedUntil) > Date.now()) {
    const back = new Date(link.pausedUntil).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short' });
    return `Chat sending is paused until about ${back}: this newly linked number has reached today's allowance, a protection that grows every day. Customer messages still arrive.`;
  }
  if (!link || link.state === 'ready' || link.state === 'unknown') return null;
  return link.state === 'unreachable'
    ? `The CRM cannot reach OpenWA, so messages can't be sent or received right now. ${link.message}`
    : `${link.message}`;
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
 * `+` in front produced **`+9000010000`** on the Chats header: a plus sign
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
export function tabHref(path: string, base: string = WHATSAPP_BASE): string {
  return `${base}/${path}`;
}

/** The admin-only screen for the official API, beside the ordinary WhatsApp one. */
export const WHATSAPP_API_BASE = '/whatsapp-api';

/**
 * The day a message belongs to, as WhatsApp labels it.
 *
 * Every bubble used to carry its own full date — "20 Sept, 03:42 pm" on each
 * of forty messages sent the same afternoon. WhatsApp prints the date once, as
 * a chip down the middle, and leaves the clock on the bubble; that is both the
 * familiar shape and the readable one.
 *
 * Compared by calendar day in the reader's own timezone, not by hours elapsed:
 * a message at 11pm and one at 1am are different days however close they are.
 */
export function dayLabel(at: string | Date, now: Date = new Date()): string {
  const when = at instanceof Date ? at : new Date(at);
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(when)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  /*
    The weekday *and* the date. "Monday" alone left the reader counting back
    through the week — 25 September 2026, the owner: *"you have written Monday
    there but I need to see date also alongside of it."*
  */
  if (days > 1 && days < 7) {
    const weekday = when.toLocaleDateString('en-IN', { weekday: 'long' });
    const date = when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    return `${weekday}, ${date}`;
  }
  return when.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', ...(when.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** The clock on a bubble. The date is the chip above it, not on every line. */
export function bubbleTime(at: string | Date): string {
  const when = at instanceof Date ? at : new Date(at);
  return when.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * How long WhatsApp's 24-hour reply window has left, as the queue shows it.
 *
 * Open: the hours left ("18h"), or minutes in the last hour ("45m"), so a rep
 * can see who has to be answered first. Shut: "Exp", meaning only an approved
 * template can start the conversation again.
 *
 * Rounded **down**. A window with 18h 50m left reads "18h", never "19h" —
 * promising a rep time the customer has not given is how a reply lands one
 * minute too late and gets refused.
 */
export function windowLeft(expiresAt: string | null | undefined, now: Date = new Date()): {
  open: boolean; label: string;
} {
  const ends = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const left = ends - now.getTime();
  if (!Number.isFinite(left) || left <= 0) return { open: false, label: 'Exp' };
  const minutes = Math.floor(left / 60_000);
  if (minutes < 60) return { open: true, label: `${Math.max(minutes, 1)}m` };
  return { open: true, label: `${Math.floor(minutes / 60)}h` };
}

/**
 * The two- or three-letter tag on a chat saying which module its record is in.
 *
 * Read from the module's own `shortLabel` — LD and INV, set as data in
 * migration 170 — so no module is named in the screen. A module an admin adds
 * later, with no short label of its own, gets the first three letters of its
 * name rather than nothing.
 */
export function moduleTag(meta: { label: string; settings?: Record<string, unknown> } | undefined): string | null {
  if (!meta) return null;
  const own = meta.settings?.shortLabel;
  if (typeof own === 'string' && own.trim()) return own.trim().toUpperCase();
  return meta.label.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || null;
}

/**
 * The four kinds of bubble in a contact's merged WhatsApp thread. Which one a
 * message is comes from the route it used (the official API vs the company
 * phone) and its direction. Plain steps only (no opacity modifiers: those
 * compile to nothing on this repo's var()-based colours).
 */
export type BubbleKind = 'api-out' | 'api-in' | 'chat-out' | 'chat-in';

export function bubbleKind(m: { direction: string; viaApi: boolean }): BubbleKind {
  if (m.viaApi) return m.direction === 'outbound' ? 'api-out' : 'api-in';
  return m.direction === 'outbound' ? 'chat-out' : 'chat-in';
}

export const BUBBLE_STYLE: Record<BubbleKind, { label: string; bubble: string; chip: string }> = {
  'api-out': {
    label: 'API · sent by CRM',
    bubble: 'border-indigo-300 bg-indigo-100 text-indigo-950 dark:border-indigo-700 dark:bg-indigo-900 dark:text-indigo-50',
    chip: 'bg-indigo-200 text-indigo-900 dark:bg-indigo-800 dark:text-indigo-100',
  },
  'api-in': {
    label: 'API · received',
    bubble: 'border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-50',
    chip: 'bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100',
  },
  'chat-out': {
    label: 'Chat · sent by us',
    bubble: 'border-emerald-300 bg-emerald-100 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-900 dark:text-emerald-50',
    chip: 'bg-emerald-200 text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100',
  },
  'chat-in': {
    label: 'Chat · received',
    bubble: 'border-sky-300 bg-sky-100 text-sky-950 dark:border-sky-700 dark:bg-sky-900 dark:text-sky-50',
    chip: 'bg-sky-200 text-sky-900 dark:bg-sky-800 dark:text-sky-100',
  },
};

/**
 * The ONE status chip on a chat-list row. Plain chat shows where the reply window
 * stands; the API inbox shows how the last automatic send went. Priority: failed,
 * then nobody has picked it up, then the window or the delivery state.
 */
export type RowChip = { text: string; tone: 'red' | 'amber' | 'green' | 'blue' | 'grey' };

export function rowChip(
  row: { lastDirection: string | null; lastStatus: string | null; unreadCount: number; assignedName: string | null; windowExpiresAt: string | null },
  api: boolean,
  now: Date = new Date(),
): RowChip | null {
  if (!row.lastDirection) return null;
  const lastOut = row.lastDirection === 'outbound';
  if (lastOut && row.lastStatus === 'failed') return { text: 'Failed', tone: 'red' };
  if (api) {
    if (!lastOut) return { text: 'Replied · needs a person', tone: 'amber' };
    if (row.lastStatus === 'read') return { text: 'Read', tone: 'green' };
    if (row.lastStatus === 'delivered') return { text: 'Delivered', tone: 'blue' };
    return { text: 'Sent', tone: 'grey' };
  }
  const win = windowLeft(row.windowExpiresAt, now);
  if (!lastOut && !row.assignedName) return { text: 'Needs a reply · unassigned', tone: 'amber' };
  if (!win.open) return { text: 'Reply window closed', tone: 'grey' };
  return { text: `Reply window open · ${win.label} left`, tone: 'green' };
}

/**
 * The small line on a bubble saying which of our numbers carried it, and who sent it.
 * Sent: "from yogesh-phone · +91 98xx". Received: "to iPropy Floors · +91 98217 72933".
 * Null when the server does not know (old messages) so nothing wrong is claimed.
 */
export function senderLine(m: {
  direction: string; numberName?: string | null; numberPhone?: string | null; sentByName?: string | null;
}): string | null {
  const number = [m.numberName, m.numberPhone].filter(Boolean).join(' · ');
  const who = m.direction === 'outbound' && m.sentByName ? `by ${m.sentByName}` : '';
  if (!number && !who) return null;
  const via = number ? `${m.direction === 'outbound' ? 'from' : 'to'} ${number}` : '';
  return [via, who].filter(Boolean).join(' · ');
}
