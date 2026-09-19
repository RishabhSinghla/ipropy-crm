/**
 * Which phone numbers in the CRM could never be rung on a mobile.
 *
 * Counting only. Nothing here writes, and there is deliberately no flag that
 * makes it write — emptying a phone number is a decision, and it is taken
 * after reading this, not by the thing that produced it.
 *
 * The rule is the owner's, stated on 19 September 2026: a proper Indian mobile
 * is **ten digits starting 6, 7, 8 or 9**. Everything else is put in a named
 * bucket rather than one pile called "junk", because the buckets want different
 * answers — a landline is a real number that simply is not a mobile, and
 * 9999999999 is somebody getting past a mandatory field.
 *
 * Three things this does that a single COUNT query would not:
 *
 *  * **It finds the phone fields from the metadata**, not from a list typed
 *    here. Fields are data in this CRM; an admin can add "Owner phone"
 *    tomorrow, and a hard-coded list would quietly stop counting it. It also
 *    means the script cannot break on a production schema that has one fewer
 *    column than a developer's.
 *  * **It counts records, not just values.** "412 bad numbers" and "412 people
 *    we cannot reach" are different sentences, and only the second one matters.
 *    A record with a junk mobile and a good alternate number is not a problem.
 *  * **It masks what it prints.** The samples exist to show the *shape* of a
 *    problem, and a CI log is not the place to reproduce a customer's whole
 *    number, so the last four digits are covered.
 */
import pg from 'pg';

const { Client } = pg;

/* Money and counts read back as numbers elsewhere in this repo; here everything
   is text and the defaults are fine. */
const url = process.env.DATABASE_URL ?? process.env.PROD_DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (or PROD_DATABASE_URL) first.');
  process.exit(1);
}

import { BAD, classify, LABELS, mask } from './lib/phoneQuality.mjs';

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => n.toLocaleString('en-IN');

const client = new Client({
  connectionString: url,
  ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
});
await client.connect();

/*
  The phone fields, asked of the metadata rather than named here. `storage`
  decides where the value actually lives: a real column, or a key inside the
  `custom_fields` JSONB an admin-created field always uses.
*/
const { rows: fields } = await client.query(`
  SELECT m.name AS module, m.label AS module_label, m.table_name,
         f.name, f.label, f.column_name, f.storage
    FROM ipy_field f
    JOIN ipy_module m ON m.id = f.module_id
   WHERE f.uitype = 'phone'
     AND COALESCE(f.is_active, true) AND COALESCE(m.is_active, true)
   ORDER BY m.name, f.name`);

/*
  Rule 6, in a script: every identifier below is pasted into SQL, and all three
  come out of metadata an admin can edit. Anything outside a plain identifier is
  refused here rather than quoted, because there is no legitimate phone field
  whose column is called something needing quotes.
*/
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
for (const f of fields) {
  const bad = [f.table_name, f.column_name ?? 'x', f.name].find((v) => !IDENT.test(v));
  if (bad) { console.error(`Refusing to read an odd identifier: ${bad}`); process.exit(1); }
}

if (!fields.length) {
  console.log('No phone fields found. Nothing to audit.');
  await client.end();
  process.exit(0);
}

const modules = [...new Set(fields.map((f) => f.module))];
const perRecord = new Map(); // module -> Map(recordId -> { good, bad })
const report = [];

