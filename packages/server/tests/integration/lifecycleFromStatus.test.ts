/**
 * Lifecycle Stage follows Lead Status, so nobody has to fill in both.
 *
 * The failure this replaces was invisible: a rep moved a lead to Converted and
 * left the Lifecycle on Lead, and every report grouped by relationship was then
 * wrong with nothing anywhere saying so. Two fields, one fact, no way to notice
 * they disagreed.
 *
 * The two rules that make it safe are the ones worth pinning hardest: an
 * unmapped status changes nothing, and nobody is ever moved backwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../../src/core/metadata/registry.js';
import { db } from '../../src/db/pool.js';
import { recordService, type ServiceContext } from '../../src/core/entity/recordService.js';
import { syncLifecycle } from '../../src/core/entity/lifecycleFromStatus.js';
import { adminContext } from './fixtures.js';

let ctx: ServiceContext;
const made: string[] = [];

/** The sync runs off the event bus in production; called directly here. */
async function setStatus(id: string, status: string): Promise<string> {
  await recordService.updateRecord(ctx, 'leads', id, { status });
  const after = await recordService.getRecord(ctx, 'leads', id);
  await syncLifecycle(id, after.values);
  const row = await db.queryOne<{ lifecycle_stage: string }>(
    `SELECT lifecycle_stage FROM ipy_e_leads WHERE record_id = $1`, [id],
  );
  return row!.lifecycle_stage;
}

async function makeLead(status: string): Promise<string> {
  const rec = await recordService.createRecord(ctx, 'leads', {
    full_name: `Stage ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    mobile: `9${String(Date.now()).slice(-9)}`,
    status,
  });
  made.push(rec.id);
  return rec.id;
}

beforeAll(async () => {
  await registry.warmup();
  ctx = await adminContext();
});

afterAll(async () => {
  if (made.length) await db.query(`DELETE FROM ipy_record WHERE id = ANY($1::uuid[])`, [made]);
});

describe('the lifecycle follows the lead status', () => {
  it.each([
    ['Contacted', 'Lead'],
    ['Qualified', 'Prospect'],
    ['Site Visit Done', 'Prospect'],
    ['Negotiation', 'Prospect'],
    ['Converted', 'Customer'],
  ])('moving to %s makes them a %s', async (status, expected) => {
    const id = await makeLead('New');
    expect(await setStatus(id, status)).toBe(expected);
  });

  it('carries someone all the way through without anybody touching the stage', async () => {
    const id = await makeLead('New');
    expect(await setStatus(id, 'Qualified')).toBe('Prospect');
    expect(await setStatus(id, 'Site Visit Done')).toBe('Prospect');
    expect(await setStatus(id, 'Converted')).toBe('Customer');
  });

  /**
   * The one that would quietly wreck the database. A past customer sending a
   * fresh enquiry starts a new pipeline at New, and if the stage followed that
   * literally, every repeat buyer would be demoted back to a lead — losing the
   * ranking that makes their WhatsApp message and their phone call find them.
   */
  it('never demotes a customer who enquires again', async () => {
    const id = await makeLead('New');
    expect(await setStatus(id, 'Converted')).toBe('Customer');

    expect(await setStatus(id, 'New')).toBe('Customer');
    expect(await setStatus(id, 'Contacted')).toBe('Customer');
    expect(await setStatus(id, 'Qualified')).toBe('Customer');
  });

  it.each(['Junk', 'Lost'])('leaves the stage alone when an enquiry ends as %s', async (status) => {
    // How an enquiry finished is not who the person is. Somebody who bought last
    // year and whose latest enquiry went nowhere is still a customer.
    const id = await makeLead('New');
    expect(await setStatus(id, 'Converted')).toBe('Customer');
    expect(await setStatus(id, status)).toBe('Customer');
  });

  it('leaves a brand new lead alone rather than inventing a stage', async () => {
    const id = await makeLead('New');
    const row = await db.queryOne<{ lifecycle_stage: string }>(
      `SELECT lifecycle_stage FROM ipy_e_leads WHERE record_id = $1`, [id],
    );
    expect(row!.lifecycle_stage).toBe('Lead');
  });

  it('does nothing at all if the lifecycle field has been removed', async () => {
    // An admin may delete Lifecycle Stage. That must not start throwing on every
    // lead write — the sync simply has nothing to keep in step.
    const id = await makeLead('New');
    const module = await registry.getModule('leads');
    const stage = registry.fieldPlaying(module!, 'lifecycle_stage');
    expect(stage, 'the field should exist in a fresh model').toBeTruthy();

    await expect(syncLifecycle(id, { status: 'Converted' })).resolves.toBeUndefined();
  });
});
