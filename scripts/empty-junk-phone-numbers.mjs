/**
 * Empty the phone numbers that are not mobiles. Keep every record.
 *
 * The owner's instruction, 19 September 2026: *"empty those landline and junk
 * numbers, dont delete the record by mistake just empty those numbers got it
 * so set it blank."* So this writes `''` into a box and touches nothing else —
 * no record is deleted, no other field is read or written, and `updated_at` is
 * deliberately left alone (see below).
 *
 * It shares `lib/phoneQuality.mjs` with `audit-phone-numbers.mjs` rather than
 * restating the rules. Two copies of a classifier is how "you said 1,632" and
 * "it emptied 1,700" happen, and there would be no way to tell which was right
 * afterwards.
 *
 * **Looking is the default.** `--apply` is what writes, and every value it
 * clears is copied into `ipy_phone_number_emptied` first, in the same
 * transaction, so any of it can be put back by hand.
 *
 * Two buckets are deliberately NOT emptied, and this is the part worth
 * arguing with rather than changing quietly:
 *
 *  * **A mobile with a digit missing or spare.** That is somebody's real
 *    number one keystroke from working, and the answer to a typo is to correct
 *    it. Emptying it throws away the only clue to what it should be.
 *  * **A number with a 0 in front of a 6-9.** Bangalore is 080 and Ahmedabad
 *    is 079, so it may be a landline or may be a mobile somebody typed a 0 in
 *    front of, and nothing here can tell. One record on production.
 */
import pg from 'pg';
import { classify } from './lib/phoneQuality.mjs';

const { Client } = pg;

/** What "landline and junk" means, stated once, in the owner's terms. */
const EMPTY_THESE = new Set(['landline', 'obvious_junk', 'too_short', 'too_long', 'no_digits']);
/** Judged but kept. Reported so the decision is visible rather than implied. */
const KEEP_THESE = new Set(['wrong_length_mobile', 'leading_zero']);

const apply = process.argv.includes('--apply');
const url = process.env.DATABASE_URL ?? process.env.PROD_DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (or PROD_DATABASE_URL) first.');
  process.exit(1);
}

const num = (n) => n.toLocaleString('en-IN');
const client = new Client({
  connectionString: url,
  ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
});
await client.connect();

const { rows: fields } = await client.query(`
  SELECT m.name AS module, m.label AS module_label, m.table_name,
         f.name, f.label, f.column_name, f.storage
    FROM ipy_field f
    JOIN ipy_module m ON m.id = f.module_id
   WHERE f.uitype = 'phone'
     AND COALESCE(f.is_active, true) AND COALESCE(m.is_active, true)
   ORDER BY m.name, f.name`);

// Rule 6 in a script: these three go into SQL text and all come from metadata.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
for (const f of fields) {
  const bad = [f.table_name, f.column_name ?? 'x', f.name].find((v) => !IDENT.test(v));
  if (bad) { console.error(`Refusing to write through an odd identifier: ${bad}`); process.exit(1); }
}

/*
  The backup. `LIKE` is not used because there is no table to be like: this
  records something that was true before the write, which is a different shape
  from the row it came out of. One row per value cleared, so putting one back
  is a single UPDATE somebody can read.
*/
await client.query(`
  CREATE TABLE IF NOT EXISTS ipy_phone_number_emptied (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id   UUID NOT NULL,
    module      TEXT NOT NULL,
    field       TEXT NOT NULL,
    old_value   TEXT NOT NULL,
    reason      TEXT NOT NULL,
    emptied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

console.log('');
console.log('='.repeat(78));
console.log(apply
  ? 'EMPTYING the phone numbers that are not mobiles'
  : 'LOOKING ONLY — nothing is written. Pass --apply to do it.');
console.log('='.repeat(78));

let totalEmptied = 0; let totalKept = 0;

for (const field of fields) {
  const expr = field.storage === 'column'
    ? `p.${field.column_name}`
    : `p.custom_fields ->> '${field.name}'`;

  const { rows } = await client.query(`
    SELECT r.id, ${expr} AS value
      FROM ipy_record r
      JOIN ${field.table_name} p ON p.record_id = r.id
     WHERE r.deleted_at IS NULL AND COALESCE(${expr}, '') <> ''`);

  const doomed = [];
  const kept = [];
  for (const row of rows) {
    const bucket = classify(row.value);
    if (EMPTY_THESE.has(bucket)) doomed.push({ id: row.id, value: String(row.value), bucket });
    else if (KEEP_THESE.has(bucket)) kept.push(bucket);
  }

  console.log('');
  console.log(`${field.module_label} · ${field.label}`);
  console.log(`  ${num(rows.length)} filled in · ${num(doomed.length)} to empty · ${num(kept.length)} judged but kept`);
  totalEmptied += doomed.length;
  totalKept += kept.length;
  if (!doomed.length || !apply) continue;

  /*
    One transaction for the whole field: the copy and the clear land together
    or neither does. A crash between them would otherwise leave numbers gone
    with no record of what they were, which is the one outcome that cannot be
    undone.
  */
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO ipy_phone_number_emptied (record_id, module, field, old_value, reason)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])`,
      [
        doomed.map((d) => d.id),
        doomed.map(() => field.module),
        doomed.map(() => field.name),
        doomed.map((d) => d.value),
        doomed.map((d) => d.bucket),
      ],
    );

    /*
      `updated_at` is left where it is, on purpose. Every scheduled workflow in
      this CRM is about neglect — "nobody has touched this lead in sixty days"
      — and a tidy-up that stamps 48,000 records as freshly updated would tell
      all of them that every stale record had just been worked on. The audit
      trail of what changed is the backup table above, which is the honest
      place for it.
    */
    const ids = doomed.map((d) => d.id);
    if (field.storage === 'column') {
      await client.query(
        `UPDATE ${field.table_name} SET ${field.column_name} = '' WHERE record_id = ANY($1::uuid[])`,
        [ids],
      );
    } else {
      await client.query(
        `UPDATE ${field.table_name}
            SET custom_fields = jsonb_set(COALESCE(custom_fields, '{}'::jsonb), $2::text[], '""'::jsonb)
          WHERE record_id = ANY($1::uuid[])`,
        [ids, [field.name]],
      );
    }
    await client.query('COMMIT');
    console.log(`  emptied ${num(doomed.length)}, and ${num(doomed.length)} copies kept in ipy_phone_number_emptied`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  FAILED on ${field.module}.${field.name} — nothing changed for this field:`, err.message);
    process.exitCode = 1;
  }
}

console.log('');
console.log('='.repeat(78));
console.log(apply
  ? `Done. ${num(totalEmptied)} boxes set blank. No record was deleted.`
  : `Would empty ${num(totalEmptied)} boxes. Nothing has been changed.`);
console.log(`${num(totalKept)} left alone on purpose: a mobile with a digit missing or spare, and`);
console.log('a number with a 0 in front of a 6-9 that could be either. Both need a person.');
if (apply) {
  const { rows: [back] } = await client.query('SELECT count(*)::int AS n FROM ipy_phone_number_emptied');
  console.log(`ipy_phone_number_emptied now holds ${num(back.n)} rows, each one a number that can be put back.`);
}
console.log('='.repeat(78));

await client.end();