for (const module of modules) {
  const mine = fields.filter((f) => f.module === module);
  perRecord.set(module, new Map());

  for (const field of mine) {
    /*
      `to_jsonb` is avoided here on purpose (see CLAUDE.md, Scale): one column
      at a time keeps the same protection against a deleted field and does not
      build a JSON object out of every column of every row.
    */
    const expr = field.storage === 'column'
      ? `p.${field.column_name}`
      : `p.custom_fields ->> '${field.name}'`;

    const { rows } = await client.query(`
      SELECT r.id, ${expr} AS value
        FROM ipy_record r
        JOIN ${field.table_name} p ON p.record_id = r.id
       WHERE r.deleted_at IS NULL`);

    const counts = {};
    const samples = {};
    for (const row of rows) {
      const bucket = classify(row.value ?? '');
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      if (bucket !== 'blank' && bucket !== 'mobile') {
        (samples[bucket] ??= []).length < 8 && samples[bucket].push(mask(row.value));
      }

      if (bucket === 'blank') continue;
      const seen = perRecord.get(module);
      const entry = seen.get(row.id) ?? { good: 0, bad: 0, unsure: 0 };
      /*
        An ambiguous number counts as neither. Folding it into `bad` would put
        a record whose only number might be a perfectly good mobile into the
        "cannot reach them" figure, and that figure is the one somebody acts on.
      */
      if (bucket === 'mobile') entry.good += 1;
      else if (bucket === 'leading_zero') entry.unsure += 1;
      else entry.bad += 1;
      seen.set(row.id, entry);
    }

    report.push({ module, moduleLabel: field.module_label, field, counts, samples, total: rows.length });
  }
}

console.log('');
console.log('='.repeat(78));
console.log('PHONE NUMBERS IN THE CRM — what is a real mobile and what is not');
console.log('='.repeat(78));
console.log('A proper Indian mobile is 10 digits starting 6, 7, 8 or 9.');
console.log('A leading +91 or 91 is removed first, so a number that merely carries');
console.log('its country code is not reported as a problem. A leading 0 is NOT');
console.log('removed: in Indian dialling that is the landline trunk prefix.');
console.log('Nothing is changed by this. It only counts.');

for (const module of modules) {
  const label = report.find((r) => r.module === module)?.moduleLabel ?? module;
  console.log('');
  console.log('-'.repeat(78));
  console.log(`${label.toUpperCase()}  (${module})`);
  console.log('-'.repeat(78));

  for (const entry of report.filter((r) => r.module === module)) {
    const { field, counts, samples, total } = entry;
    const filled = total - (counts.blank ?? 0);
    const bad = BAD.reduce((sum, k) => sum + (counts[k] ?? 0), 0);
    console.log('');
    console.log(`Field: ${field.label} (${field.name})`);
    console.log(`  ${num(total)} records · ${num(filled)} have something in this box · ${num(counts.blank ?? 0)} are empty`);
    if (!filled) { console.log('  Nothing filled in, so nothing to review.'); continue; }
    console.log(`  ${num(counts.mobile ?? 0)} proper mobiles · ${num(bad)} NOT a proper mobile`);
    for (const key of BAD) {
      if (!counts[key]) continue;
      console.log(`    ${pad(LABELS[key], 52)} ${pad(num(counts[key]), 8)}`);
      if (samples[key]?.length) console.log(`      for example: ${samples[key].join(', ')}`);
    }
  }

  /*
    The number that decides anything. A record with a junk mobile and a good
    alternate number loses nothing by having the junk one emptied; a record
    whose only number is a landline loses the one way anybody has of reaching
    that person, and that is the list somebody has to look at first.
  */
  const seen = perRecord.get(module);
  let onlyBad = 0; let mixed = 0; let allGood = 0; let onlyUnsure = 0;
  for (const { good, bad, unsure } of seen.values()) {
    if (good && bad) mixed += 1;
    else if (good) allGood += 1;
    else if (unsure) onlyUnsure += 1;
    else onlyBad += 1;
  }
  console.log('');
  console.log(`  By record (${num(seen.size)} with any number filled in):`);
  console.log(`    ${pad('Every number on them is a proper mobile', 52)} ${num(allGood)}`);
  console.log(`    ${pad('Some good, some not — safe to tidy', 52)} ${num(mixed)}`);
  console.log(`    ${pad('NOT ONE reachable mobile on the record', 52)} ${num(onlyBad)}  <-- read this one first`);
  console.log(`    ${pad('No clear mobile, only a number starting 0', 52)} ${num(onlyUnsure)}  <-- somebody has to look`);
}

console.log('');
console.log('='.repeat(78));
console.log('Nothing was changed. Emptying anything is a separate, deliberate step.');
console.log('='.repeat(78));

await client.end();
