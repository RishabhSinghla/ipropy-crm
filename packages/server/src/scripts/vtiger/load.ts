/**
 * Step 3: turn the raw NDJSON extract into real iPropy records.
 *
 * Reads `.output/raw/*.ndjson` (written by extract.ts) and nothing from the
 * network — this is a pure database write, safe to re-run. Idempotent two
 * ways: `ipy_record_external_ref` (source='vtiger_contact') means a Contact
 * already loaded is skipped rather than duplicated, and every timeline
 * insert carries `source_external_id` with `ON CONFLICT ... DO NOTHING` for
 * the same reason. Re-running after a partial failure picks up only what's
 * missing.
 *
 * Order matters: Contacts load first and completely, because everything
 * else (notes, meetings, emails) resolves its Vtiger contact id against
 * `ipy_record_external_ref` — an email for a contact that failed to load
 * would otherwise have nowhere to attach.
 */
import { createInterface } from 'node:readline';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthUser } from '@ipropy/shared';
import { db, transaction, type Tx } from '../../db/pool.js';
import { registry } from '../../core/metadata/registry.js';
import { createRecord, type ServiceContext } from '../../core/entity/recordService.js';
import { buildUserCrosswalk, type Crosswalk } from './crosswalk.js';
import {
  transformContact, transformNote, transformTask, transformMeeting,
  transformEmail, transformCall, type VtigerRow,
} from './transform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, '.output', 'raw');
const REPORT_FILE = path.join(__dirname, '.output', 'load-report.json');

// Same fixed system account every unattended write path in this codebase
// uses (integrations/leadsources/capture.ts) — never logs in, no password.
const SYSTEM_USER: AuthUser = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'system@ipropy', firstName: 'iPropy', lastName: 'Migration',
  fullName: 'iPropy Migration', avatarUrl: null, phone: null,
  isAdmin: true, isActive: true, roleId: null, roleName: null,
  profileId: null, profileName: null, groupIds: [],
  timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR',
  theme: 'system', defaultDashboardId: null, lastLoginAt: null,
};
const systemCtx: ServiceContext = { user: SYSTEM_USER, subordinateIds: [], groupIds: [], system: true, source: 'vtiger_migration' };

const RELEVANT_PICKLISTS = ['contact_type', 'lead_source', 'property_type', 'configuration', 'locality', 'lost_reason'];

/**
 * Every `leads` field name `transformContact` can write. Checked against the
 * live schema before a single row loads.
 *
 * This is not paranoia — it already caught a real bug once. `createRecord`
 * silently drops any key that doesn't match a field on the *live* module
 * (`prepareValues`: `if (!field || !field.isActive) continue`), so a field
 * renamed or removed since this file was written fails with no error at
 * all — every row "succeeds" while quietly losing that value. mapping.ts and
 * transform.ts were written against the seed template's *source code*,
 * which is exactly what this codebase's own history says not to trust
 * (fields get renamed constantly; resolve by what the target database
 * actually has). This check is the difference between that showing up here,
 * loudly, before anything is written, and it showing up as "why is every
 * migrated lead's status New" days later.
 */
const REQUIRED_LEAD_FIELDS = [
  'full_name', 'mobile', 'alternate_phone', 'email', 'secondary_email', 'status',
  'contact_type', 'lead_source', 'property_type', 'configuration', 'preferred_locations',
  'lost_reason', 'budget', 'next_followup_at', 'preferred_language', 'qualification_notes',
];

async function checkLeadsSchema(): Promise<void> {
  const module = await registry.requireModule('leads');
  const active = new Set(module.fields.filter((f) => f.isActive).map((f) => f.name));
  const missing = REQUIRED_LEAD_FIELDS.filter((name) => !active.has(name));
  if (missing.length) {
    throw new Error(
      `The leads module in this database has no active field named: ${missing.join(', ')}. `
      + `mapping.ts/transform.ts assume these exist (read from the seed template's source, not this `
      + `database's real schema) — either the template changed, or these were deleted/tombstoned here. `
      + `Fix the mismatch before loading, or every migrated row will silently drop these values.`,
    );
  }
}

