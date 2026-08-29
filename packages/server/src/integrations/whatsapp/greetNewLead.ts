/**
 * The WhatsApp hello a new enquiry gets before anybody has picked up the phone.
 *
 * Someone fills in a Facebook lead form at eleven at night. Under the old
 * behaviour the CRM created the lead, assigned it and started an SLA clock, and
 * the buyer heard nothing until a rep opened the CRM the next morning — by which
 * time they have filled in three other builders' forms too. Speed to first
 * contact is most of what decides who gets the site visit.
 *
 * **This must be a template, not a message.** The person has never messaged the
 * business, so there is no open conversation, and Meta refuses free-form text
 * outside one. `sendWhatsAppForWorkflow` already knows this — and already knows
 * what to do when there is no Business API at all, which is to queue the message
 * for a rep to send from their own WhatsApp rather than pretend it went.
 *
 * Three things it will not do:
 *
 *  * **Message somebody who opted out.** `maySend` is the authority, and it
 *    reads the opt-out table rather than the flag mirrored onto the lead.
 *  * **Message a duplicate.** `captureLead` raises this event only for a lead it
 *    actually created; a repeat enquiry from the same number inside the dedupe
 *    window merges instead, and greeting them again would be the CRM introducing
 *    itself to an existing customer.
 *  * **Fire at all until somebody switches it on** and names an approved
 *    template. A greeting sent from an unapproved template name is a silent
 *    failure at Meta's end and looks, from in here, exactly like success.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { bus } from '../../core/events/bus.js';
import { maySend } from './consent.js';

const ON_KEY = 'whatsapp.greet_new_leads';
const TEMPLATE_KEY = 'whatsapp.greeting_template';

interface Greeting { on: boolean; template: string }

let cached: Greeting | null = null;

export function invalidateGreeting(): void {
  cached = null;
}

export async function greetingSettings(): Promise<Greeting> {
  if (cached) return cached;
  try {
    const { rows } = await db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM ipy_setting WHERE key = ANY($1)`, [[ON_KEY, TEMPLATE_KEY]],
    );
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const template = typeof map.get(TEMPLATE_KEY) === 'string' ? (map.get(TEMPLATE_KEY) as string).trim() : '';
    cached = { on: map.get(ON_KEY) === true, template };
    return cached;
  } catch (err) {
    logger.warn({ err }, 'could not read the lead-greeting settings');
    return { on: false, template: '' };
  }
}

/**
 * Greet one newly captured lead.
 *
 * Never throws into the caller: a greeting that fails must not take the lead
 * down with it. The enquiry is the thing that matters; the hello is a courtesy.
 */
export async function greetLead(recordId: string, source: string): Promise<void> {
  const { on, template } = await greetingSettings();
  if (!on) return;
  if (!template) {
    logger.warn({ recordId }, 'lead greeting is on but no template is named — nothing sent');
    return;
  }

  const lead = await db.queryOne<{ whatsapp_number: string | null; mobile: string | null; owner_id: string | null }>(
    `SELECT whatsapp_number, mobile, owner_id FROM ipy_e_leads WHERE record_id = $1`, [recordId],
  );
  // `whatsapp_number` keeps its full dialable form; `mobile` is national digits
  // only, which the Cloud API will not accept on its own.
  const to = lead?.whatsapp_number ?? null;
  if (!to) {
    logger.debug({ recordId, source }, 'no WhatsApp number on the captured lead — not greeting');
    return;
  }

  const consent = await maySend(to);
  if (!consent.allowed) {
    logger.info({ recordId, reason: consent.reason }, 'not greeting a lead who has opted out');
    return;
  }

  const { sendWhatsAppForWorkflow } = await import('./service.js');
  await sendWhatsAppForWorkflow({
    to,
    templateName: template,
    recordId,
    module: 'leads',
    // The template's variables are bound against the record, so {{1}} can be
    // their name without this function knowing what the template says.
    scope: {},
  });
  logger.info({ recordId, source, template }, 'greeted a new lead on WhatsApp');
}

export function registerLeadGreeting(): void {
  bus.on('lead.captured', async (p: { recordId: string; source: string }) => {
    try {
      await greetLead(p.recordId, p.source);
    } catch (err) {
      logger.warn({ err, recordId: p.recordId }, 'could not greet a new lead');
    }
  });
}
