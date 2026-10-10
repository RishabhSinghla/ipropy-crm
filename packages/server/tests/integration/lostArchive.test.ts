import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { archiveDueLostRecords } from '../../src/core/entity/lostArchive.js';
import { isLostStatus, statusFieldOf } from '@ipropy/shared';
import { adminContext, leadInput } from './fixtures.js';
import { contextFor, SEEDED, propertyInput, signIn } from './fixtures.js';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('retained Lost archive', () => {
  it('waits 12 hours, excludes normal lists, retains readable data and reopens safely', async () => {
    const ctx = await adminContext();
    const module = await registry.requireModule('leads');
    const field = statusFieldOf(module.fields)!;
    const lost = field.options!.find(option => isLostStatus(option.value) || isLostStatus(option.label))!;
    const active = field.options!.find(option => !isLostStatus(option.value) && !isLostStatus(option.label))!;
    const record = await recordService.createRecord(ctx, 'leads', leadInput({ [field.name]: active.value }));
    const reason = module.fields.find(field => field.columnName === 'lost_reason');
    await recordService.updateRecord(ctx, 'leads', record.id, { [field.name]: lost.value, ...(reason ? { [reason.name]: reason.options?.[0]?.value ?? 'Other' } : {}) });
    const pending = await db.queryOne<{ hours: number }>('SELECT extract(epoch FROM (lost_archive_due_at-now()))/3600 AS hours FROM ipy_record WHERE id=$1', [record.id]);
    expect(Number(pending?.hours)).toBeGreaterThan(11.9);
    await archiveDueLostRecords();
    expect((await recordService.listRecords(ctx, 'leads', { search: record.label })).rows.some(row => row.id === record.id)).toBe(true);
    await db.query("UPDATE ipy_record SET lost_archive_due_at=now()-interval '1 second' WHERE id=$1", [record.id]);
    await Promise.all([archiveDueLostRecords(), archiveDueLostRecords()]);
    expect((await recordService.listRecords(ctx, 'leads', { search: record.label })).total).toBe(0);
    expect((await recordService.listRecords(ctx, 'leads', { archive: true, search: record.label })).rows[0]?.id).toBe(record.id);
    expect((await recordService.getRecord(ctx, 'leads', record.id)).label).toBe(record.label);
    const audit = await db.queryOne<{ count: number }>("SELECT count(*)::int AS count FROM ipy_audit WHERE record_id=$1 AND action='archive'", [record.id]);
    expect(audit?.count).toBe(1);
    await recordService.updateRecord(ctx, 'leads', record.id, { [field.name]: active.value });
    expect((await recordService.listRecords(ctx, 'leads', { search: record.label })).rows[0]?.id).toBe(record.id);
    expect((await recordService.listRecords(ctx, 'leads', { archive: true, search: record.label })).total).toBe(0);
  });
  it('cancels the grace period when the status changes back', async () => {
    const ctx = await adminContext();
    const field = statusFieldOf((await registry.requireModule('leads')).fields)!;
    const lost = field.options!.find(option => isLostStatus(option.value) || isLostStatus(option.label))!;
    const active = field.options!.find(option => !isLostStatus(option.value) && !isLostStatus(option.label))!;
    const reason = (await registry.requireModule('leads')).fields.find(field => field.columnName === 'lost_reason');
    const record = await recordService.createRecord(ctx, 'leads', leadInput({ [field.name]: lost.value, ...(reason ? { [reason.name]: reason.options?.[0]?.value ?? 'Other' } : {}) }));
    await recordService.updateRecord(ctx, 'leads', record.id, { [field.name]: active.value });
    const saved = await db.queryOne<{ due: string | null; archived: string | null }>('SELECT lost_archive_due_at AS due, archived_at AS archived FROM ipy_record WHERE id=$1', [record.id]);
    expect(saved).toEqual({ due: null, archived: null });
  });

  it('retains owner permissions and HTTP reopening rejects Lost or nonarchived records', async () => {
    const ctx = await adminContext();
    const module = await registry.requireModule('leads');
    const field = statusFieldOf(module.fields)!;
    const lost = field.options!.find(option => isLostStatus(option.value) || isLostStatus(option.label))!;
    const active = field.options!.find(option => option.isActive !== false && !isLostStatus(option.value) && !isLostStatus(option.label))!;
    const owner = await contextFor(SEEDED.executiveA);
    const outsider = await contextFor(SEEDED.executiveB);
    const record = await recordService.createRecord(ctx, 'leads', leadInput({ owner_id: owner.user.id }));
    await db.query('UPDATE ipy_record SET archived_at=now() WHERE id=$1', [record.id]);
    expect((await recordService.listRecords(owner, 'leads', { archive: true, search: record.label })).rows[0]?.id).toBe(record.id);
    expect((await recordService.listRecords(outsider, 'leads', { archive: true, search: record.label })).total).toBe(0);
    const app = createApp();
    const auth = `Bearer ${await signIn(app, ctx.user.email)}`;
    await request(app).post(`/api/records/leads/${record.id}/reopen`).set('Authorization', auth).send({ status: lost.value }).expect(400);
    await request(app).post(`/api/records/leads/${record.id}/reopen`).set('Authorization', auth).send({ status: active.value }).expect(200);
    await request(app).post(`/api/records/leads/${record.id}/reopen`).set('Authorization', auth).send({ status: active.value }).expect(400);
    const audit = await db.queryOne<{ count: number }>("SELECT count(*)::int AS count FROM ipy_audit WHERE record_id=$1 AND action='restore'", [record.id]);
    expect(audit?.count).toBe(1);
  });

  it('archives Inventory with the same retained-record policy', async () => {
    const ctx = await adminContext();
    // The default Inventory stages have no Lost; simulate an admin adding it.
    await db.query(`INSERT INTO ipy_picklist_value(picklist_id,value,label)
      SELECT id,'Lost','Lost' FROM ipy_picklist WHERE name='property_status' ON CONFLICT DO NOTHING`);
    registry.invalidate();
    const module = await registry.requireModule('properties');
    const field = statusFieldOf(module.fields)!;
    const lost = field.options!.find(option => isLostStatus(option.value) || isLostStatus(option.label))!;
    const reason = module.fields.find(field => field.columnName === 'lost_reason');
    const record = await recordService.createRecord(ctx, module.name, propertyInput({ [field.name]: lost.value, ...(reason ? { [reason.name]: reason.options?.[0]?.value ?? 'Other' } : {}) }));
    await db.query("UPDATE ipy_record SET lost_archive_due_at=now()-interval '1 second' WHERE id=$1", [record.id]);
    await archiveDueLostRecords();
    expect((await recordService.listRecords(ctx, module.name, { archive: true, search: record.label })).rows[0]?.id).toBe(record.id);
    expect((await recordService.getRecord(ctx, module.name, record.id)).values.mobile).toBe(record.values.mobile);
  });
});