interface Report {
  contacts: { created: number; alreadyLoaded: number; failed: { vtigerId: string; reason: string }[] };
  notes: { created: number; orphaned: number };
  tasks: { created: number; orphaned: number };
  meetings: { created: number; orphaned: number };
  emails: { created: number; orphaned: number };
  calls: { created: number; orphaned: number };
  newPicklistValues: { picklist: string; value: string }[];
  unmappedOwners: { vtigerUserId: string; email: string }[];
  warnings: { vtigerId: string; field: string; message: string }[];
}

async function* readNdjson(module: string): AsyncGenerator<VtigerRow> {
  const filePath = path.join(RAW_DIR, `${module}.ndjson`);
  if (!existsSync(filePath)) return;
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line) as VtigerRow;
  }
}

async function loadPicklistSnapshot(): Promise<Record<string, Set<string>>> {
  const snapshot: Record<string, Set<string>> = {};
  for (const name of RELEVANT_PICKLISTS) {
    const options = await registry.getPicklist(name);
    snapshot[name] = new Set(options.map((o) => o.value));
  }
  return snapshot;
}

/**
 * Adds a single option to an existing picklist, never touching its label,
 * colour or other values — `upsertPicklist` (the seed's tool) rewrites the
 * whole definition and would clobber an admin's rename of anything else on
 * it. Respects a tombstone: if this exact value was deliberately deleted
 * once, a migration reintroducing it would silently undo that decision.
 */
async function ensurePicklistValue(conn: Tx, picklistName: string, value: string): Promise<boolean> {
  const tombstoned = await conn.queryOne(
    `SELECT 1 FROM ipy_picklist_tombstone WHERE picklist_name = $1 AND value = $2`,
    [picklistName, value],
  );
  if (tombstoned) return false;
  const picklist = await conn.queryOne<{ id: string }>(`SELECT id FROM ipy_picklist WHERE name = $1`, [picklistName]);
  if (!picklist) return false;
  const seq = await conn.queryOne<{ next: number }>(
    `SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM ipy_picklist_value WHERE picklist_id = $1`,
    [picklist.id],
  );
  await conn.query(
    `INSERT INTO ipy_picklist_value (picklist_id, value, label, sequence)
     VALUES ($1,$2,$3,$4) ON CONFLICT (picklist_id, value) DO NOTHING`,
    [picklist.id, value, value, seq!.next],
  );
  return true;
}

