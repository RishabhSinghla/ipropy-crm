/**
 * Fetch WhatsMarketing's replies, because they do not push them.
 *
 * WhatsMarketing publish no self-serve webhook — not in their PDF, not in
 * their developer console — and their §17 says delivery callbacks need their
 * support team. Without inbound the CRM does not merely miss replies; it is
 * **blocked from sending at all**, and that surprised everybody including the
 * person who built it:
 *
 *   WhatsApp carries a freely typed message only for 24 hours after the
 *   customer last wrote. The CRM works that window out from its own record of
 *   the last inbound message. With nothing ever arriving, `window_expires_at`
 *   is never set, so every conversation reads as permanently shut — the
 *   composer offers only templates and `sendOnBusinessNumber` refuses the
 *   send. A customer can message the business number and the rep still cannot
 *   reply. That is what this exists to fix.
 *
 * So the CRM asks instead. Their `/whatsapp/subscriber/list` names who wrote
 * most recently and `/whatsapp/get/conversation` gives that thread, which is
 * enough to reconstruct what a webhook would have delivered.
 *
 * **Everything goes through `receiveInbound`, the same function the webhook
 * calls.** Not a second storage path: one place decides how a contact is
 * matched, how the conversation row is written, when the 24-hour window opens
 * and who gets told. It is also what makes polling safe to repeat — that
 * function claims each message by a unique insert on (provider, kind,
 * provider message id), so seeing the same reply on twenty consecutive visits
 * stores it once.
 *
 * If WhatsMarketing ever do enable a webhook, this becomes redundant rather
 * than wrong: both doors lead to the same room, and the dedupe means both
 * being open at once is not a problem.
 */
import {
  getIntegrationConfig, getIntegrationCredentials, recordIntegrationResult,
} from '../../../core/settings/integrations.js';
import { logger } from '../../../utils/logger.js';
import { db } from '../../../db/pool.js';
import type { InboundMessage, StatusUpdate } from './types.js';
import { applyStatus, receiveInbound, recordSentElsewhere } from './inbound.js';
import { activeBusinessProvider } from './registry.js';
import { WHATSMARKETING_PROVIDER } from './whatsMarketing.js';
import { metaCloudProvider } from './metaCloud.js';

/**
 * How many recent subscribers to look at on one visit.
 *
 * Their list is ordered by most recent message (`orderBy=1`), so the people
 * who have just written are at the front — which is the ordering this decision
 * actually needs, not an arbitrary slice. Rule from CLAUDE.md, found five
 * times in this codebase: a bounded slice whose ORDER BY has nothing to do
 * with what happens next is how things silently go missing.
 */
const SUBSCRIBERS_PER_VISIT = 40;
/** Messages per thread. A minute's worth of conversation is a handful. */
const MESSAGES_PER_THREAD = 15;

/**
 * **Identity decides what is stored, never the clock.**
 *
 * This replaced a moving watermark, and the reason is the whole of 20
 * September 2026. The poller remembered when it last looked and skipped
 * anything stamped earlier. That is correct only if a message becomes
 * readable the moment it is stamped — and WhatsMarketing's does not. The
 * owner's "hey" was stamped 07:27:30 UTC, was still invisible to a visit at
 * 07:45, and first appeared at 07:48. By then the watermark was past it, so
 * it was skipped, and it would have been skipped for ever. The poller
 * reported success every single minute throughout.
 *
 * Widening the window was tried twice, fifteen minutes and then forty-five,
 * and both are the same bug with a longer fuse: any window is a bet on the
 * vendor's worst lag, and losing the bet is silent. **So the window is gone.**
 * Every visit offers everything it can see, and a message is stored exactly
 * once because `receiveInbound` claims it by a unique insert on its provider
 * message id. Identity is a fact; a timestamp is a guess about somebody
 * else's clock.
 *
 * Two bounds keep that honest rather than expensive:
 *
 *  * `HISTORY_FLOOR_DAYS` — a floor, not a watermark. It never advances past
 *    a message that has not been seen, because it is measured from now and
 *    sits a week behind any lag a vendor could plausibly have. It exists so a
 *    vendor that suddenly returns a year of history does not import a year.
 *  * `seen` — the ids already offered, so the repeat costs nothing. It is
 *    seeded from the database on the first visit of a process, which is what
 *    makes a restart free as well.
 *
 * `seen` is an optimisation and never the guarantee. The unique index is the
 * guarantee, and it holds even if this set is empty, wrong or cleared.
 */
const HISTORY_FLOOR_DAYS = 7;

