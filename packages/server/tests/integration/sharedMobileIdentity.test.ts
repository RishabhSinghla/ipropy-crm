import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, leadInput, propertyInput } from './fixtures.js';

const made: string[] = [];
let sequence = 0;
const phone = () => `67${String(Date.now()).slice(-6)}${String(sequence++).padStart(2, '0')}`;
beforeAll(() => registry.warmup());
afterAll(async () => { if (made.length) await db.query('DELETE FROM ipy_record WHERE id = ANY($1::uuid[])', [made]); });
async function add(module: string, mobile: string, extra: Record<string, unknown> = {}) {
  const input = module === 'properties' ? propertyInput({ mobile, ...extra }) : leadInput({ mobile, ...extra });
  const record = await recordService.createRecord(await adminContext(), module, input, { skipDuplicateCheck: true });
  made.push(record.id);
  return record;
}

describe('shared mobile identity across configured modules', () => {
  it('blocks formatted lead -> inventory and inventory -> lead duplicates', async () => {
    const a = phone(); const lead = await add('leads', a);
    await db.query('UPDATE ipy_e_leads SET mobile = $2 WHERE record_id = $1', [lead.id, `+91 ${a}`]);
    await expect(add('properties', a)).rejects.toThrow(/already exists/);
    const b = phone(); const inventory = await add('properties', b);
    await db.query('UPDATE ipy_e_properties SET mobile = $2 WHERE record_id = $1', [inventory.id, `0${b}`]);
    await expect(add('leads', b)).rejects.toThrow(/already exists/);
  });
  it('checks alternate phones and edited primary phones', async () => {
    const a = phone(); await add('properties', a);
    await expect(add('leads', phone(), { alternate_phone: a })).rejects.toThrow(/already exists/);
    const b = await add('leads', phone());
    await expect(recordService.updateRecord(await adminContext(), 'leads', b.id, { mobile: a }))
      .rejects.toThrow(/already exists/);
  });
  it('allows unrelated edits to legacy duplicates and equivalent formatting', async () => {
    const a = phone(); const lead = await add('leads', a); const inventory = await add('properties', phone());
    // Represent legacy duplicates without using the guarded write path.
    await db.query('UPDATE ipy_e_properties SET mobile = $2 WHERE record_id = $1', [inventory.id, a]);
    const edited = await recordService.updateRecord(await adminContext(), 'leads', lead.id,
      { full_name: 'Existing duplicate remains editable', mobile: a });
    expect(edited.label).toBe('Existing duplicate remains editable');
    await expect(recordService.updateRecord(await adminContext(), 'leads', lead.id, { mobile: `${a.slice(0,5)} ${a.slice(5)}` })).resolves.toBeTruthy();
  });
  it('prevents two concurrent creates from claiming one mobile', async () => {
    const a = phone();
    const outcomes = await Promise.allSettled([add('leads', a), add('properties', a)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('blocks restore when another active record has the same mobile', async () => {
    const a = phone(); const lead = await add('leads', a);
    await recordService.deleteRecord(await adminContext(), 'leads', lead.id);
    await add('properties', a);
    await expect(recordService.restoreRecord(await adminContext(), 'leads', lead.id)).rejects.toThrow(/already exists/);
  });
  it('preserves legitimate module moves', async () => {
    const lead = await add('leads', phone());
    const moved = await recordService.moveRecord(await adminContext(), 'leads', lead.id, 'properties');
    made.push(moved.id);
    expect(moved.values.mobile).toBe(lead.values.mobile);
  });
});
