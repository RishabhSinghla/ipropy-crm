/**
 * Merge fields — turning "Hi {{first_name}}" into something a person reads.
 *
 * This lived in `integrations/whatsapp/deviceSend.ts` and came out with the
 * rest of WhatsApp on 17 September 2026. It was never WhatsApp's: drip
 * sequences render email and task steps through it too, and an outreach route
 * renders a preview with it. So it moved rather than went.
 */
import { renderTemplate } from '@ipropy/shared';
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { withNameParts } from '../../core/entity/nameParts.js';

/**
 * The organisation's own words, and the fallbacks.
 *
 * "there" is what stops a greeting reading "Hi ," when the record has no name
 * to give — which is most of a freshly captured lead.
 */
async function orgScope(): Promise<Record<string, unknown>> {
  const org = await db.queryOne<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM ipy_setting WHERE key = 'org.name'`,
  );
  return { org_name: org?.value ?? 'iPropy', first_name: 'there', name: 'there' };
}

/** Render against a record read straight from the database. */
export async function renderForRecord(
  body: string,
  recordId: string | null,
  module = 'leads',
): Promise<string> {
  if (!recordId) return renderTemplate(body, await orgScope());
  try {
    const { registry } = await import('../../core/metadata/registry.js');
    const meta = await registry.requireModule(module);
    const row = await db.queryOne<Record<string, unknown>>(
      `SELECT r.label, e.* FROM ipy_record r JOIN ${meta.tableName} e ON e.record_id = r.id WHERE r.id = $1`,
      [recordId],
    );
    if (!row) return renderTemplate(body, await orgScope());

    const label = String(row.label ?? '');
    // `first_name` / `last_name` are derived from `full_name` rather than
    // stored — see core/entity/nameParts.ts.
    return renderTemplate(body, {
      ...(await orgScope()),
      ...withNameParts({ ...row, label }),
    });
  } catch (err) {
    logger.debug({ err, recordId }, 'merge render fell back to org scope');
    return renderTemplate(body, await orgScope());
  }
}

/** Render from a permission-filtered record envelope supplied by an API route. */
export async function renderForValues(
  body: string,
  values: Record<string, unknown>,
  label: string,
): Promise<string> {
  return renderTemplate(body, {
    ...(await orgScope()),
    ...withNameParts({ ...values, label }),
  });
}
