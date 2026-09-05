/**
 * Human-in-the-loop duplicate resolution for CSV imports, and the downloadable
 * result that goes with it.
 *
 * The rule this replaces was a dropdown chosen before the file was opened:
 * skip every collision, or create a second copy of every one. Both are wrong
 * often enough to matter — the sheet usually carries this month's budget and
 * a corrected spelling, and the CRM carries the owner, the call history and a
 * mobile somebody fixed by hand. Which side wins is a per-row judgement.
 *
 * So an import run with `duplicateHandling: 'review'` parks each collision as
 * a row in `ipy_import_row` and finishes. The reviewer opens the job, sees the
 * incoming row beside the record it collided with — field by field, differences
 * marked — and answers one of three things per row:
 *
 *   merge   take the chosen values onto the existing record
 *   skip    the sheet's row is discarded; the CRM is right
 *   create  they are genuinely two people; make the second record
 *
 * Nothing is decided implicitly. A job with unanswered duplicates says so on
 * the jobs list until somebody has been through them.
 */
import { db, transaction } from '../../db/pool.js';
import { registry } from '../metadata/registry.js';
import {
  formatArea, formatDate, formatDateTime, formatIndianPrice, formatPhoneWithCode,
  type FieldMeta,
} from '@ipropy/shared';
import * as recordService from '../entity/recordService.js';
import type { ServiceContext } from '../entity/recordService.js';
import { BadRequestError, NotFoundError } from '../../utils/errors.js';

export type Resolution = 'merged' | 'skipped' | 'created';

interface PendingRow {
  id: string;
  row_number: number;
  values: Record<string, unknown>;
  existing_id: string | null;
  label: string | null;
}

/** One field, as it stands on each side. */
export interface FieldComparison {
  name: string;
  label: string;
  uitype: string;
  incoming: unknown;
  existing: unknown;
  incomingDisplay: string | null;
  existingDisplay: string | null;
  /** The two sides disagree and both are filled in — the only case needing a choice. */
  conflict: boolean;
  /** The sheet has something the record does not. Merged in by default. */
  fillsGap: boolean;
  /**
   * The sheet's column is empty (or was never mapped), so the record's value
   * simply stands. Distinguished from "they agree" because calling it agreement
   * is a claim the sheet never made — and the two want different labels on a
   * screen somebody is using to decide what to overwrite.
   */
  absent: boolean;
  /** This is one of the fields that made them a duplicate in the first place. */
  matched: boolean;
}

