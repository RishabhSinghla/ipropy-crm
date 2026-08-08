/**
 * Keyword auto-replies — the ManyChat-shaped half of the WhatsApp stack.
 *
 * Rules, not a flow chart. A property desk answers the same handful of
 * questions all day ("price?", "location?", "brochure", "site visit"), and a
 * rule list is something a salesperson can edit at 10pm without being taught a
 * node graph. When a conversation needs more than a rule, the right answer is
 * a human, which is what handover does.
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

export interface AutoReplyInput {
  conversationId: string;
  handle: string;
  text: string | null;
  recordId: string | null;
  consentAction: 'opt_out' | 'opt_in' | null;
}

interface RuleRow {
  id: string;
  name: string;
  trigger_type: string;
  keywords: string[];
  reply_text: string;
  buttons: { id: string; title: string }[];
  business_hours_only: boolean;
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
  const recent = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_message
     WHERE conversation_id = $1 AND direction = 'outbound' AND is_auto_reply = true
       AND created_at > now() - ($2 || ' minutes')::interval
     LIMIT 1`,
    [input.conversationId, String(COOLDOWN_MINUTES)],
  );
  if (recent) return;

  const rule = await matchRule(input.text);
  if (!rule) return;

  const scope = await mergeScope(input.recordId);
  await send(input.conversationId, renderTemplate(rule.reply_text, scope), rule.buttons);

  await db.query(`UPDATE ipy_autoreply_rule SET match_count = match_count + 1 WHERE id = $1`, [rule.id]);
  logger.info({ rule: rule.name, conversationId: input.conversationId }, 'auto-reply sent');
}

/**
 * First match wins, in `sequence` order.
 *
 * Keyword rules are checked before the fallback so a specific answer always
 * beats the catch-all, and a `welcome` rule only fires when this is genuinely
 * the person's first message — otherwise every returning enquiry gets greeted
 * like a stranger.
 */
async function matchRule(text: string | null): Promise<RuleRow | null> {
  const rows = await db.query<RuleRow>(
    `SELECT id, name, trigger_type, keywords, reply_text, buttons, business_hours_only
     FROM ipy_autoreply_rule WHERE is_active = true ORDER BY sequence, created_at`,
  );
  if (!rows.rows.length) return null;

  const haystack = (text ?? '').toLowerCase();
  const withinHours = await isWithinBusinessHours();

  let fallback: RuleRow | null = null;
  for (const rule of rows.rows) {
    if (rule.business_hours_only && !withinHours) continue;

    if (rule.trigger_type === 'fallback') {
      fallback ??= rule;
      continue;
    }
    if (rule.trigger_type !== 'keyword') continue;

    const hit = (rule.keywords ?? []).some((k) => {
      const needle = String(k).toLowerCase().trim();
      return needle.length > 0 && haystack.includes(needle);
    });
    if (hit) return rule;
  }
  return fallback;
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
  const scope: Record<string, unknown> = { org_name: org?.value ?? 'iPropy' };
  if (!recordId) return scope;

  const lead = await db.queryOne<{ first_name: string | null; label: string }>(
    `SELECT l.first_name, r.label FROM ipy_e_leads l JOIN ipy_record r ON r.id = l.record_id WHERE l.record_id = $1`,
    [recordId],
  );
  if (lead) {
    scope.first_name = lead.first_name ?? '';
    scope.name = lead.label;
  }
  return scope;
}

async function send(conversationId: string, text: string, buttons?: { id: string; title: string }[]): Promise<void> {
  const { sendMessage } = await import('./service.js');
  const result = await sendMessage({
    conversationId,
    text,
    buttons: buttons?.length ? buttons : undefined,
    isAiGenerated: false,
  });
  if (result.messageId) {
    await db.query(`UPDATE ipy_message SET is_auto_reply = true WHERE id = $1`, [result.messageId]);
  }
}
