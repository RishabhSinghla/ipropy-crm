/**
 * No query names a column an admin is allowed to delete.
 *
 * This is the single most repeated bug in this codebase — five times by
 * 1 September 2026, and every one of them silent:
 *
 *  * `properties.city` and `properties.project_name` were deleted on purpose.
 *    Three queries still named them, and **both directions of buyer matching
 *    raised on every call** — no buyers for a new unit, no units for a buyer.
 *    Invisible, because callers treat "no matches" and "it threw" identically.
 *    The n8n media handoff went the same way.
 *  * `do_not_call`, `do_not_whatsapp` and `email_opt_out` were deleted on
 *    11 August. Every click-to-call failed and the do-not-disturb flag stopped
 *    appearing on any record, for three weeks.
 *
 * A dropped column is a Postgres 42703 on the whole statement. Nothing catches
 * it in advance: the SQL is a string, the column list is not typed, and the
 * failure usually lands somewhere that logs and carries on.
 *
 * So this reads every query against the two module payload tables — the ones
 * whose columns an admin genuinely can delete through the UI — and checks each
 * named column still exists. Structural tables like `ipy_record` and `ipy_user`
 * are deliberately not covered: nobody can delete those columns, and naming
 * them is correct.
 *
 * The safe patterns, both already used here, are `to_jsonb(p)->>'field'` and
 * the `modelHas(...)` guard in `api/routes/public.ts`. Neither trips this test.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { db } from '../../src/db/pool.js';

const SRC = new URL('../../src/', import.meta.url).pathname;

/** The tables whose columns an admin can add and remove at runtime. */
const DELETABLE_TABLES = ['ipy_e_leads', 'ipy_e_properties'];

const SKIP = ['/db/migrations/', '/db/seed/'];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (extname(entry.name) === '.ts') out.push(full);
  }
  return out.filter((f) => !SKIP.some((s) => f.includes(s)));
}

async function realColumns(table: string): Promise<Set<string>> {
  const rows = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return new Set(rows.rows.map((r) => r.column_name));
}

interface Reference { file: string; line: number; alias: string; column: string; snippet: string }

/**
 * Every `alias.column` in a statement that reads one of the deletable tables.
 *
 * Alias-qualified only, on purpose. A bare column name in a multi-table query
 * cannot be attributed to a table by reading, and guessing would produce noise
 * that gets the whole test disabled.
 */
function referencesIn(source: string, file: string): Reference[] {
  const found: Reference[] = [];

  for (const m of source.matchAll(/`([^`]*?)`/gs)) {
    const sql = m[1] ?? '';
    if (!/\b(SELECT|UPDATE|DELETE|INSERT)\b/i.test(sql)) continue;

    for (const table of DELETABLE_TABLES) {
      // `FROM ipy_e_properties p` / `JOIN ipy_e_leads AS l` / `UPDATE ipy_e_leads`
      const bound = new RegExp(`\\b${table}\\b(?:\\s+(?:AS\\s+)?([a-z][a-z0-9_]*))?`, 'gi');
      for (const t of sql.matchAll(bound)) {
        const alias = t[1] && !/^(set|where|join|on|using|returning|values)$/i.test(t[1]) ? t[1] : null;
        if (!alias) continue;

        for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'g'))) {
          const column = ref[1]!;
          found.push({
            file,
            line: source.slice(0, m.index).split('\n').length,
            alias,
            column,
            snippet: sql.trim().split('\n')[0]!.slice(0, 60),
          });
        }
      }
    }
  }
  return found;
}

/*
  The eighteen direct references that exist today, each one a column that is
  present on production *right now* and could stop being tomorrow.

  This list is a ratchet, not an approval. Checking that a named column exists
  in *this* database proves nothing — it is a fresh seed, so every column
  exists here and none of the five outages this test was written for would have
  been caught. What actually matters is whether the code names a column at all,
  because that is the thing that becomes a 42703 the day an admin removes it.

  On 11 September four of these were live failures on production at once:
  lead capture discarded every inbound enquiry, the public catalogue answered
  an error to every request, buyer matching could not see the price, and
  WhatsApp raised on every personalised greeting. All four were `alias.column`
  references to fields somebody had deleted.

  **The list should only ever get shorter.** Adding to it means writing a new
  query that will fail the same way; rewrite it as `to_jsonb(x)->>'field'` or
  guard it with `modelHas(...)` instead.
*/
const KNOWN_DIRECT_REFERENCES = new Set([
  'ai/assistant.ts l.status',
  'ai/callProposal.ts l.next_followup_at',
  'ai/callProposal.ts l.status',
  // `u.status` is the published-status filter every public query is built on,
  // and it is on FIELDS_USED_IN_CODE, so it cannot be renamed or deleted.
  //
  // The other three left this list on 2026-09-12. `city`, `project_name` and
  // `total_price` were all "guarded by modelHas in the same handler", which
  // was true of the route and not of the expression: /cities is guarded on
  // city and project_name and also reported MIN/MAX of a price that is
  // deleted on production, so putting the website's two missing fields back
  // would have turned that page into a 42703 on the day it was fixed. They go
  // through `pcol()` now, which names the column only if it is there.
  'api/routes/public.ts u.status',
  /*
    Five entries left this list on 2026-09-13, all with the code that held them:
    the softphone lookup in `webhooks.ts` and three in `telephony/service.ts`,
    removed with Exotel and Twilio (migration 141). The guard named them itself
    rather than letting a stale allow-list quietly cover a file that no longer
    exists — which is the failure mode an allow-list usually has.
  */
  'core/locations/index.ts p.latitude',
  'core/locations/index.ts p.longitude',
  'core/workflow/assignment.ts l.next_followup_at',
  'core/workflow/tasks.ts l.email',
  'integrations/whatsapp/service.ts l.mobile',
  'integrations/whatsapp/service.ts l.status',
]);

/** Columns nobody can delete, so naming them is always correct. */
const STRUCTURAL = new Set(['record_id', 'custom_fields']);

/**
 * The columns an `UPDATE ipy_e_leads SET …` assigns to.
 *
 * `referencesIn` above is alias-qualified on purpose, and an UPDATE has no
 * alias to qualify with — it says `SET last_contacted_at = now()`. So six
 * write statements sat outside this test's reach, and on 11 September all six
 * were naming columns production had deleted: logging a call raised 42703
 * after the call row was already written, the provider's status webhook did
 * the same, a WhatsApp device send failed silently inside a catch, and lead
 * scoring's rating write had stopped moving any score at all.
 *
 * Writes go through `core/entity/payloadColumns.ts` now, which asks the
 * database what it has and writes only that.
 */
function assignmentsIn(source: string, file: string): Reference[] {
  const found: Reference[] = [];
  for (const m of source.matchAll(/`([^`]*?)`/gs)) {
    const sql = m[1] ?? '';
    for (const table of DELETABLE_TABLES) {
      for (const u of sql.matchAll(new RegExp(`UPDATE\\s+${table}\\s+SET\\s+([\\s\\S]*?)(?:\\bWHERE\\b|\\bRETURNING\\b|$)`, 'gi'))) {
        for (const a of (u[1] ?? '').matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/g)) {
          found.push({
            file,
            line: source.slice(0, m.index).split('\n').length,
            alias: table,
            column: a[1]!,
            snippet: sql.trim().split('\n')[0]!.slice(0, 60),
          });
        }
      }
    }
  }
  return found;
}

