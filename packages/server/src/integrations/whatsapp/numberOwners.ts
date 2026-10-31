import { db } from '../../db/pool.js';
import { getModules } from '../../core/metadata/registry.js';
import { columnsOf } from '../../core/entity/payloadColumns.js';
import { quoteIdent } from '../../core/query/builder.js';
import { matchKey } from './matchContact.js';

/**
 * Everyone in the CRM who holds a phone number, in any module.
 *
 * A WhatsApp chat used to look for a contact in `leads` only, so a number that
 * belongs to the owner of an inventory unit (or a builder-floor house, or a
 * project's sales contact) was offered "Create contact from this chat" as if
 * nobody had it. This reads every phone field of every active module, whether
 * it is a real column or an admin-made field in `custom_fields`.
 *
 * Read-only: it never writes, so showing it cannot create or link anything.
 */

export interface NumberOwner {
  recordId: string;
  module: string;
  moduleLabel: string;
  label: string;
  /** Which number it was found in, e.g. "Mobile" or "Alternate Phone". */
  fieldLabel: string;
}

/** Contacts first, then the other modules in their menu order. */
const CONTACT_MODULE = 'leads';
const PER_NUMBER_LIMIT = 6;
const CACHE_MS = 60_000;

const cache = new Map<string, { at: number; owners: NumberOwner[] }>();

/** The part of a chat handle that is compared: the last ten digits. */
export function ownerKey(handle: string | null | undefined): string | null {
  return matchKey(handle);
}

/** Most relevant first: contacts, then module order, then the main number before an alternate one. */
export function sortOwners(owners: (NumberOwner & { rank: number; fieldRank: number })[]): NumberOwner[] {
  return [...owners]
    .sort((a, b) => {
      const aContact = a.module === CONTACT_MODULE ? 0 : 1;
      const bContact = b.module === CONTACT_MODULE ? 0 : 1;
      return aContact - bContact || a.rank - b.rank || a.fieldRank - b.fieldRank;
    })
    .map(({ rank: _rank, fieldRank: _fieldRank, ...owner }) => owner);
}

/** Owners of each number (keyed by the last ten digits). A number nobody holds is absent. */
export async function findOwnersOfNumbers(handles: (string | null | undefined)[]): Promise<Map<string, NumberOwner[]>> {
  const result = new Map<string, NumberOwner[]>();
  const wanted = new Set<string>();
  const now = Date.now();
  for (const handle of handles) {
    const key = ownerKey(handle);
    if (!key) continue;
    const cached = cache.get(key);
    if (cached && now - cached.at < CACHE_MS) {
      if (cached.owners.length) result.set(key, cached.owners);
    } else {
      wanted.add(key);
    }
  }
  if (!wanted.size) return result;

  const keys = [...wanted];
  const found = new Map<string, (NumberOwner & { rank: number; fieldRank: number })[]>();
  const modules = await getModules({ activeOnly: true, entityOnly: true });

  for (const [rank, module] of modules.entries()) {
    const present = await columnsOf(module.tableName);
    const phoneFields = module.fields.filter((f) => f.uitype === 'phone' && f.isActive);
    for (const [fieldRank, field] of phoneFields.entries()) {
      let source: string;
      if (field.storage === 'column') {
        if (!present.has(field.columnName)) continue;
        source = `to_jsonb(p."${field.columnName}")#>>'{}'`;
      } else {
        if (!present.has('custom_fields')) continue;
        source = `p.custom_fields->>'${field.columnName.replace(/'/g, "''")}'`;
      }
      // Column names above come from the metadata and are checked against
      // information_schema or escaped; the number list is always a parameter.
      const { rows } = await db.query<{ id: string; label: string; key: string }>(
        `SELECT r.id, r.label, k.key
           FROM ipy_record r
           JOIN ${quoteIdent(module.tableName)} p ON p.record_id = r.id
           CROSS JOIN LATERAL (SELECT RIGHT(regexp_replace(COALESCE(${source}, ''), '\\D', '', 'g'), 10) AS key) k
          WHERE r.module_id = $1::uuid AND r.is_deleted = false
            AND k.key = ANY($2::text[])
          ORDER BY r.updated_at DESC`,
        [module.id, keys],
      );
      for (const row of rows) {
        const list = found.get(row.key) ?? [];
        // The same person in the same module via two of their own numbers is one entry.
        if (list.some((o) => o.recordId === row.id)) continue;
        list.push({
          recordId: row.id, module: module.name, moduleLabel: module.singularLabel || module.label,
          label: row.label, fieldLabel: field.label, rank, fieldRank,
        });
        found.set(row.key, list);
      }
    }
  }

  for (const key of keys) {
    const owners = sortOwners(found.get(key) ?? []).slice(0, PER_NUMBER_LIMIT);
    cache.set(key, { at: now, owners });
    if (owners.length) result.set(key, owners);
  }
  return result;
}

/** Forget remembered answers, e.g. after a contact is created or linked. */
export function forgetNumberOwners(): void {
  cache.clear();
}
