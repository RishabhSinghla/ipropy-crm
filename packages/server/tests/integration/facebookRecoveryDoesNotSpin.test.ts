/**
 * The Facebook recovery job must stop when there is nothing to do.
 *
 * It schedules its next run from "when is the next delivery due". With nothing
 * waiting, that used to come back as 0 (GREATEST ignores NULL), meaning "due now",
 * so it ran again in 250 ms, for ever, writing to the database twice a pass and
 * never letting it sleep. These tests ask the one question directly.
 *
 * Everything happens inside a transaction that is rolled back, so the rows other
 * tests have in the shared table are neither seen by this test's assertions nor
 * changed for them.
 */
import { describe, expect, it } from 'vitest';
import { transaction, type Tx } from '../../src/db/pool.js';
import { secondsUntilNextDelivery } from '../../src/integrations/leadsources/facebookRecovery.js';

const ROLLBACK = new Error('roll back the test');

async function inAnEmptyQueue(body: (tx: Tx) => Promise<void>): Promise<void> {
  await transaction(async (tx) => {
    await tx.query(`DELETE FROM ipy_facebook_delivery WHERE status IN ('pending', 'processing')`);
    await body(tx);
    throw ROLLBACK;
  }).catch((err) => { if (err !== ROLLBACK) throw err; });
}

const waiting = (tx: Tx, id: string, status: string, due: string) => tx.query(
  `INSERT INTO ipy_facebook_delivery (lead_id, payload, status, next_attempt_at, lease_until)
   VALUES ($1, '{}'::jsonb, $2, now() + $3::interval, now() + $3::interval)`, [id, status, due],
);

describe('when the next Facebook delivery is due', () => {
  it('says there is nothing to schedule when nothing is waiting', async () => {
    await inAnEmptyQueue(async (tx) => {
      expect(await secondsUntilNextDelivery(tx)).toBeNull();
    });
  });

  it('is not fooled by deliveries that are already done or given up on', async () => {
    await inAnEmptyQueue(async (tx) => {
      await waiting(tx, 'spin-test-done', 'done', '0 seconds');
      await waiting(tx, 'spin-test-dead', 'dead', '0 seconds');
      expect(await secondsUntilNextDelivery(tx)).toBeNull();
    });
  });

  it('says now for one that is overdue', async () => {
    await inAnEmptyQueue(async (tx) => {
      await waiting(tx, 'spin-test-late', 'pending', '-1 minute');
      expect(await secondsUntilNextDelivery(tx)).toBe(0);
    });
  });

  it('says how long to wait for one that is due later', async () => {
    await inAnEmptyQueue(async (tx) => {
      await waiting(tx, 'spin-test-later', 'pending', '90 seconds');
      const seconds = await secondsUntilNextDelivery(tx);
      expect(seconds).toBeGreaterThan(80);
      expect(seconds).toBeLessThanOrEqual(90);
    });
  });
});
