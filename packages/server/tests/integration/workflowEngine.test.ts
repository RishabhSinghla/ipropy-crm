/**
 * One failing task must not abandon the rest of the workflow.
 *
 * The engine ran every task of a workflow inside a single try/catch. A task
 * that threw therefore took the remaining tasks with it, and three separate
 * things went wrong at once — none of them visible to the person who built the
 * rule:
 *
 *  * the tasks after it never ran, so the record was scored but not tagged, or
 *    tagged but never given its follow-up date;
 *  * the run was logged with `tasks_run = 0` even when several had already run
 *    and their side effects had landed, so the log denied work that had
 *    actually happened;
 *  * `recordState` was never reached, so for `once` and `once_until_false`
 *    workflows `has_run` stayed false and the whole thing re-fired on the next
 *    touch of that record — re-running the tasks that *had* succeeded. A
 *    welcome WhatsApp goes out again. And again.
 *
 * This is not hypothetical for this install. `webhook` rethrows by design, and
 * `trigger_call` throws "No cloud telephony provider is connected" on every
 * run here, because there is no provider and the team dials from their phones.
 * Any workflow with one of those in the middle silently lost everything after
 * it and quietly repeated everything before it.
 *
 * The unreachable webhook below is the deterministic stand-in: port 9 is
 * discard, so the connection is refused immediately rather than waiting out the
 * task's 15s timeout.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { registry } from '../../src/core/metadata/registry.js';
import { invalidateWorkflows, runWorkflowsFor } from '../../src/core/workflow/engine.js';
import { adminContext, leadInput } from './fixtures.js';
import { createRecord } from '../../src/core/entity/recordService.js';

/** Refused instantly; nothing listens on the discard port. */
const UNREACHABLE = 'http://127.0.0.1:9/';

let workflowId: string;
let moduleId: string;

async function addTask(
  type: string,
  sequence: number,
  config: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO ipy_workflow_task (workflow_id, type, name, sequence, config)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [workflowId, type, `${type}-${sequence}`, sequence, JSON.stringify(config)],
  );
}

/** The tags this workflow attached to a record, in no particular order. */
async function tagsOn(recordId: string): Promise<string[]> {
  const res = await db.query<{ name: string }>(
    `SELECT t.name FROM ipy_tag_link l JOIN ipy_tag t ON t.id = l.tag_id WHERE l.record_id = $1`,
    [recordId],
  );
  return res.rows.map((r) => r.name).sort();
}

async function newLead(fullName: string): Promise<string> {
  const ctx = await adminContext();
  const rec = await createRecord(ctx, 'leads', leadInput({ full_name: fullName }));
  return rec.id as string;
}

beforeAll(async () => {
  await registry.warmup();
  const mod = await db.queryOne<{ id: string }>(
    `SELECT id FROM ipy_module WHERE name = 'leads'`,
  );
  moduleId = mod!.id;

  const wf = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_workflow (module_id, name, trigger, execution_mode, is_active, sequence)
     VALUES ($1, 'engine-partial-failure-test', 'on_create', 'once', true, 9999)
     RETURNING id`,
    [moduleId],
  );
  workflowId = wf!.id;

  // before -> throws -> after. The order is the whole point.
  await addTask('add_tag', 1, { tags: ['wf-before'] });
  await addTask('webhook', 2, { url: UNREACHABLE });
  await addTask('add_tag', 3, { tags: ['wf-after'] });

  invalidateWorkflows();
});

afterAll(async () => {
  await db.query(`DELETE FROM ipy_workflow WHERE id = $1`, [workflowId]);
  invalidateWorkflows();
});

describe('a workflow task that throws', () => {
  it('does not stop the tasks after it from running', async () => {
    const recordId = await newLead('Partial Failure One');
    await runWorkflowsFor('leads', ['on_create'], recordId,
      { id: recordId, full_name: 'Partial Failure One' },
      { user: null, source: 'test' });

    const tags = await tagsOn(recordId);
    expect(tags, 'the task before the failure should have run').toContain('wf-before');
    expect(tags, 'the task AFTER the failure must still run').toContain('wf-after');
  });

  it('logs how many tasks actually ran, not zero', async () => {
    const recordId = await newLead('Partial Failure Two');
    await runWorkflowsFor('leads', ['on_create'], recordId,
      { id: recordId, full_name: 'Partial Failure Two' },
      { user: null, source: 'test' });

    const log = await db.queryOne<{ status: string; tasks_run: number; error: string | null }>(
      `SELECT status, tasks_run, error FROM ipy_workflow_log
       WHERE workflow_id = $1 AND record_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [workflowId, recordId],
    );

    expect(log, 'the run should be logged').toBeTruthy();
    // Two of the three succeeded. Reporting 0 denies side effects that landed.
    expect(log!.tasks_run, 'tasks_run must count the tasks that ran').toBeGreaterThan(0);
    // And the failure must still be visible — not swallowed into a clean pass.
    expect(log!.error, 'the failure must still be recorded').toBeTruthy();
  });

  it('records that it ran, so a `once` workflow does not fire twice', async () => {
    const recordId = await newLead('Partial Failure Three');

    await runWorkflowsFor('leads', ['on_create'], recordId,
      { id: recordId, full_name: 'Partial Failure Three' },
      { user: null, source: 'test' });

    const state = await db.queryOne<{ has_run: boolean }>(
      `SELECT has_run FROM ipy_workflow_state WHERE workflow_id = $1 AND record_id = $2`,
      [workflowId, recordId],
    );
    expect(state?.has_run, 'a once-workflow that ran its tasks must be marked as run').toBe(true);

    // The real damage: firing again re-runs the tasks that already succeeded.
    // add_tag is idempotent, so count log rows rather than tags — a second run
    // is a second row, and for a `send_whatsapp` task it would be a second
    // message to the customer.
    await runWorkflowsFor('leads', ['on_create'], recordId,
      { id: recordId, full_name: 'Partial Failure Three' },
      { user: null, source: 'test' });

    const runs = await db.queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM ipy_workflow_log WHERE workflow_id = $1 AND record_id = $2`,
      [workflowId, recordId],
    );
    expect(Number(runs!.n), 'a `once` workflow must not run its tasks a second time').toBe(1);
  });
});
