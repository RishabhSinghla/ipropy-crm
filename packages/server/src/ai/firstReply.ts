/**
 * The reply that is already written when somebody opens the enquiry.
 *
 * First response time is the biggest single lever in this business. A 99acres
 * enquiry lands at 11:40 and gets read at 2pm; in those three hours the buyer
 * has messaged four other brokers and two have already answered. The gap is not
 * that the reply is hard to write. It is that nobody is looking.
 *
 * So it gets written the moment the lead arrives and waits in the queue the
 * team already uses. Somebody opens the lead, reads it, taps send. If they hate
 * it they type over it, which takes exactly as long as typing it would have.
 *
 * **It never sends.** It goes into `ipy_device_send`, which is the hand-off
 * queue: the CRM writes the message, a person taps, and it leaves from their own
 * WhatsApp. No API charge, no automation against WhatsApp's terms, and the
 * customer gets a message from a person rather than from a business account.
 */
import { complete } from './client.js';
import { db } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { featureOn } from '../core/settings/aiFeatures.js';
import { houseStyle } from '../core/settings/houseStyle.js';
import { modelFor } from '../core/settings/aiModels.js';

interface Lead {
  label: string;
  full_name: string | null;
  mobile: string | null;
  whatsapp_number: string | null;
  lead_source: string | null;
  interested_project: string | null;
  configuration: unknown;
  preferred_locations: unknown;
  budget_min: number | null;
  budget_max: number | null;
  possession_timeline: string | null;
  description: string | null;
  owner_id: string | null;
}

function asList(value: unknown): string {
  return Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value ?? '');
}

/**
 * Inventory that actually fits what they asked for.
 *
 * Named in the draft, because "I have two floors that fit" is the sentence that
 * gets a reply and "thank you for your enquiry" is the one that does not. Kept
 * to two: a list of six reads as a mailshot.
 */
async function matchingUnits(lead: Lead): Promise<string[]> {
  const configurations = Array.isArray(lead.configuration) ? lead.configuration.map(String) : [];
  const localities = Array.isArray(lead.preferred_locations) ? lead.preferred_locations.map(String) : [];

  const { rows } = await db.query<{ label: string; configuration: string | null; locality: string | null; base_price: number | null }>(
    `SELECT r.label, p.configuration, p.locality, p.base_price
       FROM ipy_e_properties p
       JOIN ipy_record r ON r.id = p.record_id
      WHERE r.is_deleted = false
        AND p.status = 'Available'
        AND ($1::text[] = '{}' OR p.configuration = ANY($1::text[]))
        AND ($2::text[] = '{}' OR p.locality = ANY($2::text[]))
        AND ($3::numeric IS NULL OR p.base_price <= $3 * 1.15)
      ORDER BY p.updated_at DESC
      LIMIT 2`,
    [configurations, localities, lead.budget_max],
  );
  return rows.map((r) => [r.label, r.configuration, r.locality].filter(Boolean).join(' '));
}

/**
 * Draft a reply and put it in the hand-off queue.
 *
 * Every failure is silent and harmless. No model, no key, no phone number, no
 * feature switch: the lead is captured exactly as it was and somebody types
 * their own message, which is what happens today.
 */
export async function draftFirstReply(recordId: string): Promise<void> {
  try {
    if (!await featureOn('firstReply')) return;

    const lead = await db.queryOne<Lead>(
      `SELECT r.label, l.full_name, l.mobile, l.whatsapp_number, l.lead_source,
              l.interested_project, l.configuration, l.preferred_locations,
              l.budget_min, l.budget_max, l.possession_timeline, l.description, r.owner_id
         FROM ipy_record r JOIN ipy_e_leads l ON l.record_id = r.id
        WHERE r.id = $1 AND r.is_deleted = false`,
      [recordId],
    );
    if (!lead?.mobile && !lead?.whatsapp_number) return;

    // Never twice. A capture that is retried, or two sources landing the same
    // person, must not produce two drafts sitting on one lead.
    // `reason` is what the queue already carries to say why a message exists,
    // so it is the marker rather than a new column.
    const already = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_device_send WHERE record_id = $1 AND reason = 'first_reply' LIMIT 1`,
      [recordId],
    );
    if (already) return;

    const style = await houseStyle();
    const units = await matchingUnits(lead);
    const wanted = [
      lead.interested_project && `asked about ${lead.interested_project}`,
      asList(lead.configuration) && `wants ${asList(lead.configuration)}`,
      asList(lead.preferred_locations) && `in ${asList(lead.preferred_locations)}`,
      lead.budget_max && `budget up to ${lead.budget_max}`,
      lead.possession_timeline && `possession ${lead.possession_timeline}`,
    ].filter(Boolean).join(', ');

    const draft = await complete({
      feature: 'first_reply',
      model: await modelFor('copy'),
      system: 'You write the first WhatsApp a property consultant sends to a new enquiry. '
        + 'You never invent a property, a price, an area or an availability. If nothing is known '
        + 'about what they want, ask rather than guess.',
      prompt: [
        `A new enquiry just came in${lead.lead_source ? ` from ${lead.lead_source}` : ''}.`,
        `Their name: ${lead.full_name || lead.label}`,
        wanted ? `What they asked for: ${wanted}` : 'They gave no details beyond their number.',
        lead.description ? `What they wrote: "${lead.description.slice(0, 500)}"` : '',
        units.length
          ? `Units you actually have that fit: ${units.join('; ')}. Name them.`
          : 'You have nothing matching on file right now, so do not claim you do. Ask what they need.',
        '',
        'Write the WhatsApp to send them right now.',
        `- ${style.captionTone}`,
        `- ${style.voiceLanguage}`,
        '- Under 60 words. It is a first message, not a brochure.',
        '- Use their name once, at the start.',
        '- End with one question that is easy to answer.',
        '- No emoji beyond one, no hashtags, no links, no signature.',
        '',
        'Return only the message.',
      ].filter(Boolean).join('\n'),
      maxTokens: 500,
      temperature: 0.4,
      recordId,
    });
    if (!draft?.text.trim()) return;

    const { queueDeviceSend } = await import('../integrations/whatsapp/deviceSend.js');
    await queueDeviceSend({
      recordId,
      module: 'leads',
      handle: lead.whatsapp_number || lead.mobile || '',
      name: lead.full_name || lead.label,
      body: draft.text.trim(),
      reason: 'first_reply',
      assignedTo: lead.owner_id,
    });
    logger.info({ recordId }, 'first reply drafted and queued for a person to send');
  } catch (err) {
    // A lead that arrives is worth more than a draft that does not.
    logger.warn({ err, recordId }, 'could not draft a first reply');
  }
}
