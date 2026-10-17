/**
 * Repair two things that went wrong with Facebook leads, through the CRM's own
 * save code so every change is audited like any other edit.
 *
 * 1. **Born "Disqualified".** Until 16 October 2026 a new record was given the
 *    first option of the Lost Reason dropdown, which is "Disqualified". Every
 *    Facebook lead that was not yet lost therefore read as disqualified. The
 *    cause is fixed (`aNewRecordIsNeverBornLost`); this clears the ones already
 *    written. Only a record that came from Facebook, whose stage is not Lost,
 *    and whose reason is exactly "Disqualified" — a Lost record's reason is a
 *    decision somebody made and is never touched.
 *
 * 2. **A form worded differently.** The new form's budget and timeline were
 *    left in the notes (`facebookAnswers.ts` now files them). This files them
 *    for the leads that already arrived, **into empty fields only** — a budget
 *    or timeline somebody already typed is never overwritten.
 *
 * Nothing printed is a name, a number or a record id. An Actions log is not
 * the place for those.
 *
 *   node scripts/fix-facebook-leads.mjs                 # shows what would change
 *   node scripts/fix-facebook-leads.mjs --apply         # makes the changes
 *   node scripts/fix-facebook-leads.mjs --form 2000497250884273   # another form
 */
const apply = process.argv.includes('--apply');
const formIndex = process.argv.indexOf('--form');
const formId = formIndex === -1 ? '2000497250884273' : process.argv[formIndex + 1];
if (!/^\d{5,20}$/.test(formId)) throw new Error('--form must be a Facebook form id (digits only)');

const url = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('PROD_DATABASE_URL is not set');

// Before anything imports config.ts or pool.ts, which bind the connection
// string at module load.
process.env.DATABASE_URL = url;

const { recordService } = await import('../packages/server/dist/core/entity/recordService.js');
const { mapFacebookAnswers } = await import('../packages/server/dist/integrations/leadsources/facebookAnswers.js');
const { registry } = await import('../packages/server/dist/core/metadata/registry.js');
const { db, closePool } = await import('../packages/server/dist/db/pool.js');
const { loadUser } = await import('../packages/server/dist/middleware/auth.js');
const { buildScopeContext } = await import('../packages/server/dist/core/permissions/index.js');

/** An administrator's act, recorded as one, with its own audit source. */
async function administratorScope() {
  const row = await db.queryOne('SELECT id FROM ipy_user WHERE is_admin AND is_active AND deleted_at IS NULL ORDER BY created_at LIMIT 1');
  if (!row) throw new Error('production has no active administrator to attribute this to');
  const user = await loadUser(row.id);
  if (!user) throw new Error('that administrator could not be loaded');
  return { ...(await buildScopeContext(user)), source: 'facebook-lead-repair' };
}

await registry.warmup();
const ctx = await administratorScope();
const leads = await registry.requireModule('leads');
const fieldNamed = (names) => leads.fields.find((f) => f.isActive && names.includes(f.name));
const stageField = fieldNamed(['status', 'lead_status']);
const reasonField = fieldNamed(['lost_reason']);
if (!stageField || !reasonField) throw new Error('this CRM has no stage or lost-reason field to repair');

// ---------------------------------------------------------------------------
// 1. Born "Disqualified"
// ---------------------------------------------------------------------------
const lostStages = (stageField.options ?? [])
  .filter((o) => /lost/i.test(o.value) || /lost/i.test(o.label)).map((o) => o.value);
console.log(`stages that count as Lost:   ${lostStages.join(', ') || '(none found)'}`);
if (!lostStages.length) throw new Error('could not tell which stage is Lost; refusing to guess');

const disqualified = await db.query(
  `SELECT DISTINCT r.id
     FROM ipy_lead_inbox i
     JOIN ipy_record r ON r.id = i.record_id AND NOT r.is_deleted
     JOIN ipy_e_leads l ON l.record_id = r.id
    WHERE i.source = 'facebook'
      AND coalesce(to_jsonb(l)->>$1, l.custom_fields->>$1) = 'Disqualified'
      AND coalesce(to_jsonb(l)->>$2, l.custom_fields->>$2, '') <> ALL($3::text[])`,
  [reasonField.name, stageField.name, lostStages],
);
console.log(`"Disqualified" but not Lost: ${disqualified.rows.length} Facebook contacts`);

// ---------------------------------------------------------------------------
// 2. The new form's answers
// ---------------------------------------------------------------------------
const fromForm = await db.query(
  `SELECT i.record_id AS id, i.raw_payload->'field_data' AS field_data
     FROM ipy_lead_inbox i
     JOIN ipy_record r ON r.id = i.record_id AND NOT r.is_deleted
    WHERE i.source = 'facebook' AND i.raw_payload->>'form_id' = $1`,
  [formId],
);
console.log(`leads from form ${formId}: ${fromForm.rows.length}`);

const toFile = [];
for (const row of fromForm.rows) {
  const record = await recordService.getRecord(ctx, 'leads', row.id);
  const filled = mapFacebookAnswers(row.field_data ?? [], leads.fields, record.values);
  if (Object.keys(filled).length) toFile.push({ id: row.id, filled });
}
console.log(`would be filled:             ${toFile.length} of them`);
toFile.forEach((item, index) => {
  console.log(`  #${index + 1}: ${Object.entries(item.filled).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(', ')}`);
});

if (!apply) {
  console.log('\nRead-only run. Nothing was written. Add --apply to make the changes.');
  await closePool();
  process.exit(0);
}

// Each record is its own save, so one refusal cannot undo the others.
let cleared = 0;
let filledCount = 0;
const refusals = [];
for (const row of disqualified.rows) {
  try {
    await recordService.updateRecord(ctx, 'leads', row.id, { [reasonField.name]: null }, { skipDuplicateCheck: true });
    cleared += 1;
  } catch (error) {
    refusals.push((error instanceof Error ? error.message : String(error)).slice(0, 200));
  }
}
for (const item of toFile) {
  try {
    await recordService.updateRecord(ctx, 'leads', item.id, item.filled, { skipDuplicateCheck: true });
    filledCount += 1;
  } catch (error) {
    refusals.push((error instanceof Error ? error.message : String(error)).slice(0, 200));
  }
}

console.log(`\nLost Reason cleared:         ${cleared}`);
console.log(`new-form answers filed:      ${filledCount}`);
console.log(`refused:                     ${refusals.length}`);
refusals.slice(0, 10).forEach((reason) => console.log(`  ${reason}`));
console.log('Running it again is safe: a cleared reason and a filled field are not matched twice.');

await closePool();
