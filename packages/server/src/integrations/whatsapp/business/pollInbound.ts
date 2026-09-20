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
import type { InboundMessage } from './types.js';
import { receiveInbound } from './inbound.js';
import { activeBusinessProvider } from './registry.js';
import { WHATSMARKETING_PROVIDER } from './whatsMarketing.js';

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
 * How far back each visit looks, beyond the last one.
 *
 * **The bug this exists for, measured on production 20 September 2026.** The
 * owner sent "hey" at 12:57 IST. The poller reported, twenty minutes later,
 * that it could see that exact message from that exact number — and that it
 * had dropped nothing: no missing id, nothing unreadable, nothing the store
 * refused. It had simply arrived *behind the watermark*, because the
 * watermark was already at 13:17.
 *
 * The mistake was treating the vendor's timestamp as the moment the message
 * became readable. It is not. WhatsMarketing's conversation endpoint publishes
 * a message some minutes after it is stamped — its position in the
 * most-recent-forty subscriber list moves on their clock, not ours — so a
 * watermark that marches to "when this visit started" is always a few minutes
 * ahead of what the vendor will show next. Every message landing in that gap
 * is skipped permanently, and the only symptom is a customer's reply that
 * never appears, with a poller reporting success every single minute.
 *
 * So each visit re-reads the last quarter of an hour. That is not sloppiness:
 * `receiveInbound` claims every message by a unique insert and refuses the
 * repeat, so an extra look costs one refused insert and a dropped message
 * costs a customer. When the two are not symmetrical, look again.
 */
const LOOK_BACK_MS = 15 * 60 * 1000;

/**
 * Only look at threads that have moved since the last visit.
 *
 * Without this every tick would re-read forty whole conversations for nothing.
 * An hour's grace on the first run picks up anything that arrived while the
 * CRM was being deployed.
 */
let lastVisit = new Date(Date.now() - 60 * 60 * 1000);

/**
 * Message ids this process has already offered to the store.
 *
 * The look-back above means the same message is read again every minute for a
 * quarter of an hour. The database would refuse each repeat correctly, but
 * `receiveInbound` resolves the contact *before* it opens the transaction, so
 * a repeat still costs a lookup per message per minute. This skips the second
 * and later sightings for free.
 *
 * Memory only, and deliberately so: it is an optimisation, never the
 * guarantee. The unique index is the guarantee, and a restart simply pays for
 * one more look.
 */
const seen = new Set<string>();
const SEEN_CEILING = 5_000;

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
const OURS = new Set(['bot', 'agent', 'admin', 'system', 'business']);
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
  const text = obj.text as { body?: string } | undefined;
  const body = text?.body
    ?? (typeof obj.body === 'string' ? obj.body : undefined)
    ?? (typeof obj.message === 'string' ? obj.message : undefined)
    ?? null;

  for (const kind of ['image', 'video', 'document', 'audio'] as const) {
    const found = obj[kind] as { link?: string; id?: string; caption?: string; mime_type?: string } | undefined;
    if (found && typeof found === 'object') {
      return {
        text: body ?? found.caption ?? null,
        media: { link: found.link, id: found.id, mimeType: found.mime_type, caption: found.caption },
      };
    }
  }
  return { text: body, media: null };
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
export async function pollWhatsMarketingInbound(): Promise<{ checked: number; stored: number }> {
  const provider = activeBusinessProvider();
  // Only when WhatsMarketing is the live provider. Another BSP's webhook works
  // properly and polling it as well would be two doors for no reason.
  if (provider?.name !== WHATSMARKETING_PROVIDER) return { checked: 0, stored: 0 };

  const c = conf();
  if (!c) return { checked: 0, stored: 0 };

  const since = lastVisit;
  const visitStarted = new Date();

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
      if (!isFromCustomer(row)) continue;

      const sentAt = readTime(row.conversation_time ?? row.created_at);
      if (!newestFromAnyone || sentAt > newestFromAnyone) {
        newestFromAnyone = sentAt;
        newestFrom = handle;
      }
      /*
        `<`, not `<=`, and the watermark overlaps by a second below.

        Their timestamps carry seconds and no more, so a reply that lands in
        the same second the last visit started reads as equal to the watermark
        and would be skipped for ever. Offering a message twice costs nothing —
        `receiveInbound` claims each one by a unique insert and refuses the
        repeat — while dropping one loses a customer's message silently. When
        the two are not symmetrical, err towards the duplicate.
      */
      if (sentAt < since) continue;

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
        if (seen.size >= SEEN_CEILING) seen.clear();
        seen.add(providerMessageId);
      } catch (err) {
        logger.warn({ err, providerMessageId }, 'could not store a polled WhatsApp reply');
        refused += 1;
      }
    }
  }

  /*
    The watermark moves only once the visit is through, and to when the visit
    *started* rather than to now. A message that landed while this was running
    would otherwise fall in the gap between the two and never be looked at
    again — the classic off-by-one in every poller, and invisible when it bites
    because the only symptom is one customer's reply that never appeared.
  */
  // Back by the look-back, not by a second. The second of overlap only ever
  // covered their timestamps having no sub-second part; it did nothing about
  // a message published minutes after it is stamped, which is the failure
  // that actually happened. See LOOK_BACK_MS.
  lastVisit = new Date(visitStarted.getTime() - LOOK_BACK_MS);
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
        + `stored ${stored} new message${stored === 1 ? '' : 's'} since ${since.toISOString()}; `
        + `newest customer message visible anywhere: ${newestFromAnyone?.toISOString() ?? 'none'}`
        + `${newestFrom ? ` from ${newestFrom}` : ''}; `
        + `dropped past the watermark: ${noId} with no id, ${unreadable} unreadable, `
        + `${refused} refused by the store.`,
  );
  return { checked, stored };
}

/**
 * For the test, which must not inherit a watermark — or a seen id — from
 * another case. Both are process-wide on purpose in production and both would
 * otherwise leak between cases, which reads as a message being dropped.
 */
export function __resetPollWatermark(at: Date): void {
  lastVisit = at;
  seen.clear();
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
