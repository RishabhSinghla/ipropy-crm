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
import { getIntegrationConfig, getIntegrationCredentials } from '../../../core/settings/integrations.js';
import { logger } from '../../../utils/logger.js';
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
 * Only look at threads that have moved since the last visit.
 *
 * Without this every tick would re-read forty whole conversations for nothing.
 * An hour's grace on the first run picks up anything that arrived while the
 * CRM was being deployed.
 */
let lastVisit = new Date(Date.now() - 60 * 60 * 1000);

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

async function call(c: Conf, path: string, fields: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${c.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ apiToken: c.apiToken, phone_number_id: c.phoneNumberId, ...fields }).toString(),
    });
    if (!res.ok) return null;
    const parsed = JSON.parse(await res.text()) as Record<string, unknown>;
    // Their refusals answer HTTP 200 with status "0" — the trap the adapter's
    // own tests open on. A poll must not read one as an empty list.
    return String(parsed.status) === '1' ? parsed : null;
  } catch {
    // A vendor being unreachable is not a reason to take the scheduler down.
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

  const list = await call(c, '/whatsapp/subscriber/list', {
    limit: String(SUBSCRIBERS_PER_VISIT),
    offset: '1',
    orderBy: '1',
  });
  if (!list) return { checked: 0, stored: 0 };

  let checked = 0;
  let stored = 0;

  for (const subscriber of rowsOf(list.message)) {
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
      if (!providerMessageId) continue;

      const { text, media } = textOfMessage(row.message_content);
      if (!text && !media) {
        logger.warn(
          { providerMessageId, content: String(row.message_content ?? '').slice(0, 500) },
          'whatsmarketing reply in a shape this poller cannot read — not stored',
        );
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
      } catch (err) {
        logger.warn({ err, providerMessageId }, 'could not store a polled WhatsApp reply');
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
  // A second of overlap, for the reason given at the `<` above: their
  // timestamps have no sub-second part, so an exact boundary is a real case
  // rather than a theoretical one.
  lastVisit = new Date(visitStarted.getTime() - 1000);
  if (stored) logger.info({ checked, stored }, 'pulled WhatsApp replies from WhatsMarketing');
  return { checked, stored };
}

/** For the test, which must not inherit a watermark from another case. */
export function __resetPollWatermark(at: Date): void { lastVisit = at; }

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