const seen = new Set<string>();
let seenSeeded = false;

/**
 * Fill `seen` from what the database has already claimed.
 *
 * One query per process. Without it the first visit after every deploy offers
 * a few hundred already-stored messages back to `receiveInbound`, which
 * resolves a contact before it opens its transaction — correct, and needlessly
 * slow. A failure here is not worth stopping for: the unique index still
 * refuses every repeat, so the cost of an empty set is time, not duplicates.
 */
async function seedSeen(): Promise<void> {
  if (seenSeeded) return;
  seenSeeded = true;
  try {
    const rows = await db.query<{ event_key: string }>(
      `SELECT event_key FROM ipy_wa_webhook_event
        WHERE provider = $1 AND kind = 'message'`,
      [WHATSMARKETING_PROVIDER],
    );
    for (const row of rows.rows) seen.add(row.event_key);
    logger.info({ known: seen.size }, 'whatsmarketing poller knows what it has already stored');
  } catch (err) {
    logger.warn({ err }, 'could not seed the whatsmarketing seen-set; the unique index still holds');
  }
}

interface Conf { baseUrl: string; apiToken: string; phoneNumberId: string }

function conf(): Conf | null {
  const config = getIntegrationConfig(WHATSMARKETING_PROVIDER);
  const creds = getIntegrationCredentials(WHATSMARKETING_PROVIDER);
  if (!creds?.apiToken || !config?.phoneNumberId) return null;
  return {
    baseUrl: (config.baseUrl || 'https://app.whatsmarketing.in/api/v1').replace(/\/+$/, ''),
    apiToken: creds.apiToken,
    phoneNumberId: config.phoneNumberId,
  };
}

/**
 * Why the last visit ended the way it did.
 *
 * This poller used to swallow everything and answer `{checked: 0, stored: 0}`,
 * which is indistinguishable from a quiet afternoon. It ran ten times against
 * production without storing anything and there was no way, from outside the
 * container, to tell a refused token from an unreachable vendor from nobody
 * having written — the exact silent failure this codebase keeps meeting.
 *
 * So every visit now records what happened on the integration row, where
 * Admin → Integrations already shows it and a database check can read it.
 */
let lastOutcome = '';

async function call(
  c: Conf, path: string, fields: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${c.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiToken: c.apiToken, phone_number_id: c.phoneNumberId, ...fields }).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      lastOutcome = `${path} answered HTTP ${res.status}: ${text.slice(0, 120)}`;
      return null;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      lastOutcome = `${path} answered something that is not JSON: ${text.slice(0, 120)}`;
      return null;
    }
    // Their refusals answer HTTP 200 with status "0" — the trap the adapter's
    // own tests open on. A poll must not read one as an empty list.
    if (String(parsed.status) !== '1') {
      lastOutcome = `${path} refused: ${String(parsed.message ?? 'no reason given').slice(0, 120)}`;
      return null;
    }
    return parsed;
  } catch (err) {
    // A vendor being unreachable is not a reason to take the process down —
    // but it is a reason to say so rather than to look like an empty inbox.
    lastOutcome = `${path} could not be reached: ${(err as Error).message}`;
    return null;
  }
}

/** `message` is a string on failure, one object for one row, an array for many. */
function rowsOf(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === 'object') return [payload as Record<string, unknown>];
  return [];
}

/**
 * Was this row written by the customer, or by us?
 *
 * Their sample shows `sender: "bot"` for something the business sent. Anything
 * else is treated as the customer's, and **that direction matters more than it
 * looks**: replaying our own outbound messages back through `receiveInbound`
 * would file them as things the customer said, reopen the 24-hour window on
 * our own message, and notify an agent about their own reply.
 */
export const OURS_SENDERS = ['bot', 'agent', 'admin', 'system', 'business'] as const;
const OURS = new Set<string>(OURS_SENDERS);
/* Read from their live API: a customer's row says `sender: "user"`, and ours
   says `sender: "bot"` with the agent's id in `agent_name`. */
const isFromCustomer = (row: Record<string, unknown>): boolean =>
  !OURS.has(String(row.sender ?? '').toLowerCase());

/**
 * Dig the text out of their `message_content`, which is a JSON string.
 *
 * Their own sample carries a whole Meta message object in there, so the shapes
 * worth reading are Meta's (`text.body`, and a caption under an image) and a
 * plain string. Anything else returns null and is logged rather than guessed
 * at — a message stored with invented text is worse than one that is visibly
 * missing, because nobody goes looking for it.
 */