/**
 * `leads.status` is the one assignment left, and it is allowed: it is on
 * `FIELDS_USED_IN_CODE`, so a rename is refused outright and the field is as
 * close to structural as a payload column gets. Everything else belongs in
 * `payloadColumns.ts`.
 */
const KNOWN_ASSIGNMENTS = new Set([
  'api/routes/telephony.ts ipy_e_leads.status',
]);

describe('queries against tables whose columns can be deleted', () => {
  it('never names a column that is not there', async () => {
    const leads = await realColumns('ipy_e_leads');
    const properties = await realColumns('ipy_e_properties');
    const files = await sourceFiles(SRC);

    const broken: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const ref of referencesIn(source, file)) {
        const known = leads.has(ref.column) || properties.has(ref.column);
        if (!known) broken.push(`${relative(SRC, ref.file)}:${ref.line} names ${ref.alias}.${ref.column} — ${ref.snippet}`);
      }
    }
    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('adds no new direct column reference', async () => {
    const files = await sourceFiles(SRC);
    const seen = new Set<string>();
    const added: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const ref of referencesIn(source, file)) {
        if (STRUCTURAL.has(ref.column)) continue;
        const key = `${relative(SRC, ref.file)} ${ref.alias}.${ref.column}`;
        seen.add(key);
        if (!KNOWN_DIRECT_REFERENCES.has(key)) {
          added.push(`${key} — ${ref.snippet}`);
        }
      }
    }

    expect(
      added,
      'This query names a payload column directly, which becomes a 42703 the day '
      + 'an administrator deletes that field — the single most repeated outage in '
      + "this codebase. Use `to_jsonb(x)->>'field'`, or guard it with `modelHas(...)`."
      + `\n\n${added.join('\n')}`,
    ).toEqual([]);

    // And the list shrinks: an entry that no longer matches anything is a
    // reference somebody rewrote, and leaving it here invites the next one.
    const stale = [...KNOWN_DIRECT_REFERENCES].filter((k) => !seen.has(k));
    expect(stale, `Remove these from KNOWN_DIRECT_REFERENCES — they are gone:\n${stale.join('\n')}`).toEqual([]);
  });

  it('writes no payload column directly either', async () => {
    const files = await sourceFiles(SRC);
    const added: string[] = [];

    for (const file of files) {
      // The one file allowed to name these: it checks each against
      // information_schema before writing it.
      if (file.includes('/core/entity/payloadColumns.ts')) continue;
      const source = await readFile(file, 'utf8');
      for (const ref of assignmentsIn(source, file)) {
        if (STRUCTURAL.has(ref.column)) continue;
        const key = `${relative(SRC, ref.file)} ${ref.alias}.${ref.column}`;
        if (!KNOWN_ASSIGNMENTS.has(key)) added.push(`${key} — ${ref.snippet}`);
      }
    }

    expect(
      added,
      'This UPDATE assigns a payload column by name, which becomes a 42703 the '
      + 'day an administrator deletes that field — and unlike a read it fails '
      + 'after other writes have already landed. Use `markContacted` or '
      + '`setIfPresent` from `core/entity/payloadColumns.ts`.'
      + `\n\n${added.join('\n')}`,
    ).toEqual([]);
  });
});
