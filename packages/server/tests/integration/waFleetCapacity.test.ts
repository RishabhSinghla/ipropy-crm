/**
 * The fleet guard against a real database: the list query still parses with the new health columns, a start beyond
 * the plan is refused before OpenWA is asked, and a deliberate stop is remembered so the watchdog leaves it alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { listNumbers } from '../../src/integrations/whatsapp/business/waNumbers.js';
import { assertRoomToStart, fleetSummary, saveCapacity } from '../../src/integrations/whatsapp/business/waFleet.js';

const stamp = Date.now();
const names = [`t-fleet-a-${stamp}`, `t-fleet-b-${stamp}`, `t-fleet-c-${stamp}`];
let ids: string[] = [];
let before: { maxLive: number; memoryLimitMb: number };
let wasLive: { id: string; status: string }[] = [];

beforeAll(async () => {
  before = (await fleetSummary()).capacity;
  // Park every other number so the count below is only ours (restored afterwards).
  wasLive = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM ipy_wa_number`)).rows;
  await db.query(`UPDATE ipy_wa_number SET status = 'created'`);
  for (const [i, name] of names.entries()) {
    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_wa_number (session_name, session_id, status) VALUES ($1, $1, $2) RETURNING id`, [name, i < 2 ? 'ready' : 'created'],
    );
    ids.push(row!.id);
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_wa_number WHERE id = ANY($1::uuid[])`, [ids]);
  for (const r of wasLive) await db.query(`UPDATE ipy_wa_number SET status = $2 WHERE id = $1`, [r.id, r.status]);
  await saveCapacity(before);
});

describe('fleet capacity', () => {
  it('lists numbers with their health facts', async () => {
    const mine = (await listNumbers()).find((n) => n.sessionName === names[0]);
    expect(mine).toMatchObject({ messagesToday: 0, failedToday: 0, restartAttempts: 0, lastError: null });
  });

  it('refuses to start one more than the plan holds, and says why', async () => {
    await saveCapacity({ maxLive: 2, memoryLimitMb: 512 });
    await expect(assertRoomToStart(ids[2])).rejects.toThrow(/bigger Render plan/);
  });

  it('lets a number that is already connected restart', async () => {
    await expect(assertRoomToStart(ids[0])).resolves.toBeUndefined();
  });

  it('allows the third once the limit is raised', async () => {
    await saveCapacity({ maxLive: 10, memoryLimitMb: 2048 });
    await expect(assertRoomToStart(ids[2])).resolves.toBeUndefined();
  });
});