export function textOfMessage(raw: unknown): { text: string | null; media: InboundMessage['media'] } {
  if (typeof raw !== 'string' || !raw) return { text: null, media: null };

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { text: raw, media: null }; }
  if (typeof parsed === 'string') return { text: parsed, media: null };
  if (!parsed || typeof parsed !== 'object') return { text: null, media: null };

  const obj = parsed as Record<string, unknown>;

  /*
    **What a customer actually sends, read from their live API on 20 September
    2026 and not from anybody's documentation.**

    WhatsMarketing store the *entire Meta webhook envelope* against an inbound
    row — `{object:'whatsapp_business_account', entry:[{changes:[{value:{
    messages:[…]}}]}]}` — and a plain little `{messaging_product, to, text}`
    against an outbound one. Nothing in their PDF says so, which is why six of
    the owner's messages read as unreadable while the poller reported success
    every minute.

    So the envelope goes to the parser the CRM already has for exactly this
    shape, rather than to a second one written here. One parser: when Meta add
    a message type, the webhook door and this door learn it together. A copy
    would drift, and the way it drifts is that one of them silently stops
    understanding a customer.
  */
  if (obj.object === 'whatsapp_business_account' && Array.isArray(obj.entry)) {
    const first = metaCloudProvider.parseWebhook(obj).messages[0];
    if (first) return { text: first.text, media: first.media };
    return { text: null, media: null };
  }

  return readObject(obj, 2);
}

/** A string at one of these keys, or nothing. Never a guess at another type. */
function stringAt(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * Where the words are, across every shape seen or documented.
 *
 * Meta's own is `text.body`, and WhatsMarketing wrap a Meta object — but only
 * for what *they* send. What a subscriber sends came back in a shape this
 * reader did not know, and six of the owner's messages were dropped for it on
 * 20 September. The answer is not to guess at an unknown type: it is to look
 * in every place a string could legitimately be, and to keep returning null
 * when there is none, because a message stored with invented text is worse
 * than one that is visibly missing.
 *
 * One level of nesting is followed (`message`, `data`, `payload`), since a
 * vendor wrapping Meta's object one deeper is the common difference between
 * two APIs rather than a different idea.
 */
const TEXT_KEYS = ['body', 'text', 'message', 'content', 'caption'] as const;
const WRAPPERS = ['message', 'data', 'payload'] as const;
const MEDIA_KINDS = ['image', 'video', 'document', 'audio', 'sticker', 'voice'] as const;

function readObject(
  obj: Record<string, unknown>, depth: number,
): { text: string | null; media: InboundMessage['media'] } {
  // `text` is an object in Meta's shape and a plain string in others.
  const textObj = obj.text as Record<string, unknown> | undefined;
  const body = (textObj && typeof textObj === 'object' ? stringAt(textObj, TEXT_KEYS) : null)
    ?? stringAt(obj, TEXT_KEYS);

  for (const kind of MEDIA_KINDS) {
    const found = obj[kind] as
      { link?: string; url?: string; id?: string; caption?: string; mime_type?: string; mimetype?: string }
      | undefined;
    if (found && typeof found === 'object') {
      return {
        text: body ?? found.caption ?? null,
        media: {
          link: found.link ?? found.url,
          id: found.id,
          mimeType: found.mime_type ?? found.mimetype,
          caption: found.caption,
        },
      };
    }
  }

  if (body) return { text: body, media: null };

  // Nothing at this level. A vendor that wraps Meta's object one deeper is a
  // packaging difference, not a different idea, so follow it once.
  if (depth > 0) {
    for (const key of WRAPPERS) {
      const inner = obj[key];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const found = readObject(inner as Record<string, unknown>, depth - 1);
        if (found.text || found.media) return found;
      }
    }
  }
  return { text: null, media: null };
}

/**
 * The *shape* of something this reader could not parse — keys and types, never
 * a value.
 *
 * On 20 September the poller reported six of today's messages as unreadable,
 * the owner's own among them, and there is no way to widen the reader without
 * knowing what it is looking at. The obvious move is to print the body; the
 * body is a customer's message, and it would go into a CI log that several
 * people can read and that is kept.
 *
 * So this prints `{type:string,message:{body:string}}` and nothing that anyone
 * wrote. It is enough to fix a parser and it discloses nothing. Reach for it
 * whenever a vendor's payload has to be understood from outside the container.
 */
