import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { mergeContactGroup, previewContactMerge } from '../../src/core/entity/contactMerge.js';
import { adminContext, contextFor, leadInput, propertyInput, SEEDED } from './fixtures.js';

let houseFieldId: string;
beforeAll(async () => {
  await registry.warmup();
  // Production's House No. is an administrator-created JSON field, absent
  // from the fresh seed. Exercise that shape rather than assuming a column.
  const leads = await registry.requireModule('leads');
  const field = await db.queryOne<{ id: string }>(`INSERT INTO ipy_field(module_id,name,label,uitype,storage,column_name)
    VALUES($1,'unit_no','House No.','string','json','unit_no') RETURNING id`, [leads.id]);
  houseFieldId = field!.id; registry.invalidate();
});
afterAll(async () => { await db.query('DELETE FROM ipy_field WHERE id=$1', [houseFieldId]); registry.invalidate(); });
let sequence = 0;
const phone = () => `66${String(Date.now()).slice(-6)}${String(sequence++).padStart(2, '0')}`;
async function legacyPair() {
  const ctx = await adminContext(); const mobile = phone();
  const lead = await recordService.createRecord(ctx, 'leads', leadInput({ mobile, unit_no: 'A-1' }));
  const property = await recordService.createRecord(ctx, 'properties', propertyInput({ mobile: phone(), unit_number: 'B-2' }));
  await db.query('UPDATE ipy_e_properties SET mobile=$2 WHERE record_id=$1', [property.id, mobile]);
  const group = (await previewContactMerge(ctx)).groups.find(g => g.members.some(m => m.id === lead.id))!;
  return { ctx, lead, property, group };
}
describe('audited duplicate contact consolidation', () => {
  it('keeps an existing Lead, appends houses, combines tags, carries history and archives originals', async () => {
    const { ctx, lead, property, group } = await legacyPair();
    const tag = await db.queryOne<{ id: string }>('INSERT INTO ipy_tag(name,modules) VALUES($1,ARRAY[\'properties\']) RETURNING id', [`merge-${phone()}`]);
    await db.query('INSERT INTO ipy_tag_link(tag_id,record_id) VALUES($1,$2)', [tag!.id, property.id]);
    await db.query('INSERT INTO ipy_comment(record_id,user_id,body) VALUES($1,$2,$3)', [property.id, ctx.user.id, 'Source note must survive']);
    await db.query("INSERT INTO ipy_audit(record_id,module_name,user_id,action,changes) VALUES($1,'properties',$2,'update','[]')", [property.id, ctx.user.id]);
    const result = await mergeContactGroup(ctx, group);
    expect(result.id).toBe(lead.id);
    const after = await recordService.getRecord(ctx, 'leads', lead.id);
    expect(after.values.unit_no).toBe('A-1, B-2');
    expect((await db.queryOne<{ count: number }>('SELECT count(*)::int AS count FROM ipy_tag_link WHERE record_id=$1 AND tag_id=$2', [lead.id, tag!.id]))!.count).toBe(1);
    expect((await db.queryOne<{ count: number }>('SELECT count(*)::int AS count FROM ipy_comment WHERE record_id=$1 AND body=$2', [lead.id, 'Source note must survive']))!.count).toBe(1);
    expect((await db.queryOne<{ is_deleted: boolean }>('SELECT is_deleted FROM ipy_record WHERE id=$1', [property.id]))!.is_deleted).toBe(true);
    expect((await db.queryOne<{ snapshot: { records: unknown[] } }>('SELECT snapshot FROM ipy_record_merge_archive WHERE batch_key=$1', [group.key]))!.snapshot.records).toHaveLength(2);
    expect((await db.query('SELECT action FROM ipy_audit WHERE record_id=$1 AND action=\'merge\'', [lead.id])).rows.length).toBe(1);
    expect(await mergeContactGroup(ctx, group)).toEqual(result);
  });
  it('refuses a stale preview without archiving or deleting anything', async () => {
    const { ctx, lead, property, group } = await legacyPair();
    await recordService.updateRecord(ctx, 'leads', lead.id, { full_name: 'Changed after preview' });
    await expect(mergeContactGroup(ctx, group)).rejects.toThrow(/changed after/);
    expect((await db.queryOne<{ is_deleted: boolean }>('SELECT is_deleted FROM ipy_record WHERE id=$1', [property.id]))!.is_deleted).toBe(false);
    expect((await db.query('SELECT 1 FROM ipy_record_merge_archive WHERE batch_key=$1', [group.key])).rows).toHaveLength(0);
  });
  it('creates a Lead for an Inventory-only duplicate group without losing house numbers', async () => {
    const ctx = await adminContext(); const mobile = phone();
    const a = await recordService.createRecord(ctx, 'properties', propertyInput({ mobile, unit_number: 'C-3' }));
    const b = await recordService.createRecord(ctx, 'properties', propertyInput({ mobile: phone(), unit_number: 'D-4' }));
    await db.query('UPDATE ipy_e_properties SET mobile=$2 WHERE record_id=$1', [b.id, mobile]);
    const group = (await previewContactMerge(ctx)).groups.find(g => g.members.some(m => m.id === a.id))!;
    const result = await mergeContactGroup(ctx, group);
    const lead = await recordService.getRecord(ctx, 'leads', result.id as string);
    expect(lead.values.unit_no).toContain('C-3'); expect(lead.values.unit_no).toContain('D-4');
    expect(result.archived).toBe(2);
  });
  it('retains historical overdue follow-ups without relaxing interactive date validation', async () => {
    const { ctx, lead, group } = await legacyPair();
    const module = await registry.requireModule('leads');
    const due = module.fields.find(f => f.columnName === 'next_followup_at')!;
    await db.query('UPDATE ipy_e_leads SET next_followup_at=$2 WHERE record_id=$1', [lead.id, '2020-01-01']);
    await mergeContactGroup(ctx, group);
    const after = await recordService.getRecord(ctx, 'leads', lead.id, { withDisplay: false });
    expect(String(after.values[due.name])).toContain('2020-01-01');
    await expect(recordService.updateRecord(ctx, 'leads', lead.id, { [due.name]: '2020-01-02' })).rejects.toThrow(/future date/);
  });
  it('rejects non-admins and unrelated phone groups', async () => {
    const { ctx, group } = await legacyPair();
    await expect(mergeContactGroup(await contextFor(SEEDED.executiveA), group)).rejects.toThrow(/administrator/);
    const other = await recordService.createRecord(ctx, 'leads', leadInput({ mobile: phone() }));
    await expect(mergeContactGroup(ctx, { key: 'f'.repeat(64), members: [group.members[0]!, { id: other.id, module: 'leads', label: other.label, updatedAt: other.updatedAt }] })).rejects.toThrow(/do not share/);
  });
  it('does not merge records while their phone command is pending', async () => {
    const { ctx, lead, property, group } = await legacyPair();
    await db.query(`INSERT INTO ipy_call(direction,from_number,to_number,user_id,record_id,status)
      VALUES('outbound','test','test',$1,$2,'ringing')`, [ctx.user.id, property.id]);
    await expect(mergeContactGroup(ctx, group)).rejects.toThrow(/call is active/);
    expect((await db.queryOne<{ is_deleted: boolean }>('SELECT is_deleted FROM ipy_record WHERE id=$1', [property.id]))!.is_deleted).toBe(false);
    expect((await db.query('SELECT 1 FROM ipy_record_merge_archive WHERE survivor_id=$1', [lead.id])).rows).toHaveLength(0);
  });
  it('groups primary/alternate number bridges once and combines every house', async () => {
    const { ctx, lead, property } = await legacyPair();
    const bridge = phone();
    await recordService.updateRecord(ctx, 'leads', lead.id, { alternate_phone: bridge });
    const third = await recordService.createRecord(ctx, 'leads', leadInput({ mobile: phone(), unit_no: 'C-3' }));
    await db.query('UPDATE ipy_e_leads SET mobile=$2 WHERE record_id=$1', [third.id, bridge]);
    const groups = (await previewContactMerge(ctx)).groups.filter(g => g.members.some(m => m.id === lead.id));
    expect(groups).toHaveLength(1); expect(groups[0]!.members).toHaveLength(3);
    const result = await mergeContactGroup(ctx, groups[0]!);
    expect(String(result.houseNumbers)).toContain('A-1'); expect(String(result.houseNumbers)).toContain('B-2'); expect(String(result.houseNumbers)).toContain('C-3');
  });
});
