/**
 * Who a record may be handed to: anyone active, whatever the reporting line.
 *
 * It followed the hierarchy until 1 October 2026 — a rep could hand a record
 * only to themselves or somebody below them. The owner: *"all times all
 * agents of CRM be displayed and anyone no matter hierarchy can do
 * assignment."* So a peer and a manager are both fine now, and only the
 * automation account is refused, because a record parked on it is one nobody
 * is chasing.
 *
 * Worth a real database: the seeded cast is what gives the test a hierarchy
 * with a real shape, so "sideways" and "upwards" mean what they mean.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recordService } from '../../src/core/entity/recordService.js';
import { adminContext, authUser, contextFor, SEEDED } from './fixtures.js';

let recordId: string;

beforeAll(async () => {
  const ctx = await adminContext();
  const lead = await recordService.createRecord(ctx, 'leads', {
    full_name: `Assignment Hierarchy ${Date.now()}`,
    mobile: '9811500042',
  });
  recordId = lead.id;

  // Start it inside the manager's branch. Reassigning is an edit, so the
  // caller has to be able to edit the record before the question of who they
  // may hand it to arises at all.
  const manager = await authUser(SEEDED.salesManager);
  await db.query(`UPDATE ipy_record SET owner_id = $1 WHERE id = $2`, [manager.id, recordId]);
});

afterAll(async () => {
  if (recordId) await db.query(`DELETE FROM ipy_record WHERE id = $1`, [recordId]);
});

describe('reassigning a record', () => {
  it('lets a manager hand it to someone below them', async () => {
    const manager = await contextFor(SEEDED.salesManager);
    const executive = await authUser(SEEDED.executiveA);

    const moved = await recordService.transferOwnership(manager, 'leads', [recordId], executive.id);

    expect(moved, 'the transfer should have touched the record').toBe(1);
    const row = await db.queryOne<{ owner_id: string }>(
      `SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId],
    );
    expect(row?.owner_id).toBe(executive.id);
  });

  it('lets a rep hand it sideways to a peer', async () => {
    const executive = await contextFor(SEEDED.executiveA);
    const peer = await authUser(SEEDED.executiveB);

    const moved = await recordService.transferOwnership(executive, 'leads', [recordId], peer.id);

    expect(moved).toBe(1);
    const row = await db.queryOne<{ owner_id: string }>(
      `SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId],
    );
    expect(row?.owner_id).toBe(peer.id);
  });

  it('lets a rep hand it upwards to a manager', async () => {
    const executive = await contextFor(SEEDED.executiveA);
    const manager = await authUser(SEEDED.salesManager);
    // Back with the rep first, so the rep is the one allowed to edit it.
    await db.query(`UPDATE ipy_record SET owner_id = $1 WHERE id = $2`, [executive.user.id, recordId]);

    const moved = await recordService.transferOwnership(executive, 'leads', [recordId], manager.id);

    expect(moved).toBe(1);
  });

  it('lets anyone take a record back for themselves', async () => {
    const executive = await contextFor(SEEDED.executiveA);
    await db.query(`UPDATE ipy_record SET owner_id = $1 WHERE id = $2`, [executive.user.id, recordId]);

    const moved = await recordService.transferOwnership(
      executive, 'leads', [recordId], executive.user.id,
    );

    expect(moved).toBe(1);
  });

  it('lets an administrator allocate anywhere', async () => {
    const admin = await adminContext();
    const telecaller = await authUser(SEEDED.telecaller);

    const moved = await recordService.transferOwnership(admin, 'leads', [recordId], telecaller.id);

    expect(moved).toBe(1);
    const row = await db.queryOne<{ owner_id: string }>(
      `SELECT owner_id FROM ipy_record WHERE id = $1`, [recordId],
    );
    expect(row?.owner_id).toBe(telecaller.id);
  });

  it('refuses the automation account, which is not somebody who works here', async () => {
    const admin = await adminContext();
    // The nil UUID is `system@ipropy` — the actor workflow tasks, lead capture
    // and telephony run as. It is a real, active row, so "does this user
    // exist" waves it straight through; a record parked on it is one nobody
    // is chasing and no screen would hand back.
    const system = await db.queryOne<{ id: string }>(
      `SELECT id FROM ipy_user WHERE email NOT LIKE '%.%' AND is_active = true LIMIT 1`,
    );
    expect(system, 'the seed should have an automation account').toBeTruthy();

    await expect(
      recordService.transferOwnership(admin, 'leads', [recordId], system!.id),
    ).rejects.toThrow(/active team member/i);
  });
});