export function describeShape(raw: unknown): string {
  if (typeof raw !== 'string') return `not a string (${raw === null ? 'null' : typeof raw})`;
  if (!raw) return 'empty';
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return 'plain text, not JSON'; }

  const walk = (value: unknown, depth: number): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return value.length ? `[${walk(value[0], depth - 1)}]` : '[]';
    if (typeof value === 'object') {
      if (depth <= 0) return 'object';
      const keys = Object.keys(value as Record<string, unknown>).slice(0, 12);
      return `{${keys.map((k) => `${k}:${walk((value as Record<string, unknown>)[k], depth - 1)}`).join(',')}}`;
    }
    return typeof value;
  };
  return walk(parsed, 3).slice(0, 300);
}

/** Their timestamps are "2026-07-28 13:21:03" — no zone, and theirs is UTC. */
function readTime(raw: unknown): Date {
  if (typeof raw === 'string' && raw) {
    const parsed = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * How a message *we* sent actually went, from the same rows.
 *
 * Found by reading their live API on 20 September 2026 rather than their
 * documentation, which does not mention it: an outbound row carries
 * `message_status`, `delivery_status_updated_at` and `read_time`. That is a
 * delivery receipt, and it is the thing a webhook would have pushed.
 *
 * **It matters more than it looks.** Without it the CRM can say a message was
 * handed to the vendor and nothing more — so a campaign report could only ever
 * count attempts, never arrivals, and "sent 900" would mean nothing at all.
 * With it, delivered and read are real numbers on a real screen.
 *
 * Goes through `applyStatus`, the same function the webhook uses, which only
 * ever moves a status forward and claims each one once. So re-reading a thread
 * every minute is free, and a late "sent" cannot un-read a message the
 * customer has plainly read.
 */
const THEIR_STATES: Record<string, StatusUpdate['state']> = {
  sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed',
};

async function readOutboundStatus(row: Record<string, unknown>): Promise<boolean> {
  const id = String(row.wa_message_id ?? '');
  const state = THEIR_STATES[String(row.message_status ?? '').toLowerCase()];
  if (!id || !state) return false;

  // The most specific time they give for this state, and the row's own time
  // as a floor — a receipt with no clock is still a receipt.
  const at = readTime(
    (state === 'read' ? row.read_time : null)
    ?? row.delivery_status_updated_at
    ?? row.failed_time
    ?? row.conversation_time,
  );
  const failedReason = String(row.failed_reason ?? '').trim();
  try {
    return await applyStatus(WHATSMARKETING_PROVIDER, {
      providerMessageId: id,
      state,
      at,
      error: state === 'failed' ? (failedReason || 'the provider gave no reason') : null,
    });
  } catch (err) {
    logger.warn({ err, providerMessageId: id }, 'could not apply a polled WhatsApp delivery status');
    return false;
  }
}

/**
 * Put the last visit's outcome where a person, and a database check, can read it.
 *
 * Two places, because they answer different questions and one of them throws
 * the answer away. `recordIntegrationResult` is what Admin → Integrations
 * shows, and it deliberately clears `last_error` on success — so a *successful*
 * visit's counts vanish. "Reached them and stored nothing" and "reached them
 * and stored four" then look identical, which is exactly the hole this whole
 * exercise has been falling down: the poller was working, talking to
 * WhatsMarketing and finding nothing, and there was no way to see which of
 * those three facts was the problem.
 *
 * So the sentence also lands in `ipy_setting` under `whatsapp.last_poll`,
 * where it survives a success.
 */
async function report(ok: boolean, detail: string): Promise<void> {
  try {
    await recordIntegrationResult(WHATSMARKETING_PROVIDER, ok, detail);
  } catch (err) {
    logger.warn({ err }, 'could not record the WhatsApp poll outcome');
  }
  try {
    await db.query(
      `INSERT INTO ipy_setting (key, value, category, label, updated_at)
       VALUES ('whatsapp.last_poll', $1::jsonb, 'whatsapp', 'Last WhatsApp inbound check', now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ at: new Date().toISOString(), ok, detail })],
    );
  } catch (err) {
    logger.warn({ err }, 'could not write the WhatsApp poll summary');
  }
}

/**
 * One visit: who has written lately, and what did they say.
 *
 * Returns what it stored so the scheduler's log says something useful, and
 * never throws — it shares a tick with the workflow engine and a vendor
 * timeout must not stop follow-ups going out.
 */
/**
 * A message somebody sent from WhatsMarketing's own inbox, stored on the record.
 *
 * One that is under two minutes old is left for the next visit. The CRM writes
 * the vendor's id onto a message it sent a moment after the vendor accepts it,
 * and a poll landing in that moment would otherwise store the CRM's own message
 * a second time.
 */
const JUST_SENT_MS = 2 * 60 * 1000;

async function keepSentElsewhere(row: Record<string, unknown>, handle: string, floor: Date): Promise<boolean> {
  const id = String(row.wa_message_id ?? '');
  if (!id) return false;
  const sentAt = readTime(row.conversation_time ?? row.created_at);
  if (sentAt < floor || Date.now() - sentAt.getTime() < JUST_SENT_MS) return false;
  const { text, media } = textOfMessage(row.message_content);
  if (!text && !media) return false;
  try {
    return await recordSentElsewhere(WHATSMARKETING_PROVIDER, { providerMessageId: id, to: handle, text, media, sentAt });
  } catch (err) {
    logger.warn({ err, providerMessageId: id }, 'could not store a message sent from the WhatsMarketing inbox');
    return false;
  }
}

export async function pollWhatsMarketingInbound(): Promise<{ checked: number; stored: number }> {
  const provider = activeBusinessProvider();
  // Only when WhatsMarketing is the live provider. Another BSP's webhook works
  // properly and polling it as well would be two doors for no reason.
  if (provider?.name !== WHATSMARKETING_PROVIDER) return { checked: 0, stored: 0 };

  const c = conf();
  if (!c) return { checked: 0, stored: 0 };

  await seedSeen();
  // A floor, not a watermark: measured from now and a week behind, so it can
  // never creep past a message nobody has seen.
  const floor = new Date(Date.now() - HISTORY_FLOOR_DAYS * 24 * 60 * 60 * 1000);

  lastOutcome = '';
  const list = await call(c, '/whatsapp/subscriber/list', {
    limit: String(SUBSCRIBERS_PER_VISIT),
    offset: '1',
    orderBy: '1',
  });
  if (!list) {
    await report(false, lastOutcome || 'WhatsMarketing returned no subscriber list.');
    return { checked: 0, stored: 0 };
  }

  let checked = 0;
  let stored = 0;
  /*
    The newest thing a customer has said, **ignoring the watermark**.

    Without it "stored 0" has two very different causes that read the same:
    the poller cannot see a message at all, or it can see it and has already
    passed it. One is a bug and one is the poller working. This is the single
    number that tells them apart, and it is the question that has been open
    since the owner messaged the business number and nothing appeared.
  */
  let newestFromAnyone: Date | null = null;
  /*
    Whose it was. "The poller can see a message from a minute ago" is only
    half an answer — the other half is whether that message is the one
    somebody is standing next to their phone waiting for.
  */
  let newestFrom: string | null = null;
  /*
    Why a message past the watermark was not stored, counted by cause.

    On 20 September production reported a customer message newer than its own
    watermark and `stored 0` in the same breath, which is the shape of a
    message being dropped *after* the watermark check. From outside the
    container the three causes are identical, so each gets its own number:
    a row with no id to dedupe on, a `message_content` shape `textOfMessage`
    refuses to guess at, and one `receiveInbound` turned down (a repeat, or a
    throw it swallowed). A bare `stored 0` cannot tell them apart, and the
    house rule is that a failure has to become a fact somebody can read.
  */
  let noId = 0;
  let unreadable = 0;
  let refused = 0;
  let tooOld = 0;
  let known = 0;
  let statuses = 0;
  let sentElsewhere = 0;
  /* Keys and types only — see `describeShape`. Never a customer's words. */
  let unreadableShape: string | null = null;

  const subscribers = rowsOf(list.message);
  /*
    Named separately from `checked` because the difference between them is the
    diagnosis. "WhatsMarketing listed 40 and none had a number we could read"
    is a different problem from "WhatsMarketing listed nobody", and both look
    like silence.
  */
  let listed = subscribers.length;

  for (const subscriber of subscribers) {
    const handle = String(subscriber.chat_id ?? subscriber.phone_number ?? '').replace(/\D/g, '');
    if (!handle) continue;
    checked += 1;

    const thread = await call(c, '/whatsapp/get/conversation', {
      phone_number: handle,
      limit: String(MESSAGES_PER_THREAD),
      offset: '1',
    });
    if (!thread) continue;

    const name = [subscriber.first_name, subscriber.last_name]
      .filter((p) => p && String(p) !== 'null').join(' ').trim() || null;

    for (const row of rowsOf(thread.message)) {
      if (!isFromCustomer(row)) {
        // Ours. Kept when somebody sent it from the vendor's own inbox, and
        // either way it carries how it went.
        if (await keepSentElsewhere(row, handle, floor)) sentElsewhere += 1;
        if (await readOutboundStatus(row)) statuses += 1;
        continue;
      }

      const sentAt = readTime(row.conversation_time ?? row.created_at);
      if (!newestFromAnyone || sentAt > newestFromAnyone) {
        newestFromAnyone = sentAt;
        newestFrom = handle;
      }
      /*
        The only thing a timestamp decides here: whether this is history
        rather than a message. Nothing else — see the note on identity above,
        and the day it cost.
      */
      if (sentAt < floor) { tooOld += 1; continue; }

      const providerMessageId = String(row.wa_message_id ?? row.id ?? '');
      if (!providerMessageId) { noId += 1; continue; }

      // Read again by the look-back, and already handled. The database would
      // say so too; this just saves it the contact lookup every minute.
      if (seen.has(providerMessageId)) continue;

      const { text, media } = textOfMessage(row.message_content);
      if (!text && !media) {
        logger.warn(
          { providerMessageId, content: String(row.message_content ?? '').slice(0, 500) },
          'whatsmarketing reply in a shape this poller cannot read — not stored',
        );
        unreadable += 1;
        unreadableShape ??= describeShape(row.message_content);
        continue;
      }

      const message: InboundMessage = {
        providerMessageId,
        from: handle,
        to: c.phoneNumberId,
        type: media ? 'image' : 'text',
        text,
        media,
        sentAt,
        profileName: name,
      };

      try {
        if (await receiveInbound(WHATSMARKETING_PROVIDER, message)) stored += 1;
        else refused += 1;
        // Remembered either way: stored, or already known to the database.
        seen.add(providerMessageId);
      } catch (err) {
        logger.warn({ err, providerMessageId }, 'could not store a polled WhatsApp reply');
        refused += 1;
      }
    }
  }

  if (stored) logger.info({ checked, stored }, 'pulled WhatsApp replies from WhatsMarketing');

  /*
    Said out loud even when it went fine, because "checked 40, stored 0" and
    "could not reach them" look identical from the outside and only one of
    them needs somebody.
  */
  await report(
    !lastOutcome,
    lastOutcome
      || `WhatsMarketing listed ${listed} subscriber${listed === 1 ? '' : 's'}; `
        + `read ${checked} thread${checked === 1 ? '' : 's'}; `
        + `stored ${stored} new message${stored === 1 ? '' : 's'}; `
        + `newest customer message visible anywhere: ${newestFromAnyone?.toISOString() ?? 'none'}`
        + `${newestFrom ? ` from ${newestFrom}` : ''}; `
        + `${known} already held; ${statuses} delivery update${statuses === 1 ? '' : 's'}; `
        + `${sentElsewhere} sent from their inbox; `
        + `dropped: ${noId} with no id, ${unreadable} unreadable, `
        + `${refused} refused by the store, ${tooOld} older than ${HISTORY_FLOOR_DAYS} days`
        + `${unreadableShape ? `; first unreadable shape: ${unreadableShape}` : ''}.`,
  );
  return { checked, stored };
}

/**
 * For the test, which must not inherit a seen id from another case. The set is
 * process-wide on purpose in production, and leaking between cases reads
 * exactly like a message being dropped.
 */
export function __resetPollWatermark(_at?: Date): void {
  seen.clear();
  seenSeeded = false;
}

/*
  Its own clock, not the scheduler's.

  `SCHEDULER_TICK_SECONDS` is 900 — fifteen minutes — which is right for SLA
  sweeps and the semantic index and hopeless for a conversation. The owner
  messaged the business number, waited two minutes and found the CRM still
  refusing to let him reply; the poller was correct and simply had not run yet.
  A quarter of an hour between a customer writing and a rep being allowed to
  answer is not a WhatsApp integration.

  One minute, and one visit at a time: a slow vendor must not start a second
  visit on top of the first, because two polls reading the same thread would
  both try to claim the same message and one would waste its work losing the
  race.
*/
const POLL_EVERY_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let visiting = false;

export function startWhatsAppPolling(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (visiting) return;
    visiting = true;
    void pollWhatsMarketingInbound()
      .catch((err) => logger.warn({ err }, 'WhatsApp inbound poll failed'))
      .finally(() => { visiting = false; });
  }, POLL_EVERY_MS);
  // Never hold the process open for a poll; the API shutting down matters more.
  timer.unref?.();
}

export function stopWhatsAppPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