async function loadContacts(crosswalk: Crosswalk, picklists: Record<string, Set<string>>, report: Report): Promise<void> {
  const addedThisRun = new Set<string>(); // "picklist:value" already ensured in this run — avoid redundant DB hits

  for await (const row of readNdjson('Contacts')) {
    const vtigerId = String(row.id ?? '');
    if (!vtigerId) continue;

    const existing = await db.queryOne(
      `SELECT record_id FROM ipy_record_external_ref WHERE source = 'vtiger_contact' AND external_id = $1`,
      [vtigerId],
    );
    if (existing) { report.contacts.alreadyLoaded++; continue; }

    const result = transformContact(row, {
      existingPicklistValues: picklists,
      resolveOwner: (id) => crosswalk.resolve(id),
    });
    for (const w of result.warnings) report.warnings.push({ vtigerId, field: w.field, message: w.message });

    // Committed and made visible to the registry BEFORE the record that
    // needs it is attempted, and deliberately its own transaction rather
    // than nested in the one below: if that one rolls back (a later field
    // fails validation), the picklist addition must not roll back with it —
    // otherwise the same value gets "discovered" and re-added on every
    // subsequent row that also needs it, and the row that failed for an
    // unrelated reason looks like it failed because of a missing value that
    // this script did in fact add.
    if (result.newPicklistValues.length) {
      await transaction(async (tx) => {
        for (const { picklist, value } of result.newPicklistValues) {
          const key = `${picklist}:${value}`;
          if (addedThisRun.has(key)) continue;
          addedThisRun.add(key);
          if (await ensurePicklistValue(tx, picklist, value)) {
            picklists[picklist]?.add(value);
            report.newPicklistValues.push({ picklist, value });
          }
        }
      });
      registry.invalidate(); // must happen before createRecord below reads the picklist
    }

    try {
      await transaction(async (tx) => {
        const values = { ...result.values };
        delete values.owner_id; // undefined would otherwise overwrite createRecord's own default
        if (result.values.owner_id) values.owner_id = result.values.owner_id;

        const record = await createRecord(systemCtx, 'leads', values, { skipDuplicateCheck: true, conn: tx });

        if (result.createdAt || result.updatedAt) {
          await tx.query(
            `UPDATE ipy_record SET created_at = COALESCE($2, created_at), updated_at = COALESCE($3, updated_at) WHERE id = $1`,
            [record.id, result.createdAt ?? null, result.updatedAt ?? null],
          );
        }

        await tx.query(
          `INSERT INTO ipy_record_external_ref (record_id, source, external_id, raw)
           VALUES ($1,'vtiger_contact',$2,$3) ON CONFLICT (source, external_id) DO NOTHING`,
          [record.id, vtigerId, JSON.stringify(row)],
        );
      });
      report.contacts.created++;
    } catch (err) {
      report.contacts.failed.push({ vtigerId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  registry.invalidate(); // picklist values were added directly, not through the admin endpoint
}

async function contactIdMap(): Promise<Map<string, string>> {
  const rows = await db.query<{ external_id: string; record_id: string }>(
    `SELECT external_id, record_id FROM ipy_record_external_ref WHERE source = 'vtiger_contact'`,
  );
  return new Map(rows.rows.map((r) => [r.external_id, r.record_id]));
}

async function loadTimelineNotes(
  module: 'ModComments' | 'Calendar' | 'Events', kind: 'notes' | 'tasks' | 'meetings',
  transformFn: (row: VtigerRow) => { body: string; createdAt?: string; relatedVtigerId: string | undefined; vtigerUserId?: string; isPrivate?: boolean } | null,
  idByVtigerContact: Map<string, string>, crosswalk: Crosswalk, report: Report,
): Promise<void> {
  for await (const row of readNdjson(module)) {
    const mapped = transformFn(row);
    if (!mapped) continue;
    const recordId = mapped.relatedVtigerId ? idByVtigerContact.get(mapped.relatedVtigerId) : undefined;
    if (!recordId) { report[kind].orphaned++; continue; }

    const userId = crosswalk.resolve(mapped.vtigerUserId) ?? SYSTEM_USER.id;
    const sourceExternalId = `vtiger_${module.toLowerCase()}:${String(row.id ?? '')}`;
    const inserted = await db.query(
      `INSERT INTO ipy_comment (record_id, user_id, body, is_private, created_at, source_external_id)
       VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6)
       ON CONFLICT (source_external_id) DO NOTHING`,
      [recordId, userId, mapped.body, mapped.isPrivate ?? false, mapped.createdAt ?? null, sourceExternalId],
    );
    if (inserted.rowCount) report[kind].created++;
  }
}

async function loadEmails(idByVtigerContact: Map<string, string>, report: Report): Promise<void> {
  for await (const row of readNdjson('Emails')) {
    const mapped = transformEmail(row);
    if (!mapped) continue;
    const recordId = mapped.relatedVtigerId ? idByVtigerContact.get(mapped.relatedVtigerId) : undefined;
    if (!recordId) { report.emails.orphaned++; continue; }

    const sourceExternalId = `vtiger_email:${String(row.id ?? '')}`;
    const inserted = await db.query(
      `INSERT INTO ipy_email_log (record_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, body_html, created_at, source_external_id)
       VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7,COALESCE($8, now()),$9)
       ON CONFLICT (source_external_id) DO NOTHING`,
      [
        recordId, mapped.fromAddress ?? null, JSON.stringify(mapped.toAddresses), JSON.stringify(mapped.ccAddresses),
        JSON.stringify(mapped.bccAddresses), mapped.subject ?? null, mapped.bodyHtml ?? null, mapped.createdAt ?? null,
        sourceExternalId,
      ],
    );
    if (inserted.rowCount) report.emails.created++;
  }
}

async function loadCalls(idByVtigerContact: Map<string, string>, crosswalk: Crosswalk, report: Report): Promise<void> {
  for await (const row of readNdjson('PhoneCalls')) {
    const mapped = transformCall(row);
    if (!mapped) continue;
    const recordId = mapped.relatedVtigerId ? idByVtigerContact.get(mapped.relatedVtigerId) : undefined;
    if (!recordId) { report.calls.orphaned++; continue; }

    const sourceExternalId = `vtiger_phonecall:${String(row.id ?? '')}`;
    const inserted = await db.query(
      `INSERT INTO ipy_call (record_id, record_module, direction, from_number, to_number, duration_seconds,
                              recording_url, transcript, notes, provider, started_at, ended_at, source_external_id)
       VALUES ($1,'leads',$2,$3,$4,$5,$6,$7,$8,'vtiger_import',COALESCE($9, now()),$10,$11)
       ON CONFLICT (source_external_id) DO NOTHING`,
      [
        recordId, mapped.direction, mapped.fromNumber, mapped.toNumber, mapped.durationSeconds,
        mapped.recordingUrl ?? null, mapped.transcript ?? null, mapped.notes ?? null,
        mapped.startedAt ?? null, mapped.endedAt ?? null, sourceExternalId,
      ],
    );
    if (inserted.rowCount) report.calls.created++;
  }
}

async function main(): Promise<void> {
  console.log('  Checking the leads schema matches what this migration expects...');
  await checkLeadsSchema();
  console.log('  Schema OK.\n');

  const report: Report = {
    contacts: { created: 0, alreadyLoaded: 0, failed: [] },
    notes: { created: 0, orphaned: 0 },
    tasks: { created: 0, orphaned: 0 },
    meetings: { created: 0, orphaned: 0 },
    emails: { created: 0, orphaned: 0 },
    calls: { created: 0, orphaned: 0 },
    newPicklistValues: [], unmappedOwners: [], warnings: [],
  };

  console.log('  Building the Vtiger-user -> iPropy-user crosswalk...');
  const vtigerUsers: VtigerRow[] = [];
  for await (const row of readNdjson('Users')) vtigerUsers.push(row);
  const crosswalk = await buildUserCrosswalk(db, vtigerUsers);
  report.unmappedOwners = crosswalk.unmapped;
  console.log(`  ${vtigerUsers.length} Vtiger user(s), ${vtigerUsers.length - crosswalk.unmapped.length} matched by email.\n`);

  const picklists = await loadPicklistSnapshot();

  console.log('  Loading Contacts -> leads...');
  await loadContacts(crosswalk, picklists, report);
  console.log(`    created ${report.contacts.created}, already loaded ${report.contacts.alreadyLoaded}, failed ${report.contacts.failed.length}\n`);

  const idByVtigerContact = await contactIdMap();

  console.log('  Loading ModComments -> notes...');
  await loadTimelineNotes('ModComments', 'notes', transformNote, idByVtigerContact, crosswalk, report);
  console.log('  Loading Calendar -> task notes...');
  await loadTimelineNotes('Calendar', 'tasks', transformTask, idByVtigerContact, crosswalk, report);
  console.log('  Loading Events -> meeting notes...');
  await loadTimelineNotes('Events', 'meetings', transformMeeting, idByVtigerContact, crosswalk, report);
  console.log('  Loading Emails...');
  await loadEmails(idByVtigerContact, report);
  console.log('  Loading PhoneCalls...');
  await loadCalls(idByVtigerContact, crosswalk, report);

  await mkdir(path.dirname(REPORT_FILE), { recursive: true });
  await writeFile(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n  ── Load complete ──');
  console.log(`  Contacts: ${report.contacts.created} created, ${report.contacts.alreadyLoaded} already loaded, ${report.contacts.failed.length} failed`);
  console.log(`  Notes: ${report.notes.created} created, ${report.notes.orphaned} orphaned (contact not loaded)`);
  console.log(`  Tasks: ${report.tasks.created} created, ${report.tasks.orphaned} orphaned`);
  console.log(`  Meetings: ${report.meetings.created} created, ${report.meetings.orphaned} orphaned`);
  console.log(`  Emails: ${report.emails.created} created, ${report.emails.orphaned} orphaned`);
  console.log(`  Calls: ${report.calls.created} created, ${report.calls.orphaned} orphaned`);
  console.log(`  New picklist values added: ${report.newPicklistValues.length}`);
  console.log(`  Vtiger users with no email match (owner defaulted to system): ${report.unmappedOwners.length}`);
  console.log(`  Full report: ${REPORT_FILE}\n`);
}

main().catch((err) => {
  console.error('\n  Load failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
