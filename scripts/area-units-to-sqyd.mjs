#!/usr/bin/env node
/**
 * Retag every area field from square feet to square yards, in batches.
 *
 * An area is two things: `area` holds the number and a companion field holds
 * what that number is counted in. A business that quotes in gaj, opened on the
 * `sqft` default, has records whose numbers are already square yards and whose
 * tag says square feet. Every comparison then runs nine times small — `toSqFt`
 * multiplies a sqyd figure by 9 and a sqft one by 1 — so buyer matching, the
 * public website and every area filter read a 250-gaj floor as a 250-sq-ft one.
 *
 * **It only ever moves the tag.** The number is never touched: 250 gaj stays
 * 250, because the numbers were right all along and it was the label that was
 * wrong. Anything already sqyd, or tagged bigha/acre/sqm, is left alone.
 *
 * **Nothing here names a table or a module.** It asks the metadata which fields
 * are areas (`uitype = 'area'`) and which field each one keeps its unit in
 * (`config.unitField`), so Leads, Inventories and any module an admin adds
 * later are all covered by the same run — and a renamed field does not turn
 * this into a silent no-op. That is the whole point of a metadata-driven CRM:
 * the answer lives in the data, not in this file.
 *
 * Why a script and not a migration: migration 146 was this job and had to be
 * gutted. It rewrote history at startup, which on the production cluster can
 * exceed the storage quota and stop the CRM booting. Its own note asks for
 * "a controlled, batched maintenance job" instead, and this is it — small
 * batches, a pause between them, a dry run by default, and nothing written
 * until somebody passes --apply.
 *
 *   node scripts/area-units-to-sqyd.mjs                  # dry run: counts only
 *   node scripts/area-units-to-sqyd.mjs --apply
 *   node scripts/area-units-to-sqyd.mjs --apply --batch=200
 *   node scripts/area-units-to-sqyd.mjs --apply --revert # tag them back
 *
 * DATABASE_URL picks the database. Point it at production deliberately, never
 * by accident.
 */
import pg from 'pg';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const revert = args.has('--revert');
const batchArg = process.argv.slice(2).find((a) => a.startsWith('--batch='));
const BATCH = Math.max(1, Math.min(1000, Number(batchArg?.split('=')[1] ?? 250) || 250));
const PAUSE_MS = 200;

const from = revert ? 'sqyd' : 'sqft';
const to = revert ? 'sqft' : 'sqyd';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess which database to write to.');
  process.exit(1);
}

/** Postgres identifiers, the same rule the query builder enforces. */
const ident = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`refusing unsafe identifier: ${name}`);
  return `"${name}"`;
};

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows: [{ db }] } = await client.query('SELECT current_database() AS db');
  console.log(`database : ${db}`);
  console.log(`retagging: ${from} -> ${to}   (the area numbers are not touched)\n`);

  // Every area field, and the field it keeps its unit in — from metadata.
  const { rows: areas } = await client.query(`
    SELECT m.name AS module, m.table_name, f.name AS field, f.storage,
           f.config->>'unitField' AS unit_field
      FROM ipy_field f
      JOIN ipy_module m ON m.id = f.module_id
     WHERE f.uitype = 'area' AND f.is_active
     ORDER BY m.name, f.sequence
  `);

  if (!areas.length) { console.log('No area fields in this CRM. Nothing to do.'); process.exit(0); }

  let grandTotal = 0;
  const targets = [];

  for (const a of areas) {
    if (!a.unit_field) {
      console.log(`  ${a.module}.${a.field}: skipped — no unitField in its config, so nothing says what it is counted in`);
      continue;
    }
    // The unit is a field in its own right; ask metadata where it is stored.
    const { rows: [unit] } = await client.query(
      `SELECT column_name, storage FROM ipy_field f JOIN ipy_module m ON m.id = f.module_id
        WHERE m.name = $1 AND f.name = $2`, [a.module, a.unit_field]);

    if (!unit || unit.storage !== 'column') {
      console.log(`  ${a.module}.${a.field}: skipped — its unit (${a.unit_field}) is not a real column`);
      continue;
    }

    const table = ident(a.table_name);
    const col = ident(unit.column_name);
    const { rows: [{ total }] } = await client.query(
      `SELECT count(*)::int AS total FROM ${table} e JOIN ipy_record r ON r.id = e.record_id
        WHERE r.is_deleted = false AND coalesce(e.${col}, 'sqft') = $1`, [from]);

    console.log(`  ${a.module}.${a.field} (unit in ${a.unit_field}): ${total} record(s) tagged ${from}`);
    grandTotal += total;
    if (total) targets.push({ ...a, table, col, total });
  }

  if (!grandTotal) { console.log('\nNothing to do.'); process.exit(0); }

  // A sample, so whoever runs this can see the numbers staying put.
  const first = targets[0];
  const { rows: sample } = await client.query(
    `SELECT r.label, e.${ident(first.field)} AS value, coalesce(e.${first.col}, 'sqft') AS unit
       FROM ${first.table} e JOIN ipy_record r ON r.id = e.record_id
      WHERE r.is_deleted = false AND coalesce(e.${first.col}, 'sqft') = $1
        AND e.${ident(first.field)} IS NOT NULL
      ORDER BY r.created_at LIMIT 5`, [from]).catch(() => ({ rows: [] }));
  if (sample.length) {
    console.log('\nfirst few, before and after:');
    for (const s of sample) console.log(`  ${s.label}: ${s.value} ${s.unit}  ->  ${s.value} ${to}`);
  }

  if (!apply) {
    console.log(`\nDry run — ${grandTotal} record(s) would be retagged, none written. Re-run with --apply.`);
    process.exit(0);
  }

  let moved = 0;
  for (const t of targets) {
    for (;;) {
      // Batched by id so a long transaction never holds the table, and so an
      // interrupted run simply resumes: rows already moved no longer match.
      const { rowCount } = await client.query(
        `UPDATE ${t.table} SET ${t.col} = $2
          WHERE record_id IN (
            SELECT e.record_id FROM ${t.table} e JOIN ipy_record r ON r.id = e.record_id
             WHERE r.is_deleted = false AND coalesce(e.${t.col}, 'sqft') = $1
             LIMIT ${BATCH})`, [from, to]);
      if (!rowCount) break;
      moved += rowCount;
      console.log(`  ${t.module}: ${moved}/${grandTotal}`);
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  console.log(`\nDone. ${moved} record(s) now tagged ${to}; no area number changed.`);
  console.log(`To undo: node scripts/area-units-to-sqyd.mjs --apply${revert ? '' : ' --revert'}`);
} finally {
  await client.end();
}
