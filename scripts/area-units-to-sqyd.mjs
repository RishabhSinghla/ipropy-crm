#!/usr/bin/env node
/**
 * Retag property areas from square feet to square yards, in batches.
 *
 * `area` holds the number and `area_unit` holds what that number is counted in.
 * A business that quotes in gaj, opened on the `sqft` default, has an inventory
 * whose numbers are already square yards and whose tag says square feet. Every
 * comparison then runs nine times small: `toSqFt` multiplies a sqyd figure by 9
 * and a sqft one by 1, so buyer matching, the public website and every area
 * filter read a 250-gaj floor as a 250-sq-ft one.
 *
 * This only ever moves the tag. The number is never touched — 250 gaj stays
 * 250 — because the numbers were right all along and it was the label that
 * was wrong. Anything already tagged sqyd, or tagged as bigha/acre/sqm, is
 * left exactly as it is.
 *
 * Why a script and not a migration: migration 146 was this job, and had to be
 * gutted. It rewrote history at startup, which on the production cluster can
 * exceed the storage quota and stop the CRM booting. Its own note asks for
 * "a controlled, batched maintenance job" instead, and this is it — small
 * batches, a pause between them, a dry run by default, and nothing written
 * until somebody passes --apply.
 *
 *   node scripts/area-units-to-sqyd.mjs                 # dry run: counts only
 *   node scripts/area-units-to-sqyd.mjs --apply         # do it
 *   node scripts/area-units-to-sqyd.mjs --apply --batch=200
 *   node scripts/area-units-to-sqyd.mjs --apply --revert # tag them back to sqft
 *
 * DATABASE_URL picks the database. Point it at production deliberately, never
 * by accident, and take a backup first (`npm run db:backup`).
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

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows: [target] } = await client.query(
    `SELECT current_database() AS db, count(*)::int AS total
       FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
      WHERE r.is_deleted = false AND coalesce(p.area_unit, 'sqft') = $1`, [from]);

  console.log(`database : ${target.db}`);
  console.log(`retagging: ${from} -> ${to}   (the area numbers are not touched)`);
  console.log(`matching : ${target.total} propert${target.total === 1 ? 'y' : 'ies'}`);

  // A sample, so whoever runs this can see the numbers staying put.
  const { rows: sample } = await client.query(
    `SELECT r.label, p.area, coalesce(p.area_unit, 'sqft') AS unit
       FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
      WHERE r.is_deleted = false AND coalesce(p.area_unit, 'sqft') = $1 AND p.area IS NOT NULL
      ORDER BY r.created_at LIMIT 5`, [from]);
  if (sample.length) {
    console.log('\nfirst few, before and after:');
    for (const s of sample) console.log(`  ${s.label}: ${s.area} ${s.unit}  ->  ${s.area} ${to}`);
  }

  if (!target.total) { console.log('\nNothing to do.'); process.exit(0); }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to make the change.');
    process.exit(0);
  }

  let moved = 0;
  for (;;) {
    // Batched by id so a long transaction never holds the table, and so an
    // interrupted run simply resumes: rows already moved no longer match.
    const { rowCount } = await client.query(
      `UPDATE ipy_e_properties SET area_unit = $2
        WHERE record_id IN (
          SELECT p.record_id FROM ipy_e_properties p JOIN ipy_record r ON r.id = p.record_id
           WHERE r.is_deleted = false AND coalesce(p.area_unit, 'sqft') = $1
           LIMIT ${BATCH})`, [from, to]);
    if (!rowCount) break;
    moved += rowCount;
    console.log(`  ${moved}/${target.total}`);
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  console.log(`\nDone. ${moved} propert${moved === 1 ? 'y' : 'ies'} now tagged ${to}; no area number changed.`);
  console.log(`To undo: node scripts/area-units-to-sqyd.mjs --apply${revert ? '' : ' --revert'}`);
} finally {
  await client.end();
}
