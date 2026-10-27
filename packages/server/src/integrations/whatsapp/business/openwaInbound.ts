/**
 * The two things an OpenWA delivery can say that the official providers
 * cannot: "the business sent this from another device" and "the session
 * changed state".
 *
 * Kept out of `inbound.ts` so the shared inbound path stays about customers
 * writing in. Everything here is idempotent: `recordSentElsewhere` refuses a
 * message the CRM already holds, and the session note is just the latest word.
 */
import { logger } from '../../../utils/logger.js';
import { recordSentElsewhere } from './inbound.js';
import { OPENWA_PROVIDER } from './openwa.js';
import { rememberSessionStatus } from './openwaHealth.js';
import type { WebhookBatch } from './types.js';
import { noteGroupMessages } from '../../../core/market/liveGroups.js';

/**
 * A message the CRM itself just sent is announced by OpenWA a moment before
 * the CRM has written OpenWA's id onto its own row. Recording it straight away
 * would store the same words twice, once as the rep's and once as "sent from
 * another device". So anything very fresh waits long enough for the send to
 * finish, then is checked again against the CRM's own rows.
 */
export const JUST_SENT_MS = 20_000;

export async function handleOpenWaExtras(provider: string, batch: WebhookBatch): Promise<void> {
  if (provider !== OPENWA_PROVIDER) return;

  if (batch.session) rememberSessionStatus(batch.session.status);

  if (batch.groupMessages?.length) {
    try {
      await noteGroupMessages(batch.groupMessages);
    } catch (err) {
      // Group reading is a side job; a failure here must never make OpenWA retry a customer's message.
      logger.error({ err, provider }, 'could not note group messages');
    }
  }

  for (const sent of batch.sentElsewhere ?? []) {
    const age = Date.now() - sent.sentAt.getTime();
    const store = async (): Promise<void> => {
      try {
        await recordSentElsewhere(provider, sent);
      } catch (err) {
        logger.error({ err, provider }, 'could not store a message sent from another device');
      }
    };
    if (age < JUST_SENT_MS) {
      const timer = setTimeout(() => { void store(); }, JUST_SENT_MS - age + 500);
      timer.unref?.();
    } else {
      await store();
    }
  }
}
