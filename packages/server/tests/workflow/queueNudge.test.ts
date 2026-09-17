/**
 * Queueing a task that is due now must not wait for the tick.
 *
 * The tick was every sixty seconds and that one number did two unrelated jobs:
 * getting a just-queued task moving, and noticing that scheduled work has come
 * due. Only the first wants to be immediate — and paying for the second at that
 * cadence is what kept the database awake 24 hours a day. Neon powers down
 * after five minutes with no queries, so a query every minute means it never
 * powers down: 12.58 compute hours in 1.6 days on 16 September 2026, about $24
 * a month for seven users.
 *
 * These pin the half that makes slowing the tick safe. Without the nudge,
 * raising the tick to fifteen minutes would have made a rule that fires the
 * moment a lead arrives instant to within a quarter of an hour.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

function load() {
  const drains: string[] = [];
  vi.doMock('../../src/db/pool.js', () => ({
    db: { query: async () => ({ rows: [], rowCount: 0 }), queryOne: async () => null },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      drains.push('drained');
      return fn({ query: async () => ({ rows: [] }) });
    },
    onCommit: (_c: unknown, fn: () => void) => fn(),
  }));
  return { drains };
}

describe('nudging the queue', () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('drains within a moment, not at the next tick', async () => {
    const { drains } = load();
    const { nudgeQueue } = await import('../../src/core/workflow/scheduler.js');

    nudgeQueue();
    expect(drains, 'nothing should run synchronously').toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300);
    expect(drains, 'the drain should have run inside a second').toHaveLength(1);
  });

  it('collapses a burst into one drain', async () => {
    // A workflow with six tasks enqueues six times in the same millisecond.
    // That is one drain, not six.
    const { drains } = load();
    const { nudgeQueue } = await import('../../src/core/workflow/scheduler.js');

    for (let i = 0; i < 6; i += 1) nudgeQueue();
    await vi.advanceTimersByTimeAsync(300);

    expect(drains).toHaveLength(1);
  });

  it('can be nudged again once the first has run', async () => {
    const { drains } = load();
    const { nudgeQueue } = await import('../../src/core/workflow/scheduler.js');

    nudgeQueue();
    await vi.advanceTimersByTimeAsync(300);
    nudgeQueue();
    await vi.advanceTimersByTimeAsync(300);

    expect(drains).toHaveLength(2);
  });
});

describe('the tick', () => {
  it('is slow enough for the database to power down between visits', async () => {
    // Neon powers down after five minutes idle. Any tick at or under that keeps
    // it awake for ever, which is the whole bill. This is the number, pinned:
    // if somebody lowers it back under five minutes, they should have to mean it.
    const { config } = await import('../../src/config.js');
    expect(config.scheduler.tickSeconds).toBeGreaterThan(300);
  });
});
