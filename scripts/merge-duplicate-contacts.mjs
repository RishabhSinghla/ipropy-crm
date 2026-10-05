/**
 * Merge the duplicate mobile numbers in production, through the CRM's own
 * consolidation code.
 *
 * The normal door is Tools → "Merge duplicate contacts into Leads", where an
 * administrator ticks a box and presses a button. That needs somebody signed
 * in to production, and the person who builds this cannot sign in — the same
 * reason `check-prod.yml` exists.
 *
 * This calls `mergeContactGroup` and `previewContactMerge`, the identical two
 * functions the button calls, so there is one implementation of a merge rather
 * than two that drift. Each group commits on its own, keeps an archive of the
 * original records and their relationships, and rolls back whole if anything
 * about it is unsafe.
 *
 * Nothing printed below is a customer name, a phone number or a record id. An
 * Actions log is not the place for those.
 *
 *   node scripts/merge-duplicate-contacts.mjs                  # shows what would happen
 *   node scripts/merge-duplicate-contacts.mjs --apply          # merges every group
 *   node scripts/merge-duplicate-contacts.mjs --apply --limit 1  # the cautious first step
 */
const apply = process.argv.includes('--apply');
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex === -1 ? null : Number(process.argv[limitIndex + 1]) || null;

const url = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('PROD_DATABASE_URL is not set');

// Before anything imports config.ts or pool.ts, which bind the connection
// string at module load. dotenv never overwrites a value already present.
process.env.DATABASE_URL = url;

const { previewContactMerge, mergeContactGroup } = await import('../packages/server/dist/core/entity/contactMerge.js');
const { registry } = await import('../packages/server/dist/core/metadata/registry.js');
const { db, closePool } = await import('../packages/server/dist/db/pool.js');
const { loadUser } = await import('../packages/server/dist/middleware/auth.js');
const { buildScopeContext } = await import('../packages/server/dist/core/permissions/index.js');

/** A merge is an administrator's act, and it is recorded as one. */
async function administratorScope() {
  const row = await db.queryOne('SELECT id FROM ipy_user WHERE is_admin AND is_active AND deleted_at IS NULL ORDER BY created_at LIMIT 1');
  if (!row) throw new Error('production has no active administrator to attribute this to');
  const user = await loadUser(row.id);
  if (!user) throw new Error('that administrator could not be loaded');
  return { ...(await buildScopeContext(user)), source: 'duplicate-merge' };
}

function mixOf(group) {
  return [...new Set(group.members.map(member => member.module))].sort().join('+');
}

function countBy(groups, keyOf) {
  const counts = new Map();
  for (const group of groups) counts.set(keyOf(group), (counts.get(keyOf(group)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

await registry.warmup();
const ctx = await administratorScope();
const preview = await previewContactMerge(ctx);
const groups = limit === null ? preview.groups : preview.groups.slice(0, limit);

console.log(`duplicate groups:  ${preview.groups.length}${limit === null ? '' : ` (this run takes ${groups.length})`}`);
console.log(`records involved:  ${preview.records}`);
console.log(`leaving out:       ${preview.review} number groups that are not ordinary Indian mobiles`);
console.log(`new leads needed:  ${groups.filter(group => group.members.every(member => member.module !== 'leads')).length} groups with no existing Lead`);
console.log('groups by the modules they join:');
for (const [mix, count] of countBy(groups, mixOf)) console.log(`  ${String(count).padStart(4)}  ${mix}`);

if (!apply) {
  console.log('\nRead-only run. Nothing was written. Add --apply to merge them.');
  await closePool();
  process.exit(0);
}

// Every group is its own transaction. A group that cannot be merged safely
// rolls back whole and is reported; it never half-merges and never deletes.
let merged = 0;
let hidden = 0;
let created = 0;
const refusals = [];
for (const group of groups) {
  try {
    const result = await mergeContactGroup(ctx, group);
    merged += 1;
    hidden += Number(result.archived ?? 0);
    if (group.members.every(member => member.module !== 'leads')) created += 1;
  } catch (error) {
    refusals.push({ key: group.key, size: group.members.length, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
  }
  if ((merged + refusals.length) % 25 === 0) console.log(`  … ${merged + refusals.length}/${groups.length}`);
}

console.log(`\nmerged:            ${merged} groups`);
console.log(`records hidden:    ${hidden} (kept, not deleted — every one is in the merge archive)`);
console.log(`new leads:         ${created}`);
console.log(`refused:           ${refusals.length}`);
for (const refusal of refusals.slice(0, 20)) console.log(`  ${refusal.size} records: ${refusal.reason}`);
if (refusals.length > 20) console.log(`  … and ${refusals.length - 20} more`);

const remaining = await previewContactMerge(ctx);
console.log(`\nduplicate groups still showing: ${remaining.groups.length}`);
console.log('Run this again to retry anything refused; a group already merged is returned untouched.');

await closePool();
