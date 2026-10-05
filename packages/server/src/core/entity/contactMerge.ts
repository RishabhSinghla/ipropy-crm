import crypto from 'node:crypto';
import type { FieldMeta, ModuleMeta, RecordEnvelope } from '@ipropy/shared';
import { db, transaction, type Tx } from '../../db/pool.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../../utils/errors.js';
import { registry } from '../metadata/registry.js';
import { fieldExpr, quoteIdent } from '../query/builder.js';
import { mobileIdentities } from './mobileIdentity.js';
import { recordService, type ServiceContext } from './recordService.js';

// This is the owner's contact-consolidation tool, not a second CRUD engine.
const contactModules = ['leads', 'properties', 'associates'];
export interface MergeMember { id: string; module: string; updatedAt: string; label: string }
export interface MergeGroup { key: string; members: MergeMember[] }
type Loaded = { module: ModuleMeta; record: RecordEnvelope };
const blank = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
const normalLabel = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, '');
const isStage = (m: ModuleMeta, f: FieldMeta) => f.name === m.pipelineField || f.columnName === m.pipelineField || f.columnName === 'status';
const houseField = (m: ModuleMeta) => m.fields.find(f => f.isActive && f.uitype === 'string'
  && (['houseno', 'housenumber', 'unitnumber'].includes(normalLabel(f.label)) || ['unit_no', 'unit_number', 'house_no', 'house_number'].includes(f.name)));
const score = (r: RecordEnvelope) => Object.values(r.values).filter(v => !blank(v)).length;
function adminOnly(ctx: ServiceContext): void {
  if (!ctx.user.isAdmin) throw new ForbiddenError('Only an administrator can consolidate duplicate contacts');
}

/** Connected groups matter: primary/alternate bridges must not run twice. */
export async function previewContactMerge(ctx: ServiceContext): Promise<{ groups: MergeGroup[]; records: number; review: number }> {
  adminOnly(ctx);
  const all = new Map<string, { member: MergeMember; numbers: Set<string> }>();
  const numbers = new Map<string, Set<string>>();
  let review = 0;
  for (const name of contactModules) {
    const m = await registry.getModule(name);
    if (!m?.isActive || !m.isEntity) continue;
    const fields = m.fields.filter(f => f.isActive && f.uitype === 'phone');
    if (!fields.length) continue;
    const pairs = fields.flatMap(f => [`'${f.name.replace(/'/g, "''")}'`, fieldExpr(f)]).join(',');
    const rows = await db.query<{ id: string; label: string; updated_at: Date; values: Record<string, unknown> }>(
      `SELECT r.id,r.label,r.updated_at,jsonb_build_object(${pairs}) AS values
       FROM ipy_record r JOIN ${quoteIdent(m.tableName)} e ON e.record_id=r.id
       WHERE r.module_id=$1 AND r.is_deleted=false`, [m.id]);
    for (const r of rows.rows) {
      const phones = mobileIdentities(m, r.values);
      all.set(r.id, { member: { id: r.id, module: name, label: r.label, updatedAt: r.updated_at.toISOString() }, numbers: phones });
      for (const phone of phones) {
        if (!numbers.has(phone)) numbers.set(phone, new Set());
        numbers.get(phone)!.add(r.id);
      }
    }
  }
  const adjacent = new Map<string, Set<string>>();
  for (const [phone, ids] of numbers) {
    if (ids.size < 2) continue;
    if (!/^[6-9]\d{9}$/.test(phone)) { review++; continue; }
    for (const id of ids) {
      if (!adjacent.has(id)) adjacent.set(id, new Set());
      for (const other of ids) adjacent.get(id)!.add(other);
    }
  }
  const seen = new Set<string>();
  const groups: MergeGroup[] = [];
  for (const start of adjacent.keys()) {
    if (seen.has(start)) continue;
    const pending = [start]; const members: MergeMember[] = [];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id); members.push(all.get(id)!.member);
      for (const next of adjacent.get(id)!) if (!seen.has(next)) pending.push(next);
    }
    members.sort((a, b) => a.id.localeCompare(b.id));
    groups.push({ key: crypto.createHash('sha256').update(JSON.stringify(members)).digest('hex'), members });
  }
  return { groups, records: seen.size, review };
}

