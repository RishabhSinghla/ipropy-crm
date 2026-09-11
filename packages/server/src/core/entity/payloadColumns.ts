/**
 * Writing to a payload table without naming a column that may be gone.
 *
 * Reads already had two safe patterns — `to_jsonb(x)->>'field'` and
 * `modelHas(...)` in `api/routes/public.ts`. Writes had neither, and
 * `tests/integration/columnsThatCanBeDeleted.test.ts` cannot see them: it
 * matches `alias.column`, and an UPDATE says `SET last_contacted_at = now()`
 * with no alias anywhere. Six statements went through that gap.
 *
 * What they cost on production, where `last_contacted_at`, `contact_attempts`
 * and `rating` have all been permanently deleted:
 *
 *   * Logging a call raised 42703 *after* the call row was written, so the
 *     call was recorded and the lead never moved to Contacted, and the person
 *     who logged it got a 500.
 *   * The provider's own status webhook did the same on every completed
 *     outbound call.
 *   * A WhatsApp device send failed to file — inside a catch, so silently.
 *   * Lead scoring wrote its rating and threw; the caller is a workflow task
 *     that logs and carries on, so scores simply stopped moving. That is the
 *     same statement failing for the fifth time, for the third distinct
 *     reason.
 *
 * None of it was visible. A dropped column is a Postgres error on the whole
 * statement, the SQL is a string, and the failure lands somewhere that logs.
 *
 * So: ask the database which columns it has, and write only those. An admin
 * who deletes a field gets a CRM that records less, which is what they asked
 * for — not one that raises.
 */
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

const cache = new Map<string, Set<string>>();

/** Forget which columns exist. Called whenever an admin changes the model. */
export function invalidatePayloadColumns(): void {
  cache.clear();
}

/** Which columns a table actually has right now. */
export async function columnsOf(table: string, conn: Tx = db): Promise<Set<string>> {
  const known = cache.get(table);
  if (known) return known;
  const { rows } = await conn.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  const set = new Set(rows.map((r) => r.column_name));
  cache.set(table, set);
  return set;
}

/**
 * "Somebody reached this lead."
 *
 * One definition, the way `core/workflow/followUp.ts` is the one definition of
 * "chase them on this date". There were six copies of this UPDATE and they had
 * already drifted — one used `GREATEST` so an out-of-order sync could not move
 * the date backwards, and the other five would happily do exactly that.
 *
 * `ipy_record.last_activity_at` is written unconditionally through
 * `touchActivity`, because that column is structural and nobody can delete it.
 * Everything below is a field an admin may have retired, so each is included
 * only if it is still there.
 */
export async function markContacted(
  recordId: string,
  options: { at?: Date; attempt?: boolean; reached?: boolean } = {},
  conn: Tx = db,
): Promise<void> {
  const present = await columnsOf('ipy_e_leads', conn);
  const sets: string[] = [];
  const params: unknown[] = [recordId];
  const at = options.at ?? null;
  // Rang and nobody answered: an attempt was made and no contact happened, so
  // neither the date nor the pipeline status moves. Only `contact_attempts`
  // does — which is the distinction the original statements drew, and the one
  // worth keeping.
  const reached = options.reached !== false;

  if (reached && present.has('last_contacted_at')) {
    if (at) {
      // Never backwards: a device sync hands over a batch of calls in whatever
      // order it read them, and the most recent one is the answer.
      params.push(at);
      sets.push(`last_contacted_at = GREATEST(COALESCE(last_contacted_at, $${params.length}), $${params.length})`);
    } else {
      sets.push('last_contacted_at = now()');
    }
  }
  if (options.attempt && present.has('contact_attempts')) {
    sets.push('contact_attempts = COALESCE(contact_attempts, 0) + 1');
  }
  if (reached && present.has('status')) {
    sets.push(`status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END`);
  }

  if (sets.length === 0) {
    logger.debug({ recordId }, 'markContacted: the model has none of these fields any more');
    return;
  }
  await conn.query(`UPDATE ipy_e_leads SET ${sets.join(', ')} WHERE record_id = $1`, params);
}

/**
 * Set one optional column, or do nothing if an admin has retired it.
 *
 * For the single-column writes that are not "contacted" — lead scoring's
 * `rating` is the one that was live-broken.
 */
export async function setIfPresent(
  table: string,
  recordId: string,
  column: string,
  value: unknown,
  conn: Tx = db,
): Promise<boolean> {
  const present = await columnsOf(table, conn);
  if (!present.has(column)) {
    logger.debug({ table, column }, 'setIfPresent: field has been removed from the model — skipped');
    return false;
  }
  // `column` is checked against information_schema above, so it is a real
  // identifier and not user input; quoted anyway.
  await conn.query(
    `UPDATE ${table} SET "${column.replace(/"/g, '')}" = $2 WHERE record_id = $1`,
    [recordId, value],
  );
  return true;
}
