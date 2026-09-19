/**
 * Sending a unit to a buyer, and chasing them about it, without leaving the chat.
 *
 * Both halves of this already existed and neither is reimplemented here:
 *
 *  * **A share link** is `core/sharing/shareLinks.ts`. It mints a fresh token
 *    every time, deliberately, so a view count means something and revoking
 *    one buyer's link does not revoke another's. This adds the label — who it
 *    went to — and the sending.
 *  * **A follow-up** is `core/workflow/followUp.ts`, which is the one
 *    definition of "chase them on `<date>`": it writes the date on the record,
 *    leaves a note in the timeline and notifies the owner. A chat that wrote
 *    its own date would be a second answer to the same question.
 *
 * What is genuinely new is the join, and one rule in it: **the message is
 * composed here, not in the browser.** The facts come off the property through
 * `recordService`, so a rep who cannot see a unit cannot send it, and a screen
 * cannot post a link to a property its user was never shown.
 *
 * The link is minted before the send and **revoked if the send fails**. A live
 * link to this morning's draft floor, created by a message that never arrived,
 * is a door nobody knows is open.
 */
import { config as appConfig } from '../../../config.js';
import { db } from '../../../db/pool.js';
import { logger } from '../../../utils/logger.js';
import { BadRequestError } from '../../../utils/errors.js';
import { recordService } from '../../../core/entity/recordService.js';
import type { ScopeContext } from '../../../core/permissions/index.js';
import { createShareLink, revokeShareLink } from '../../../core/sharing/shareLinks.js';
import { propertyFacts } from '../../../core/storage/propertyDetails.js';
import { sendOnBusinessNumber } from './send.js';

const PROPERTIES = 'properties';

/**
 * Which facts go in the message.
 *
 * Not all of them. A WhatsApp message with eleven lines of specification is a
 * brochure, and a buyer reads the first two lines and the link. These are the
 * ones somebody decides on: what it is, where, how big, how much.
 */
const HEADLINE_FACTS = ['Configuration', 'Locality', 'Size', 'Area', 'Price', 'Status'];

/** `https://crm.ipropy.com/s/<token>` — the first origin the app answers on. */
function shareUrlFor(token: string): string {
  const base = (appConfig.appUrl.split(',')[0] ?? '').trim().replace(/\/+$/, '');
  return `${base}/s/${token}`;
}

export interface SharePropertyInput {
  ctx: ScopeContext;
  userId: string;
  /** The customer's number, as the conversation holds it. */
  to: string;
  /** The contact the chat belongs to. Null for a thread nobody has claimed. */
  contactId: string | null;
  propertyId: string;
  /** A line the rep typed, which goes above the details. */
  note?: string;
}

export interface SharedProperty {
  messageId: string;
  conversationId: string;
  shareUrl: string;
  propertyLabel: string;
}

/**
 * Compose the message a buyer actually receives.
 *
 * Exported because it is the part worth proving: the wording is the product
 * here, and it has to hold when a property has almost no facts filled in —
 * which is what the two live ones look like today.
 */
export function shareMessage(input: {
  propertyLabel: string;
  facts: Record<string, string>;
  url: string;
  note?: string;
}): string {
  const lines: string[] = [];
  if (input.note?.trim()) lines.push(input.note.trim());
  lines.push(input.propertyLabel);

  for (const key of HEADLINE_FACTS) {
    const value = input.facts[key];
    if (value) lines.push(`${key}: ${value}`);
  }

  // The link last, on its own line. WhatsApp only previews a link it can see
  // the end of, and a URL buried mid-sentence is one nobody taps.
  lines.push(input.url);
  return lines.join('\n');
}

export async function sharePropertyOnWhatsApp(input: SharePropertyInput): Promise<SharedProperty> {
  /*
    The permission check *is* `getRecord`. It runs the same four layers every
    other read does — profile, role hierarchy, sharing rules, field visibility
    — so there is no second answer here to "may this person see this unit?".
  */
  const property = await recordService.getRecord(input.ctx, PROPERTIES, input.propertyId);

  let contactLabel = 'a WhatsApp contact';
  if (input.contactId) {
    const contact = await recordService.getRecord(input.ctx, 'leads', input.contactId);
    contactLabel = contact.label || contactLabel;
  }

  const link = await createShareLink({
    recordId: input.propertyId,
    userId: input.userId,
    // The label is the sender's own note and never reaches the visitor. It is
    // what makes the property's Share tab readable a month later: eleven links
    // with view counts and no names is a list nobody can act on.
    label: `WhatsApp · ${contactLabel}`,
  });

  const url = shareUrlFor(link.token);
  const text = shareMessage({
    propertyLabel: property.label,
    facts: await propertyFacts(input.propertyId),
    url,
    note: input.note,
  });

  try {
    const sent = await sendOnBusinessNumber({
      userId: input.userId,
      to: input.to,
      text,
      recordId: input.contactId,
    });
    logger.info(
      { propertyId: input.propertyId, contactId: input.contactId, linkId: link.id },
      'whatsapp: property shared',
    );
    return {
      messageId: sent.messageId,
      conversationId: sent.conversationId,
      shareUrl: url,
      propertyLabel: property.label,
    };
  } catch (err) {
    /*
      Nothing was sent, so nothing should be reachable. Outside the 24-hour
      window this is the ordinary path rather than a rare one — a free-text
      message cannot go, the send refuses with that reason, and a live link to
      a draft property would otherwise be left behind every time a rep tried.
    */
    await revokeShareLink(link.id, input.propertyId).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Chasing them afterwards
// ---------------------------------------------------------------------------

/**
 * The date a rep can type without leaving the conversation.
 *
 * Deliberately thin: it checks the day is not in the past and hands straight
 * to `scheduleFollowUp`. Everything that makes a follow-up real — the date on
 * the record, the timeline note, the notification to whoever owns the lead —
 * belongs to that one function, and a chat is not a reason to grow a second.
 */
export function assertFollowUpDay(on: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw new BadRequestError('That is not a date.');
  const today = new Date().toISOString().slice(0, 10);
  if (on < today) {
    throw new BadRequestError('A follow-up is a date to act on, so it cannot be in the past.');
  }
}

/** Does this thread belong to a contact at all? A follow-up needs a record. */
export async function contactBehind(conversationId: string): Promise<{ id: string; module: string } | null> {
  const row = await db.queryOne<{ record_id: string | null; record_module: string | null }>(
    `SELECT record_id, record_module FROM ipy_conversation WHERE id = $1`,
    [conversationId],
  );
  return row?.record_id ? { id: row.record_id, module: row.record_module ?? 'leads' } : null;
}