function sourceField(target: FieldMeta, targetModule: ModuleMeta, source: ModuleMeta): FieldMeta | undefined {
  const fields = source.fields.filter(f => f.isActive && !isStage(source, f));
  const compatible = fields.filter(f => f.uitype === target.uitype);
  return compatible.find(f => f.name === target.name)
    ?? compatible.find(f => f.columnName && f.columnName === target.columnName)
    ?? compatible.find(f => normalLabel(f.label) === normalLabel(target.label))
    // Demand/Budget and Second/Alternate phone have different labels, but one
    // destination slot. Preserve any other conflicting values in the archive.
    ?? (target.uitype === 'currency' && targetModule.fields.filter(f => f.isActive && f.uitype === 'currency').length === 1 && compatible.length === 1 ? compatible[0] : undefined)
    ?? (target.uitype === 'phone' && target.name !== 'mobile' ? compatible.find(f => f.name !== 'mobile') : undefined);
}

export function mergedValues(target: ModuleMeta, loaded: Loaded[], primary?: RecordEnvelope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of target.fields) {
    if (!field.isActive || field.isReadonly || field.uitype === 'autonumber' || isStage(target, field)) continue;
    let value = primary?.values[field.name];
    for (const source of loaded) {
      if (!blank(value)) break;
      const match = sourceField(field, target, source.module);
      if (match) value = source.record.values[match.name];
    }
    if (!blank(value)) out[field.name] = value;
  }
  const house = houseField(target);
  if (house) {
    const houses: string[] = [];
    const seen = new Set<string>();
    for (const value of [primary?.values[house.name], ...loaded.map(s => {
      const f = houseField(s.module); return f ? s.record.values[f.name] : null;
    })]) {
      for (const part of String(value ?? '').split(',')) {
        const trimmed = part.trim(); const key = trimmed.toLowerCase();
        if (trimmed && !seen.has(key)) { houses.push(trimmed); seen.add(key); }
      }
    }
    if (houses.length) out[house.name] = houses.join(', ');
  }
  if (!primary) {
    const stage = target.fields.find(f => isStage(target, f));
    if (stage) out[stage.name] = stage.defaultValue ?? stage.options?.[0]?.value;
    out.owner_id = loaded[0]!.record.ownerId;
  }
  return out;
}

type Reference = { table_name: string; column_name: string };
async function references(conn: Tx): Promise<Reference[]> {
  const result = await conn.query<Reference>(
    `SELECT DISTINCT t.relname AS table_name,a.attname AS column_name
     FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
     JOIN pg_namespace n ON n.oid=t.relnamespace
     JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=c.conkey[1]
     WHERE c.contype='f' AND c.confrelid='ipy_record'::regclass
       AND array_length(c.conkey,1)=1 AND n.nspname=current_schema()
       AND NOT (t.relname LIKE 'ipy_e_%' AND a.attname='record_id')`);
  return result.rows;
}

