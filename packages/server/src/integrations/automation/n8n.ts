/**
 * The one wire between the CRM and n8n.
 *
 * The CRM's half of the deal is small on purpose: when a shoot is finished, say
 * so, and get out of the way. Everything slow — reading the photos, judging
 * them, writing the copy — happens in n8n, so the request that closed the
 * session must not wait for any of it and must not fail because of any of it.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *  * **This never throws into its caller.** A dead n8n, a wrong URL, a DNS
 *    failure — none of them may stop a rep closing a site visit. Failures are
 *    logged and returned, never raised.
 *  * **This never blocks the response.** `notifyShootFinished` is called
 *    without `await` from the finish handler.
 *
 * The cost of that is real and worth naming: if n8n is down when the shoot
 * finishes, nothing retries. The session sits `ready` with no content beside
 * it, which is visible in the CRM and re-triggerable by hand. That is a
 * deliberate trade — a queue with retries is the right answer once this is
 * doing enough work to deserve one, and the wrong answer while it is one
 * fire-and-forget POST.
 */
import { config } from '../../config.js';
import { getSettings } from '../../core/settings/integrations.js';
import { logger } from '../../utils/logger.js';
import { getPropertyStorageStatus } from '../../core/storage/propertyFolders.js';
import type { ShootSession } from '../../core/capture/sessions.js';

/** Long enough for n8n to accept the job, far too short to wait for it to run. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface HandoffResult {
  sent: boolean;
  /** Why not, when `sent` is false. Safe to log and to show an admin. */
  reason?: string;
}

export function isConfigured(): boolean {
  return Boolean(getSettings().automation.n8nWebhookUrl);
}

/**
 * Tell n8n a property's photos are ready to work on.
 *
 * Returns rather than throws, so the caller can log the outcome without
 * wrapping the call in a try/catch it would only ever swallow.
 */
export async function notifyShootFinished(session: ShootSession): Promise<HandoffResult> {
  const url = getSettings().automation.n8nWebhookUrl;
  if (!url) return { sent: false, reason: 'no n8n webhook URL configured' };

  // Without a property there is no folder, and without a folder n8n has
  // nothing to read. A visit to something not yet in inventory is a legitimate
  // state (see migration 034), not an error.
  if (!session.recordId) return { sent: false, reason: 'session is not attached to a property' };

  const storage = await getPropertyStorageStatus(session.recordId).catch(() => null);
  if (!storage?.folderKey) {
    return { sent: false, reason: 'the property has no storage folder yet' };
  }
  if (storage.status !== 'ready') {
    return { sent: false, reason: `property folder is ${storage.status}, not ready` };
  }

  const payload = {
    propertyId: session.recordId,
    sessionId: session.id,
    folder: storage.folderKey,
    // n8n calls back to us, so it should be told where "us" is rather than
    // guessing from a hardcoded default.
    crmBaseUrl: config.apiUrl,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const reason = `n8n answered ${res.status}`;
      logger.warn({ status: res.status, sessionId: session.id }, 'n8n handoff refused');
      return { sent: false, reason };
    }
    logger.info({ sessionId: session.id, recordId: session.recordId }, 'n8n handoff accepted');
    return { sent: true };
  } catch (err) {
    // The URL can contain a path someone considers private; log the failure,
    // never the target.
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, sessionId: session.id }, 'n8n handoff failed');
    return { sent: false, reason };
  }
}
