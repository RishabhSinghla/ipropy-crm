/**
 * Keyword auto-replies — the ManyChat-shaped half of the WhatsApp stack.
 *
 * Rules, not a flow chart. A property desk answers the same handful of
 * questions all day ("price?", "location?", "brochure", "site visit"), and a
 * rule list is something a salesperson can edit at 10pm without being taught a
 * node graph. When a conversation needs more than a rule, the right answer is
 * a human, which is what handover does.
 *
 * Rules branch through *buttons*, not conditions. A reply can offer "This
 * weekend / A weekday", and each button names the rule that answers it. That
 * gives a real two- or three-step flow while keeping every individual rule
 * legible on its own — which a node graph stops being at about step four.
 *
 * Three guards, in order, because each one is a way this feature could
 * embarrass the business:
 *
 *  1. Never reply to someone who just opted out.
 *  2. Never reply while a human is already handling the conversation — nothing
 *     reads worse than a bot talking over your salesperson mid-negotiation.
 *  3. Never reply twice to the same message, and never more than once a minute
 *     to the same person, so two inbound messages in a row cannot start a loop.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { renderTemplate } from '@ipropy/shared';
import { notify } from '../../core/notifications/index.js';

export interface AutoReplyInput {
  conversationId: string;
  handle: string;
  text: string | null;
  recordId: string | null;
  consentAction: 'opt_out' | 'opt_in' | null;
  /** Set when the customer tapped a quick-reply button rather than typing. */
  buttonPayload?: string | null;
  /** True only for the first inbound message ever stored in this conversation. */
  isFirstMessage?: boolean;
}

interface RuleRow {
  id: string;
  name: string;
  trigger_type: string;
  match_type: string;
  keywords: string[];
  reply_text: string;
  buttons: { id: string; title: string }[];
  button_routes: Record<string, string>;
  business_hours_only: boolean;
  handoff: boolean;
  media_url: string | null;
  is_routed_only: boolean;
}

/** Minutes before the same number may receive another automatic reply. */
const COOLDOWN_MINUTES = 1;