/** One durable transaction per group; stale/replayed requests cannot lose data. */
export async function mergeContactGroup(ctx: ServiceContext, group: MergeGroup): Promise<Record<string, unknown>> {
  adminOnly(ctx);
  if (group.members.length < 2 || group.members.length > 100 || new Set(group.members.map(r => r.id)).size !== group.members.length
    || group.members.some(r => !contactModules.includes(r.module))) throw new BadRequestError('Invalid contact merge group');
  return transaction(async conn => {
    await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`contact-merge:${group.key}`]);
    const previous = await conn.queryOne<{ result: Record<string, unknown> }>('SELECT result FROM ipy_record_merge_archive WHERE batch_key=$1', [group.key]);
    if (previous) {
      const { after: _after, ...result } = previous.result;
      return result;
    }
    const ids = group.members.map(r => r.id).sort();
    const rows = await conn.query<{ id: string; updated_at: Date; is_deleted: boolean; module_name: string }>(
      'SELECT id,updated_at,is_deleted,module_name FROM ipy_record WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    if (rows.rows.length !== ids.length || rows.rows.some(r => {
      const member = group.members.find(m => m.id === r.id)!;
      return r.is_deleted || r.module_name !== member.module || r.updated_at.toISOString() !== member.updatedAt;
    })) throw new ConflictError('A record changed after the preview. Refresh the merge preview before continuing.');
    const active = await conn.queryOne(`SELECT 1 AS active FROM ipy_call
      WHERE (record_id=ANY($1::uuid[]) OR contact_id=ANY($1::uuid[])) AND ended_at IS NULL
      AND status IN('queued','ringing','initiated','in-progress','in_progress','answered')
      AND started_at>now()-interval '6 hours'
      UNION ALL SELECT 1 FROM ipy_device_command WHERE record_id=ANY($1::uuid[])
      AND status IN('queued','delivered') AND expires_at>now() LIMIT 1`, [ids]);
    if (active) throw new ConflictError('A call is active or waiting on one of these records. Finish it and refresh the preview.');
    const loaded: Loaded[] = [];
    for (const member of group.members) loaded.push({ module: await registry.requireModule(member.module), record: await recordService.getRecord(ctx, member.module, member.id, { conn, withDisplay: false }) });
    // Revalidate the connected mobile group on the locked, current records.
    const connected = new Set([loaded[0]!.record.id]);
    const phones = new Set(mobileIdentities(loaded[0]!.module, loaded[0]!.record.values));
    for (let pass = 0; pass < loaded.length; pass++) for (const item of loaded) {
      const ns = mobileIdentities(item.module, item.record.values);
      if ([...ns].some(n => /^[6-9]\d{9}$/.test(n) && phones.has(n))) {
        connected.add(item.record.id); ns.forEach(n => phones.add(n));
      }
    }
    if (connected.size !== loaded.length) throw new BadRequestError('These records do not share a connected duplicate mobile');
    loaded.sort((a, b) => Number(b.module.name === 'leads') - Number(a.module.name === 'leads') || score(b.record) - score(a.record) || a.record.createdAt.localeCompare(b.record.createdAt));
    const target = await registry.requireModule('leads');
    const primary = loaded.find(s => s.module.name === target.name)?.record;
    if (!houseField(target) && loaded.some(s => {
      const f = houseField(s.module); return f && !blank(s.record.values[f.name]);
    })) throw new BadRequestError('Add a House No. field in Leads before merging records that have house numbers');
    const values = mergedValues(target, loaded, primary);
    const refs = await references(conn);
    const related: Record<string, unknown[]> = {};
    for (const ref of refs) related[`${ref.table_name}.${ref.column_name}`] = (await conn.query(
      `SELECT to_jsonb(t) AS row FROM ${quoteIdent(ref.table_name)} t WHERE ${quoteIdent(ref.column_name)}=ANY($1::uuid[])`, [ids])).rows;
    const audit = (await conn.query('SELECT * FROM ipy_audit WHERE record_id=ANY($1::uuid[])', [ids])).rows;
    const links = (await conn.query('SELECT * FROM ipy_record_link WHERE source_id=ANY($1::uuid[]) OR target_id=ANY($1::uuid[])', [ids])).rows;
    const tags = (await conn.query('SELECT * FROM ipy_tag WHERE id IN(SELECT tag_id FROM ipy_tag_link WHERE record_id=ANY($1::uuid[]))', [ids])).rows;
    await conn.query('INSERT INTO ipy_record_merge_archive(batch_key,actor_id,snapshot) VALUES($1,$2,$3)',
      [group.key, ctx.user.id, JSON.stringify({ records: loaded.map(s => s.record), related, audit, links, tags })]);
    const losers = ids.filter(id => id !== primary?.id);
    await conn.query('UPDATE ipy_record SET is_deleted=true,deleted_at=now(),deleted_by=$2 WHERE id=ANY($1::uuid[])', [losers, ctx.user.id]);
    const survivor = primary
      ? await recordService.updateRecord({ ...ctx, source: 'duplicate-merge' }, target.name, primary.id, values, { conn, skipDuplicateCheck: true })
      : await recordService.createRecord({ ...ctx, source: 'duplicate-merge' }, target.name, values, { conn, skipDuplicateCheck: true });
    for (const ref of refs) {
      const table = quoteIdent(ref.table_name); const column = quoteIdent(ref.column_name);
      if (ref.table_name === 'ipy_property_storage' || ref.table_name === 'ipy_sla_tracker') {
        // A cloud folder belongs to a particular original property; combining
        // record ids must not move/delete folders. SLA state is recalculated
        // for the survivor. Original rows and their snapshots remain intact.
        continue;
      } else if (ref.table_name === 'ipy_tag_link') {
        await conn.query('INSERT INTO ipy_tag_link(tag_id,record_id) SELECT DISTINCT tag_id,$1::uuid FROM ipy_tag_link WHERE record_id=ANY($2::uuid[]) ON CONFLICT DO NOTHING', [survivor.id, ids]);
      } else if (ref.table_name === 'ipy_starred' || ref.table_name === 'ipy_recent_view') {
        const date = ref.table_name === 'ipy_starred' ? 'created_at' : 'viewed_at';
        await conn.query(`INSERT INTO ${table}(user_id,record_id,${date}) SELECT user_id,$1::uuid,MAX(${date}) FROM ${table} WHERE record_id=ANY($2::uuid[]) GROUP BY user_id ON CONFLICT DO NOTHING`, [survivor.id, ids]);
      } else if (ref.table_name === 'ipy_record_share') {
        await conn.query(`INSERT INTO ipy_record_share(record_id,subject_type,subject_id,access,shared_by)
          SELECT $1::uuid,subject_type,subject_id,CASE WHEN bool_or(access='read_write') THEN 'read_write' ELSE 'read' END,$3::uuid
          FROM ipy_record_share WHERE record_id=ANY($2::uuid[]) GROUP BY subject_type,subject_id
          ON CONFLICT(record_id,subject_type,subject_id) DO UPDATE SET access=CASE WHEN EXCLUDED.access='read_write' THEN 'read_write' ELSE ipy_record_share.access END`, [survivor.id, ids, ctx.user.id]);
      } else {
        await conn.query(`UPDATE ${table} SET ${column}=$1 WHERE ${column}=ANY($2::uuid[])`, [survivor.id, losers]);
      }
    }
    await conn.query("UPDATE ipy_call SET record_module='leads' WHERE record_id=$1", [survivor.id]);
    await conn.query("UPDATE ipy_conversation SET record_module='leads' WHERE record_id=$1", [survivor.id]);
    // Existing tag colours and ids stay the same; restricted source tags must
    // also be offered in Leads after their links have been preserved there.
    await conn.query(`UPDATE ipy_tag SET modules=array_append(modules,'leads') WHERE cardinality(modules)>0 AND NOT modules @> ARRAY['leads'] AND id IN(SELECT tag_id FROM ipy_tag_link WHERE record_id=$1)`, [survivor.id]);
    await conn.query(`INSERT INTO ipy_audit(record_id,module_name,user_id,action,changes,source,created_at)
      SELECT $1::uuid,module_name,user_id,action,changes,source,created_at FROM ipy_audit WHERE record_id=ANY($2::uuid[])`, [survivor.id, losers]);
    // Relationship rows are never discarded to get past a uniqueness error.
    // An incompatible relation rolls back the entire group, including archive.
    await conn.query('UPDATE ipy_record_link SET source_id=$1 WHERE source_id=ANY($2::uuid[])', [survivor.id, losers]);
    await conn.query('UPDATE ipy_record_link SET target_id=$1 WHERE target_id=ANY($2::uuid[])', [survivor.id, losers]);
    const result = { id: survivor.id, label: survivor.label, archived: losers.length, houseNumbers: houseField(target) ? survivor.values[houseField(target)!.name] : null };
    const afterTags = (await conn.query('SELECT * FROM ipy_tag WHERE id IN(SELECT tag_id FROM ipy_tag_link WHERE record_id=$1)', [survivor.id])).rows;
    await conn.query('UPDATE ipy_record_merge_archive SET survivor_id=$2,result=$3 WHERE batch_key=$1', [group.key, survivor.id, JSON.stringify({ ...result, after: { record: survivor, tags: afterTags } })]);
    await conn.query(`INSERT INTO ipy_audit(record_id,module_name,user_id,action,changes,source) VALUES($1,'leads',$2,'merge',$3,'duplicate-merge')`,
      [survivor.id, ctx.user.id, JSON.stringify([{ field: 'merged_contacts', label: 'Merged duplicate contacts', from: loaded.map(s => `${s.module.label}: ${s.record.label} (${s.record.recordNumber ?? s.record.id})`).join('; '), to: survivor.label }, { field: 'merge_archive', label: 'Before/after archive', from: group.key, to: result }, { field: houseField(target)?.name ?? 'house_numbers', label: 'House numbers retained', from: primary?.values[houseField(target)?.name ?? ''] ?? null, to: result.houseNumbers }])]);
    const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    // Do not dump field-permission-protected custom values into a comment.
    // Full before/after snapshots are accessible only to signed-in admins.
    const details = loaded.map(s => `<p>${escape(s.module.label)} — ${escape(s.record.label)} (${escape(s.record.recordNumber ?? s.record.id)})</p>`).join('');
    await conn.query('INSERT INTO ipy_comment(record_id,user_id,body) VALUES($1,$2,$3)', [survivor.id, ctx.user.id, `<p>Duplicate contacts merged into this Lead by an administrator. Existing house numbers were kept and any different ones added. Full original values and before/after history are retained in the administrator-only CRM merge archive: ${group.key}.</p>${details}`]);
    return result;
  });
}
