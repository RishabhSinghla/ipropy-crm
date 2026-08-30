/**
 * The one wire between the CRM and n8n.
 *
 * The CRM's half of the deal is small on purpose: when somebody says a
 * property's photos are uploaded, tell n8n the folder and get out of the way.
 * Everything slow — renaming the originals, compressing, watermarking, building
 * the social and website folders — happens in n8n, inside OneDrive. The request
 * that pressed Finish must not wait for any of it and must not fail because of
 * any of it.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *  * **This never throws into its caller.** A dead n8n, a wrong URL, a DNS
 *    failure — none of them may stop somebody finishing a property. Failures
 *    are logged and returned, never raised.
 *  * **This never blocks the response.** It is called without `await` from the
 *    finish handler.
 *
 * The cost of that is real and worth naming: if n8n is down when Finish is
 * pressed, nothing retries. The property sits with its originals in OneDrive
 * and no processed folders beside them, which is visible in the CRM and can be
 * re-triggered by pressing Finish again. That is a
 * deliberate trade — a queue with retries is the right answer once this is
 * doing enough work to deserve one, and the wrong answer while it is one
 * fire-and-forget POST.
 */
import { config } from '../../config.js';
import { db } from '../../db/pool.js';
import { getSettings } from '../../core/settings/integrations.js';
import { logger } from '../../utils/logger.js';
import { getPropertyStorageStatus } from '../../core/storage/propertyFolders.js';

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
/**
 * Words that mean "nothing" but are not empty.
 *
 * A field can be blank, or it can literally say "None" because somebody typed
 * it or an import wrote it. The first is handled by any emptiness check and the
 * second is not, which is how a real property ended up destined for filenames
 * reading `a1818-none-4-bhk`.
 */
const PLACEHOLDERS = new Set(['none', 'n/a', 'na', 'nil', 'null', '-', '--', 'tbd', 'unknown']);

/**
 * `b12-greenfield-4-bhk-250-sqyd`, from whatever the record actually has.
 *
 * Every property field here is read through `to_jsonb(p)->>'…'` rather than by
 * name, and that is not stylistic. `project_name` and `city` were deliberately
 * deleted from this CRM — one area, one kind of stock, so a project grouping was
 * noise. Naming a dropped column in a SELECT is a Postgres 42703, which throws,
 * which meant this function raised every time it ran and took the whole n8n
 * media handoff down with it. Reading the row as JSON turns a missing column
 * into a null, which is what a missing value should be.
 *
 * Anything optional goes through the JSON form. `label` does not: `ipy_record`
 * always has one, and if it ever does not, that is worth an error rather than a
 * folder full of files called `property`.
 */
export async function propertyNamePrefix(recordId: string): Promise<string> {
  const { slug } = await import('../../core/storage/keys.js');
  const row = await db.queryOne<{
    label: string; project_name: string | null; configuration: string | null;
    locality: string | null; plot_area: string | null; area_unit: string | null;
  }>(
    `SELECT r.label,
            to_jsonb(p)->>'project_name'  AS project_name,
            to_jsonb(p)->>'configuration' AS configuration,
            to_jsonb(p)->>'locality'      AS locality,
            to_jsonb(p)->>'plot_area'     AS plot_area,
            to_jsonb(p)->>'area_unit'     AS area_unit
       FROM ipy_record r JOIN ipy_e_properties p ON p.record_id = r.id
      WHERE r.id = $1`,
    [recordId],
  );
  if (!row) return 'property';

  const parts = [row.label, row.project_name, row.locality, row.configuration,
    row.plot_area ? `${row.plot_area} ${row.area_unit ?? ''}` : null]
    .filter((v): v is string => Boolean(v && String(v).trim()))
    .filter((v) => !PLACEHOLDERS.has(String(v).trim().toLowerCase()))
    .map((v) => slug(String(v), 32))
    .filter(Boolean);

  return parts.join('-').slice(0, 90) || 'property';
}

export async function notifyPropertyFinished(recordId: string): Promise<HandoffResult> {
  const url = getSettings().automation.n8nWebhookUrl;
  if (!url) return { sent: false, reason: 'no n8n webhook URL configured' };

  const { propertyFacts } = await import('../../core/storage/propertyDetails.js');
  const { propertyWebsitePath } = await import('../../core/storage/keys.js');

  // Without a folder n8n has nothing to read. This is the ordinary state for a
  // property added seconds ago — the folder is made by a background pass — so
  // it is a reason to wait, not an error.
  const storage = await getPropertyStorageStatus(recordId).catch(() => null);
  if (!storage?.folderKey) {
    return { sent: false, reason: 'the property has no storage folder yet' };
  }
  if (storage.status !== 'ready') {
    return { sent: false, reason: `property folder is ${storage.status}, not ready` };
  }

  const payload = {
    propertyId: recordId,
    folder: storage.folderKey,
    // What every file for this property should be called.
    //
    // IMG_4371.jpg says nothing to a buyer, to Google, or to whoever opens the
    // folder in six months. Built from whatever the record actually has, so a
    // half-filled property still gets a usable name rather than a row of
    // hyphens.
    namePrefix: await propertyNamePrefix(recordId),
    // n8n calls back to us, so it should be told where "us" is rather than
    // guessing from a hardcoded default.
    crmBaseUrl: config.apiUrl,
    // The price, the configuration and the locality, for the title card on the
    // reel and the captions under the photographs.
    //
    // The polling path has sent these since it was written and this one never
    // did, so the same property produced a different video depending on which
    // way the job happened to arrive — a titled one when n8n asked, and one
    // with the unit name printed twice and no price when Finish reached it
    // directly. Two paths into one pipeline have to carry the same job.
    facts: await propertyFacts(recordId),
    // Which folder the finished pictures should be published from. See
    // `propertyWebsitePath`.
    websitePath: await propertyWebsitePath(storage.folderKey),
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
      logger.warn({ status: res.status, recordId }, 'n8n handoff refused');
      return { sent: false, reason };
    }
    logger.info({ recordId, folder: storage.folderKey }, 'n8n handoff accepted');
    return { sent: true };
  } catch (err) {
    // The URL can contain a path someone considers private; log the failure,
    // never the target.
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, recordId }, 'n8n handoff failed');
    return { sent: false, reason };
  }
}
