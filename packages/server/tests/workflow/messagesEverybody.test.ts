/**
 * A scheduled rule that messages people and narrows on nothing.
 *
 * "Birthday greeting" is seeded with `date_of_birth is today`. Production's
 * copy carried `{"logic":"AND","conditions":[]}` — no birthday check at all —
 * on a daily schedule with a WhatsApp step, and queued one message per contact
 * per run: 20,006 on 13 September 2026 and 20,000 on the 16th, 40,515 waiting
 * in total. Nobody received one only because no WhatsApp Business account is
 * connected and that queue drains by a person tapping send.
 *
 * `seed/pruneFieldRefs.ts` already refuses to let a workflow lose a condition
 * and act on everybody — but it skips a workflow whose conditions are already
 * empty, because there is nothing left for it to check. This is that gap,
 * closed where the damage would be done.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/** Records the writes, and answers whether the workflow has an outbound task. */
function stub(taskType: string | null) {
  const updates: { sql: string; params: unknown[] }[] = [];
  return {
    updates,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
      queryOne: async (sql: string) => (
        sql.includes('ipy_workflow_task') && taskType ? { type: taskType } : null
      ),
    },
  };
}

async function guardWith(taskType: string | null, conditions: unknown) {
  const s = stub(taskType);
  vi.doMock('../../src/db/pool.js', () => ({ db: s.pool, onCommit: (_c: unknown, fn: () => void) => fn() }));
  const { refusesToMessageEverybody } = await import('../../src/core/workflow/scheduler.js');
  const refused = await refusesToMessageEverybody(
    { id: 'wf-1', name: 'Birthday greeting', conditions: conditions as never },
  );
  return { refused, updates: s.updates };
}

const NARROWS_ON_NOTHING = { logic: 'AND', conditions: [] };
const CHECKS_THE_BIRTHDAY = { logic: 'AND', conditions: [{ field: 'date_of_birth', operator: 'today' }] };

describe('a scheduled workflow that narrows on nothing', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('is switched off rather than run, when it can message somebody', async () => {
    const { refused, updates } = await guardWith('send_whatsapp', NARROWS_ON_NOTHING);
    expect(refused).toBe(true);
    const off = updates.find((u) => u.sql.includes('is_active = false'));
    expect(off, 'the workflow should have been switched off').toBeTruthy();
    expect(off!.params).toContain('wf-1');
  });

  it('treats email and SMS the same way', async () => {
    expect((await guardWith('send_email', NARROWS_ON_NOTHING)).refused).toBe(true);
    expect((await guardWith('send_sms', NARROWS_ON_NOTHING)).refused).toBe(true);
  });

  it('leaves a workflow alone when it does narrow', async () => {
    const { refused, updates } = await guardWith('send_whatsapp', CHECKS_THE_BIRTHDAY);
    expect(refused).toBe(false);
    expect(updates.find((u) => u.sql.includes('is_active = false'))).toBeUndefined();
  });

  it('leaves a workflow alone when it cannot message anybody', async () => {
    // Plenty of scheduled rules legitimately sweep everything — releasing
    // expired blocks, re-scoring a list. They change the CRM's own data and
    // nobody receives anything, so no condition is not this problem.
    const { refused, updates } = await guardWith(null, NARROWS_ON_NOTHING);
    expect(refused).toBe(false);
    expect(updates.find((u) => u.sql.includes('is_active = false'))).toBeUndefined();
  });

  it('treats a missing conditions object as narrowing on nothing', async () => {
    // Null is the same promise as an empty list: act on every record.
    expect((await guardWith('send_whatsapp', null)).refused).toBe(true);
  });
});
