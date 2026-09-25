/**
 * Telling WhatsMarketing that somebody unsubscribed, or subscribed again.
 *
 * **What can be connected, and what cannot.** Their API (checked against the
 * live account, 25 September 2026) has no subscribe or unsubscribe, and a
 * contact's record carries no field saying which they are — only name, email,
 * agent, labels and notes. So their own "Subscribed" switch cannot be read or
 * set from here. What can be written is a **note** on the contact, which is
 * what anybody opening that chat in WhatsMarketing's inbox will see.
 *
 * The other direction needs nothing: a customer who writes STOP writes it to
 * the business number, and the CRM reads every message on that number.
 *
 * Best effort, always. The CRM's own list is what stops a send; a vendor that
 * is down must never undo or delay an unsubscribe, so a failure is logged and
 * the CRM carries on.
 */
import { logger } from '../../../utils/logger.js';
import { activeBusinessProvider } from './registry.js';
import { addWhatsMarketingNote, WHATSMARKETING_PROVIDER } from './whatsMarketing.js';
import { defaultCountryCode } from './send.js';

export async function tellWhatsMarketingAboutConsent(input: {
  /** The customer's number, ten digits or with its country code. */
  handle: string;
  subscribed: boolean;
  /** Who did it — a person's name, or "the customer" when they wrote STOP or START. */
  byWhom: string;
}): Promise<boolean> {
  if (activeBusinessProvider()?.name !== WHATSMARKETING_PROVIDER) return false;

  const phone = await withCountryCode(input.handle);
  if (!phone) return false;

  const day = new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
  const note = input.subscribed
    ? `iPropy CRM: subscribed to WhatsApp again on ${day} by ${input.byWhom}.`
    : `iPropy CRM: UNSUBSCRIBED from WhatsApp on ${day} by ${input.byWhom}. Do not message or broadcast to this number.`;

  try {
    await addWhatsMarketingNote(phone, note);
    return true;
  } catch (err) {
    logger.warn({ err }, 'could not leave the unsubscribe note in WhatsMarketing');
    return false;
  }
}

/** Their API wants the country code; the CRM keeps ten digits. */
async function withCountryCode(handle: string): Promise<string | null> {
  const digits = handle.replace(/\D/g, '');
  if (digits.length > 10) return digits;
  if (digits.length !== 10) return null;
  const code = await defaultCountryCode();
  return code ? `${code}${digits}` : null;
}
