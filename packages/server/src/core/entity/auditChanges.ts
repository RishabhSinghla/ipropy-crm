/**
 * Turning a stored change into a sentence a person can read.
 *
 * An audit row keeps what was written, exactly: a reference is a UUID, a
 * dropdown is its stored value, money is the integer in the column, and the
 * field label is whatever it was called on the day. All four are wrong to show
 * somebody a month later — "Assigned To: 671d65cc-… → 58f5465a-…" is the shape
 * of the complaint that produced this file.
 *
 * It lives here rather than inside the record timeline because two screens read
 * the same rows: the Changes tab on a record, and the org-wide change log under
 * Admin → System & Audit. The second had no resolution at all, so one edit read
 * as names on one screen and as UUIDs and stored values on the other — and a
 * dropdown's stored value is routinely not the word on screen, which is a
 * confusion this CRM has already paid for once.
 *
 * One resolver, both callers, in the spirit of the one-filter-grammar rule.
 */
import { formatIndianPrice } from '@ipropy/shared';
import { db, type Tx } from '../../db/pool.js';

/** Enough of an audit row to describe its changes. */
export interface AuditRowLike {
  changes: unknown;
  module_name?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fmt = (v: unknown): string => (v === null || v === undefined ? '—' : String(v));

/** Map key for "this field, in this module". Neither part may contain a pipe. */
const at = (module: string | undefined, key: string): string => `${module ?? ''}|${key}`;

/**
 * Rewrite each row's `changes` with the current field label and readable
 * values, leaving everything else on the row untouched.
 *
 * `module` names the module for rows that do not carry one — the record
 * timeline knows it already and its audit query does not select it.
 */
export async function describeChanges<T extends AuditRowLike>(
  rows: T[],
  opts: { conn?: Tx; module?: string } = {},
): Promise<T[]> {
  const conn = opts.conn ?? db;
  if (!rows.length) return rows;

  const modules = new Set<string>();
  const fields = new Set<string>();
  const ids = new Set<string>();

  /*
    Ids are collected by shape, never by field name. Fields get renamed here
    constantly, and a hand-listed set of "the id fields" is what breaks silently
    the next time one moves. A value matching nothing renders as it always did.
  */
  const collect = (v: unknown): void => {
    if (typeof v === 'string' && UUID.test(v)) ids.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
  };

  for (const row of rows) {
    const mod = row.module_name ?? opts.module;
    if (mod) modules.add(mod);
    for (const raw of Array.isArray(row.changes) ? row.changes : []) {
      const change = raw as { field?: unknown; from?: unknown; to?: unknown };
      if (typeof change.field === 'string') fields.add(change.field);
      collect(change.from);
      collect(change.to);
    }
  }

  const idList = [...ids];
  const modList = [...modules];
  const fieldList = [...fields];
  const wantFields = modList.length > 0 && fieldList.length > 0;

  type Named = { id: string; name: string };
  type Labelled = { module: string; key: string; label: string; uitype: string };
  type Option = { module: string; key: string; value: string; label: string };

  const [users, groups, records, labels, options] = await Promise.all([
    idList.length
      ? conn.query<Named>(
        `SELECT id, trim(first_name || ' ' || last_name) AS name FROM ipy_user WHERE id = ANY($1::uuid[])`,
        [idList],
      )
      : { rows: [] as Named[] },
    idList.length
      ? conn.query<Named>(`SELECT id, name FROM ipy_group WHERE id = ANY($1::uuid[])`, [idList])
      : { rows: [] as Named[] },
    idList.length
      ? conn.query<Named>(`SELECT id, label AS name FROM ipy_record WHERE id = ANY($1::uuid[])`, [idList])
      : { rows: [] as Named[] },
    /*
      Matched on the field's name *or* its column, because audit rows are
      written with the column. An audit row also keeps the label the field had
      on the day, and fields get renamed here constantly, so a log read today
      would otherwise be captioned with words that are no longer on the screen
      anywhere ("Owner" for what the record now calls "Assigned To").
    */
    wantFields
      ? conn.query<Labelled>(
        `SELECT DISTINCT ON (m.name, k.key) m.name AS module, k.key, f.label, f.uitype
           FROM ipy_module m
           JOIN ipy_field f ON f.module_id = m.id
           CROSS JOIN LATERAL (VALUES (f.name), (f.column_name)) AS k(key)
          WHERE m.name = ANY($1::text[]) AND k.key = ANY($2::text[])`,
        [modList, fieldList],
      )
      : { rows: [] as Labelled[] },
    /*
      A dropdown has two halves — the label everyone reads and the value every
      record holds — and they are allowed to differ. On this CRM they had
      drifted a long way: the screen said "Lead Won" where the record said
      `Contacted`. Renaming the stored values is the fix that costs something —
      a couple of dozen places match on the word itself, `status = 'Available'`
      being the public website's catalogue — and resolving them here costs
      nothing.
    */
    wantFields
      ? conn.query<Option>(
        `SELECT DISTINCT ON (m.name, k.key, v.value) m.name AS module, k.key, v.value, v.label
           FROM ipy_module m
           JOIN ipy_field f ON f.module_id = m.id
           JOIN ipy_picklist p ON p.name = f.config->>'picklist'
           JOIN ipy_picklist_value v ON v.picklist_id = p.id
           CROSS JOIN LATERAL (VALUES (f.name), (f.column_name)) AS k(key)
          WHERE m.name = ANY($1::text[]) AND k.key = ANY($2::text[])
            AND f.uitype IN ('picklist','radio','multipicklist')`,
        [modList, fieldList],
      )
      : { rows: [] as Option[] },
  ]);

  const nameById = new Map<string, string>();
  // Records, then groups, then users: a person's own name is the most specific
  // answer for an id and should win any collision.
  for (const row of [...records.rows, ...groups.rows, ...users.rows]) {
    if (row.name?.trim()) nameById.set(row.id, row.name.trim());
  }

  const labelByField = new Map(labels.rows.map((r) => [at(r.module, r.key), r.label]));
  const uitypeByField = new Map(labels.rows.map((r) => [at(r.module, r.key), r.uitype]));
  const optionLabel = new Map(options.rows.map((r) => [`${at(r.module, r.key)}|${r.value}`, r.label]));

  /*
    A budget in the feed read `17500000 → 21000000`. That is the number the
    column holds and nobody in this business thinks in it; the same value is
    ₹1.75 Cr everywhere else on the screen. Money and dates are rendered the way
    the rest of the CRM renders them.
  */
  const asTyped = (uitype: string | undefined, v: unknown): string | undefined => {
    if (v === null || v === undefined || v === '') return undefined;
    if (uitype === 'currency' && Number.isFinite(Number(v))) return formatIndianPrice(Number(v));
    if ((uitype === 'date' || uitype === 'datetime') && typeof v === 'string') {
      const when = new Date(v);
      if (!Number.isNaN(when.getTime())) {
        return when.toLocaleDateString('en-IN', {
          day: 'numeric', month: 'short', year: 'numeric',
          ...(uitype === 'datetime' ? { hour: '2-digit', minute: '2-digit' } : {}),
        });
      }
    }
    return undefined;
  };

  const named = (v: unknown): string | undefined => {
    if (typeof v === 'string') return nameById.get(v);
    if (Array.isArray(v)) {
      const parts = v.map((x) => (typeof x === 'string' ? nameById.get(x) : undefined));
      if (parts.some(Boolean)) return parts.map((part, i) => part ?? fmt(v[i])).join(', ');
    }
    return undefined;
  };

  return rows.map((row) => {
    const mod = row.module_name ?? opts.module;
    const changes = (Array.isArray(row.changes) ? row.changes : []).map((raw) => {
      const change = raw as Record<string, unknown>;
      const key = typeof change.field === 'string' ? change.field : undefined;
      const uitype = key ? uitypeByField.get(at(mod, key)) : undefined;

      /** A dropdown value shown as the word the admin typed for it. */
      const chosen = (v: unknown): string | undefined => {
        if (!key) return undefined;
        if (typeof v === 'string') return optionLabel.get(`${at(mod, key)}|${v}`);
        // A multi-select holds several; any one of them may carry a label.
        if (Array.isArray(v)) {
          const parts = v.map((x) => (typeof x === 'string' ? optionLabel.get(`${at(mod, key)}|${x}`) : undefined));
          if (parts.some(Boolean)) return parts.map((part, i) => part ?? String(v[i])).join(', ');
        }
        return undefined;
      };

      const fromDisplay = chosen(change.from) ?? named(change.from) ?? asTyped(uitype, change.from);
      const toDisplay = chosen(change.to) ?? named(change.to) ?? asTyped(uitype, change.to);
      const label = (key ? labelByField.get(at(mod, key)) : undefined) ?? change.label;
      if (fromDisplay === undefined && toDisplay === undefined && label === change.label) return change;
      return {
        ...change,
        label,
        ...(fromDisplay === undefined ? {} : { fromDisplay }),
        ...(toDisplay === undefined ? {} : { toDisplay }),
      };
    });
    return { ...row, changes };
  });
}