export async function runAutoReply(input: AutoReplyInput): Promise<void> {
  // 1. Consent. An opt-out confirmation is the one automatic message that is
  // still appropriate — silence after "STOP" leaves people unsure it worked.
  if (input.consentAction === 'opt_out') {
    await send(input.conversationId, 'You have been unsubscribed and will not receive further messages from us. Reply START at any time to resume.');
    return;
  }
  if (input.consentAction === 'opt_in') {
    await send(input.conversationId, 'You are subscribed again. Reply STOP at any time to unsubscribe.');
    return;
  }

  const conv = await db.queryOne<{ assigned_to: string | null; status: string }>(
    `SELECT assigned_to, status FROM ipy_conversation WHERE id = $1`,
    [input.conversationId],
  );

  // 2. A human owns this thread — stay out of it.
  if (conv?.assigned_to) return;

  // 3. Cooldown, keyed on the conversation rather than the message, so a burst
  // of inbound messages produces one reply and not one each.
  if (!input.buttonPayload) {
    const recent = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_message
       WHERE conversation_id = $1 AND direction = 'outbound' AND is_auto_reply = true
         AND created_at > now() - ($2 || ' minutes')::interval
       LIMIT 1`,
      [input.conversationId, String(COOLDOWN_MINUTES)],
    );
    if (recent) return;
  }

  const rule = await matchRule(input.text, input.buttonPayload ?? null, input.isFirstMessage ?? false);
  if (!rule) return;

  const scope = await mergeScope(input.recordId);
  const body = renderTemplate(rule.reply_text, scope);

  await send(input.conversationId, body, rule.buttons, rule.media_url);

  // A rule can end the automation deliberately: some questions ("can you do
  // 1.4?") should reach a person on the first ask, not the fourth.
  if (rule.handoff) {
    await handOver(input.conversationId, input.recordId, rule.name);
  }

  await db.query(`UPDATE ipy_autoreply_rule SET match_count = match_count + 1 WHERE id = $1`, [rule.id]);
  logger.info({ rule: rule.name, conversationId: input.conversationId }, 'auto-reply sent');
}

/**
 * Pick the rule to answer with.
 *
 * A button tap wins outright: the customer chose from options we offered, and
 * falling back to keyword matching on the button's label would be a way to
 * answer a different question than the one they picked.
 *
 * Otherwise it is first match wins in `sequence` order, so a specific answer
 * always beats the catch-all. Rules marked `is_routed_only` are invisible here
 * — they exist to be reached by a button and would otherwise fire on stray
 * words like "weekend" appearing mid-sentence.
 */
export async function matchRule(
  text: string | null,
  buttonPayload: string | null = null,
  isFirstMessage = false,
): Promise<RuleRow | null> {
  if (buttonPayload) {
    const routed = await db.queryOne<RuleRow>(
      `SELECT r.* FROM ipy_autoreply_rule owner
       JOIN ipy_autoreply_rule r ON r.id = (owner.button_routes ->> $1)::uuid
       WHERE owner.button_routes ? $1 AND r.is_active
       LIMIT 1`,
      [buttonPayload],
    );
    if (routed) return routed;
  }

  const rows = await db.query<RuleRow>(
    `SELECT id, name, trigger_type, match_type, keywords, reply_text, buttons,
            button_routes, business_hours_only, handoff, media_url, is_routed_only
     FROM ipy_autoreply_rule WHERE is_active = true ORDER BY sequence, created_at`,
  );
  if (!rows.rows.length) return null;

  const haystack = (text ?? '').toLowerCase().trim();
  const withinHours = await isWithinBusinessHours();

  let fallback: RuleRow | null = null;
  for (const rule of rows.rows) {
    if (rule.is_routed_only) continue;
    if (rule.business_hours_only && !withinHours) continue;

    if (rule.trigger_type === 'fallback') {
      fallback ??= rule;
      continue;
    }
    if (rule.trigger_type === 'welcome') {
      if (isFirstMessage) return rule;
      continue;
    }
    if (rule.trigger_type !== 'keyword') continue;

    const hit = (rule.keywords ?? []).some((k) => {
      const needle = String(k).toLowerCase().trim();
      if (!needle) return false;
      // `exact` exists for short, ambiguous triggers — a rule on "no" that
      // matches "no parking nearby?" answers the wrong question entirely.
      return rule.match_type === 'exact' ? haystack === needle : haystack.includes(needle);
    });
    if (hit) return rule;
  }
  return fallback;
}

/**
 * Give the thread to a person and stop replying.
 *
 * Assigning to the record's owner rather than a queue, because on a property
 * desk the owner is the one who already knows the enquiry — and if there is no
 * owner, an unassigned open thread is still visible to everyone in the inbox.
 */
async function handOver(conversationId: string, recordId: string | null, ruleName: string): Promise<void> {
  const owner = recordId
    ? await db.queryOne<{ owner_id: string | null; owner_type: string | null }>(
        `SELECT owner_id, owner_type FROM ipy_record WHERE id = $1`,
        [recordId],
      )
    : null;
  const ownerUserId = owner?.owner_type === 'user' ? owner.owner_id : null;

  await db.query(
    `UPDATE ipy_conversation SET assigned_to = $2, status = 'open', updated_at = now() WHERE id = $1`,
    [conversationId, ownerUserId],
  );

  if (ownerUserId) {
    await notify({
      userId: ownerUserId,
      kind: 'whatsapp',
      title: 'A WhatsApp chat needs you',
      body: `“${ruleName}” handed this conversation over.`,
      // The inbox page is gone; the lead itself is where this is answered now.
      link: recordId ? `/leads/${recordId}` : '/leads',
      recordId,
    });
  }
}

/** Business hours come from the same org setting the SLA rules use. */
async function isWithinBusinessHours(): Promise<boolean> {
  const row = await db.queryOne<{ value: { start?: string; end?: string; days?: number[] } }>(
    `SELECT value FROM ipy_setting WHERE key = 'business_hours'`,
  );
  const hours = row?.value;
  if (!hours?.start || !hours?.end) return true; // unset means always on

  const now = new Date();
  const day = now.getDay();
  if (hours.days?.length && !hours.days.includes(day)) return false;

  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = hours.start.split(':').map(Number);
  const [eh, em] = hours.end.split(':').map(Number);
  return minutes >= sh * 60 + (sm || 0) && minutes <= eh * 60 + (em || 0);
}

/** Merge tokens so a reply can use the enquirer's own name and project. */
async function mergeScope(recordId: string | null): Promise<Record<string, unknown>> {
  const org = await db.queryOne<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.name'`,
  );
  const scope: Record<string, unknown> = { org_name: org?.value ?? 'iPropy', first_name: 'there' };
  if (!recordId) return scope;

  const lead = await db.queryOne<{ first_name: string | null; label: string }>(
    `SELECT l.first_name, r.label FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id WHERE l.record_id = $1`,
    [recordId],
  );
  if (lead) {
    scope.first_name = lead.first_name || lead.label.split(' ')[0] || 'there';
    scope.name = lead.label;
  }
  return scope;
}

async function send(
  conversationId: string,
  text: string,
  buttons?: { id: string; title: string }[],
  mediaUrl?: string | null,
): Promise<void> {
  const { sendMessage } = await import('./service.js');

  // Media and buttons are mutually exclusive in the Cloud API's interactive
  // payload, so an attachment goes first with the text as its caption and the
  // buttons follow — rather than silently dropping one of the two.
  if (mediaUrl) {
    const result = await sendMessage({
      conversationId,
      media: { type: guessMediaType(mediaUrl), link: mediaUrl, caption: text },
      isAiGenerated: false,
    });
    if (result.messageId) {
      await db.query(`UPDATE ipy_message SET is_auto_reply = true WHERE id = $1`, [result.messageId]);
    }
    if (!buttons?.length) return;
  }

  const result = await sendMessage({
    conversationId,
    text: mediaUrl ? 'Anything else I can help with?' : text,
    buttons: buttons?.length ? buttons : undefined,
    isAiGenerated: false,
  });
  if (result.messageId) {
    await db.query(`UPDATE ipy_message SET is_auto_reply = true WHERE id = $1`, [result.messageId]);
  }
}

function guessMediaType(url: string): 'image' | 'document' | 'video' | 'audio' {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'aac', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}