export interface DuplicatePair {
  id: string;
  rowNumber: number;
  existingId: string;
  existingLabel: string;
  incomingLabel: string;
  matchedOn: string[];
  fields: FieldComparison[];
  /**
   * The record this row collided with can no longer be read — deleted since
   * the import, or outside this reviewer's sharing rules. There is nothing to
   * compare and nothing to merge into, so only Skip and Create apply.
   */
  existingMissing: boolean;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

/**
 * Same value, allowing for the ways a CSV cell and a stored value differ in
 * shape without differing in meaning: a number that arrived as text, a date
 * with a time on one side, a multipicklist in a different order.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    const la = (Array.isArray(a) ? a : [a]).map(String).sort();
    const lb = (Array.isArray(b) ? b : [b]).map(String).sort();
    return la.length === lb.length && la.every((v, i) => v === lb[i]);
  }
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return String(a).trim() === String(b).trim();
}

/**
 * A value as the reviewer should read it, formatted the way the CRM formats it.
 *
 * This has to run over the *sheet's* side too, not just the record's. Left raw,
 * a currency column read `₹80 L` against `25000000` and a mobile read
 * `+91 9910324679` against `9910324679` — two pairs where the eye reports a
 * difference the data does not have, on exactly the fields somebody is about to
 * make a decision on.
 */
function display(field: FieldMeta, value: unknown): string | null {
  if (isBlank(value)) return null;

  switch (field.uitype) {
    case 'picklist':
      return field.options?.find((o) => o.value === value)?.label ?? String(value);
    case 'multipicklist':
    case 'tags':
      return (Array.isArray(value) ? value : [value])
        .map((v) => field.options?.find((o) => o.value === v)?.label ?? String(v))
        .join(', ');
    case 'currency':
      return Number.isFinite(Number(value)) ? formatIndianPrice(Number(value)) : String(value);
    case 'phone':
      return formatPhoneWithCode(String(field.config?.codePrefix ?? '+91'), String(value));
    case 'area':
      return formatArea(Number(value), 'sqft');
    case 'date':
      return formatDate(String(value));
    case 'datetime':
      return formatDateTime(String(value));
    case 'boolean':
      return value ? 'Yes' : 'No';
    default:
      break;
  }

  if (Array.isArray(value)) return value.map(String).join(', ');
  // A JSON field — the detailed requirement, say. `String(obj)` is
  // "[object Object]", which told the reviewer nothing at all.
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The parked duplicates for a job, each paired with the record it collided
 * with, ready to draw side by side.
 *
 * `matchedOn` is worked out here against the record as it stands *now*, not
 * as it stood during the import: a mobile corrected in between should not
 * leave the screen asserting a match that no longer exists.
 */
export async function pendingDuplicates(
  ctx: ServiceContext,
  jobId: string,
  moduleName: string,
): Promise<DuplicatePair[]> {
  const module = await registry.requireModule(moduleName);
  const rows = await db.query<PendingRow>(
    `SELECT id, row_number, values, existing_id, label
       FROM ipy_import_row
      WHERE job_id = $1 AND outcome = 'duplicate' AND resolution IS NULL
      ORDER BY row_number`,
    [jobId],
  );

  const pairs: DuplicatePair[] = [];
  for (const row of rows.rows) {
    if (!row.existing_id) continue;
    let existing;
    try {
      existing = await recordService.getRecord(ctx, moduleName, row.existing_id, { withDisplay: true });
    } catch {
      /*
        Deleted since the import, or outside this reviewer's sharing rules.
        Reported as such and left pending — emphatically *not* resolved here.

        This read used to auto-create the record when the fetch failed, which
        made a GET write rows: every transient error, every permission gap,
        silently produced the second copy the whole screen exists to prevent,
        and did it on page load where nobody had clicked anything.
      */
      pairs.push({
        id: row.id,
        rowNumber: row.row_number,
        existingId: row.existing_id,
        existingLabel: '',
        incomingLabel: row.label ?? `Row ${row.row_number}`,
        matchedOn: [],
        fields: [],
        existingMissing: true,
      });
      continue;
    }

    const fields: FieldComparison[] = [];
    const matchedOn: string[] = [];
    for (const field of module.fields) {
      if (!field.isActive || field.displayType === 'hidden') continue;
      const incoming = row.values[field.name];
      const current = existing.values[field.name];
      // A field neither side has says nothing; showing it buries the six that
      // do under thirty that do not.
      if (isBlank(incoming) && isBlank(current)) continue;

      const same = sameValue(incoming, current);
      const matched = same && !isBlank(incoming) && module.duplicateCheckFields.includes(field.name);
      if (matched) matchedOn.push(field.label);

      fields.push({
        name: field.name,
        label: field.label,
        uitype: field.uitype,
        incoming: incoming ?? null,
        existing: current ?? null,
        // Both sides go through the same formatter. The record's own display
        // string is preferred where it has one — it resolves references and
        // owner names, which a raw id cannot.
        incomingDisplay: display(field, incoming),
        existingDisplay: existing.display?.[field.name] ?? display(field, current),
        conflict: !same && !isBlank(incoming) && !isBlank(current),
        fillsGap: !isBlank(incoming) && isBlank(current),
        absent: isBlank(incoming),
        matched,
      });
    }

    pairs.push({
      id: row.id,
      rowNumber: row.row_number,
      existingId: row.existing_id,
      existingLabel: existing.label ?? row.existing_id,
      incomingLabel: row.label ?? `Row ${row.row_number}`,
      matchedOn,
      fields,
      existingMissing: false,
    });
  }
  return pairs;
}

/**
 * Answer one parked duplicate.
 *
 * `fieldChoices` names, per field, which side the merge should take. A field
 * left out takes the existing record's value unless the record has nothing
 * there — the sheet filling a blank is not a conflict and does not need to be
 * clicked through one row at a time.
 *
 * Idempotent by construction: the update that claims the row also checks it is
 * still unresolved, so a double-click or a retried request resolves once.
 */
export async function resolve(
  ctx: ServiceContext,
  jobId: string,
  rowId: string,
  action: Resolution,
  fieldChoices: Record<string, 'incoming' | 'existing'>,
  moduleName: string,
): Promise<{ recordId: string | null }> {
  const module = await registry.requireModule(moduleName);

  return transaction(async (tx) => {
    const row = await tx.queryOne<PendingRow>(
      `UPDATE ipy_import_row
          SET resolution = $3, resolved_at = now(), resolved_by = $4
        WHERE id = $1 AND job_id = $2 AND outcome = 'duplicate' AND resolution IS NULL
        RETURNING id, row_number, values, existing_id, label`,
      [rowId, jobId, action, ctx.user.id],
    );
    if (!row) throw new NotFoundError('That duplicate has already been dealt with');

    let recordId: string | null = row.existing_id;

    if (action === 'merged') {
      if (!row.existing_id) throw new BadRequestError('There is no record to merge into');
      const existing = await recordService.getRecord(ctx, moduleName, row.existing_id, { conn: tx, withDisplay: false });
      const updates: Record<string, unknown> = {};
      for (const field of module.fields) {
        if (!field.isActive || field.isReadonly) continue;
        const incoming = row.values[field.name];
        if (isBlank(incoming)) continue;
        const choice = fieldChoices[field.name];
        if (choice === 'existing') continue;
        // Explicitly chosen, or filling a hole. Anything else leaves the
        // record as it is — the safe direction when nobody said otherwise.
        if (choice === 'incoming' || isBlank(existing.values[field.name])) {
          updates[field.name] = incoming;
        }
      }
      if (Object.keys(updates).length) {
        // The merge writes onto a record that already exists, so the duplicate
        // check must not fire on the very record being written to.
        await recordService.updateRecord(ctx, moduleName, row.existing_id, updates, {
          conn: tx, skipDuplicateCheck: true, skipWorkflow: true,
        });
      }
    } else if (action === 'created') {
      const envelope = await recordService.createRecord(ctx, moduleName, row.values, {
        conn: tx, skipDuplicateCheck: true, skipWorkflow: true,
      });
      recordId = envelope.id;
      await tx.query(`UPDATE ipy_import_row SET record_id = $2 WHERE id = $1`, [rowId, envelope.id]);
    }

    await refreshCounts(tx, jobId);
    return { recordId };
  });
}

/** Answer every still-pending duplicate on a job the same way. */
export async function resolveAll(
  ctx: ServiceContext,
  jobId: string,
  action: Resolution,
  moduleName: string,
): Promise<{ resolved: number }> {
  const pending = await db.query<{ id: string }>(
    `SELECT id FROM ipy_import_row
      WHERE job_id = $1 AND outcome = 'duplicate' AND resolution IS NULL
      ORDER BY row_number`,
    [jobId],
  );
  let resolved = 0;
  for (const { id } of pending.rows) {
    // One at a time and tolerant of failure: "merge them all" must not lose
    // the other ninety-nine because row 40 hit a validation rule.
    try {
      await resolve(ctx, jobId, id, action, {}, moduleName);
      resolved += 1;
    } catch {
      // left pending, and still on the screen
    }
  }
  return { resolved };
}

/**
 * Recount the job from its rows.
 *
 * The counters on `ipy_import_job` are what the list and the badge read, and a
 * resolution moves a row between buckets — a merged duplicate is not a skip.
 * Derived rather than incremented so a half-finished review can never leave
 * the numbers describing something that did not happen.
 */
async function refreshCounts(conn: { query: typeof db.query }, jobId: string): Promise<void> {
  await conn.query(
    `UPDATE ipy_import_job j SET
       created_rows   = c.created,
       skipped_rows   = c.skipped,
       failed_rows    = c.failed,
       updated_rows   = c.updated,
       duplicate_rows = c.duplicates,
       pending_rows   = c.pending
     FROM (
       SELECT
         count(*) FILTER (WHERE outcome = 'created' OR resolution = 'created')::int AS created,
         count(*) FILTER (WHERE outcome = 'skipped' OR resolution = 'skipped')::int AS skipped,
         count(*) FILTER (WHERE outcome = 'failed')::int                            AS failed,
         -- A merge is an update, and the job row has always had a column for
         -- exactly that. Counting it as "created" would claim records that were
         -- never made; counting it as "skipped" would hide a real write.
         count(*) FILTER (WHERE resolution = 'merged')::int                         AS updated,
         count(*) FILTER (WHERE outcome = 'duplicate')::int                         AS duplicates,
         count(*) FILTER (WHERE outcome = 'duplicate' AND resolution IS NULL)::int   AS pending
       FROM ipy_import_row WHERE job_id = $1
     ) c
     WHERE j.id = $1`,
    [jobId],
  );
}

// ---------------------------------------------------------------------------
// The downloadable result
// ---------------------------------------------------------------------------

export type Section = 'created' | 'updated' | 'skipped' | 'failed' | 'duplicates' | 'all';

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = Array.isArray(value) ? value.join('; ') : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One section of a finished import as a CSV.
 *
 * The sheet gets the *whole* section, not the first 300 — `ipy_import_job`'s
 * `details` column is a capped preview for the screen, and downloading a
 * truncated result is worse than not offering the download.
 *
 * Every row carries its original line number and its mapped values, so the
 * failed sheet is directly usable: fix the errors in it, save, re-import.
 */
export async function resultCsv(
  jobId: string,
  section: Section,
  moduleName: string,
): Promise<string> {
  const module = await registry.requireModule(moduleName);

  const job = await db.queryOne<{ mapping: Record<string, string> }>(
    `SELECT mapping FROM ipy_import_job WHERE id = $1`, [jobId],
  );
  /*
    Only the columns the sheet actually mapped.

    Every importable field made a sheet forty columns wide with thirty-six of
    them empty, which is unreadable and — for the file this is really for, the
    failed one — actively unhelpful: the point of that download is to fix the
    errors in place and re-import, and it can only be re-imported cleanly if it
    looks like the file that went in.
  */
  const mapped = new Set(Object.values(job?.mapping ?? {}).filter(Boolean));
  const columns = module.fields.filter(
    (f) => mapped.has(f.name) && f.isActive && f.displayType !== 'hidden',
  );

  /*
    A section is the row's *outcome*, which for a reviewed duplicate is what the
    reviewer decided, not the fact that it collided. A duplicate answered "skip"
    belongs in the skipped sheet — it is a row that did not get imported, and
    the counts on the job say so. It stays in the duplicates sheet as well:
    that one answers a different question ("what collided, and what happened to
    it").
  */
  // `merged` is the resolution's word for what the section calls `updated`.
  const effective = `COALESCE(NULLIF(resolution, ''), outcome)`;
  const wanted = section === 'updated' ? 'merged' : section;
  const where = section === 'all'
    ? 'TRUE'
    : section === 'duplicates'
      ? `outcome = 'duplicate'`
      : `${effective} = $2`;

  const rows = await db.query<{
    row_number: number; outcome: string; values: Record<string, unknown>;
    label: string | null; message: string | null; resolution: string | null;
  }>(
    `SELECT row_number, outcome, values, label, message, resolution
       FROM ipy_import_row
      WHERE job_id = $1 AND ${where}
      ORDER BY row_number`,
    section === 'all' || section === 'duplicates' ? [jobId] : [jobId, wanted],
  );

  const header = ['Sheet row', 'Outcome', 'Detail', ...columns.map((f) => f.label)];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows.rows) {
    const outcome = r.outcome === 'duplicate'
      ? (r.resolution ? `duplicate — ${r.resolution}` : 'duplicate — not yet reviewed')
      : r.outcome;
    lines.push([
      r.row_number,
      outcome,
      r.message ?? r.label ?? '',
      ...columns.map((f) => r.values[f.name]),
    ].map(csvCell).join(','));
  }
  // BOM first, same as the import template: without it Excel mangles every
  // accented Indian name in the file.
  return `\uFEFF${lines.join('\n')}\n`;
}
