import { db } from '../../../db/pool.js';
import { registry } from '../../../core/metadata/registry.js';
import { columnsOf, fieldText } from '../../../core/entity/payloadColumns.js';
import { quoteIdent } from '../../../core/query/builder.js';

/**
 * Which existing contact a WhatsApp number belongs to.
 *
 * The rule from the specification, and the one that matters: **never silently
 * create a second contact**. So this answers one of three things — this record,
 * nobody, or "more than one and I will not choose" — and the caller decides.
 * Guessing between two people with the same number is worse than asking, because
 * the wrong guess files a customer's messages on a stranger.
 *
 * Numbers are compared on their last ten digits. This CRM stores a phone as a
 * country code *and* national digits (migration 026), imported rows carry every
 * shape from `9876543210` to `+91 98765-43210`, and WhatsApp hands back
 * `919876543210@s.whatsapp.net`. Ten digits is what those all agree on for an
 * Indian number, which is every number this business has.
 *
 * Which fields count is read from the module — anything of type `phone` — so a
 * second mobile field an admin adds tomorrow matches without a deploy.
 */

export type ContactMatch =
  | { kind: 'one'; recordId: string; label: string }
  | { kind: 'none' }
  /** Two or more records hold this number. The CRM asks rather than picks. */
  | { kind: 'ambiguous'; candidates: { recordId: string; label: string }[] };

/** `919876543210@s.whatsapp.net` → `+919876543210`. */
export function handleFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const user = jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '');
  return user ? `+${user}` : null;
}

/** The last ten digits, which is what every stored shape of an Indian number agrees on. */
export function matchKey(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export async function matchContact(moduleName: string, handle: string | null): Promise<ContactMatch> {
  const key = matchKey(handle);
  if (!key) return { kind: 'none' };

  const module = await registry.getModule(moduleName);
  if (!module) return { kind: 'none' };

  const phoneFields = module.fields.filter(
    (f) => f.uitype === 'phone' && f.isActive && f.storage === 'column',
  );
  if (!phoneFields.length) return { kind: 'none' };

  const present = await columnsOf(module.tableName);
  /*
    `fieldText` rather than the column directly, and `to_jsonb` under it: a
    field an admin deletes takes its column with it, and a query naming a
    dropped column raises 42703 and takes the whole conversation down. This
    reads NULL instead. `#>>'{}'` and not `::text`, which disagree on some types.
  */
  const comparisons = phoneFields
    .filter((f) => present.has(f.columnName))
    .map((f) => `RIGHT(regexp_replace(COALESCE(${fieldText(present, 'p', f.columnName)}, ''), '\\D', '', 'g'), 10) = $2`);

  if (!comparisons.length) return { kind: 'none' };

  const { rows } = await db.query<{ id: string; label: string }>(
    `SELECT r.id, r.label
       FROM ipy_record r
       JOIN ${quoteIdent(module.tableName)} p ON p.record_id = r.id
      WHERE r.module_id = $1::uuid AND r.is_deleted = false
        AND (${comparisons.join(' OR ')})
      ORDER BY r.updated_at DESC
      LIMIT 5`,
    [module.id, key],
  );

  if (!rows.length) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'one', recordId: rows[0]!.id, label: rows[0]!.label };
  return {
    kind: 'ambiguous',
    candidates: rows.map((r) => ({ recordId: r.id, label: r.label })),
  };
}
