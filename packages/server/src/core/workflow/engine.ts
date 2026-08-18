/**
 * Workflow engine.
 *
 * Subscribes to record events, evaluates conditions in-process (no extra DB
 * round trip), and dispatches tasks either immediately or onto the deferred
 * queue. Failures are logged per-workflow and never propagate back to the save
 * that triggered them.
 */
import type { AuthUser, FilterGroup } from '@ipropy/shared';
import { organisationTimezone } from '../../core/settings/timezone.js';
import { db, type Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { bus, type RecordEventPayload } from '../events/bus.js';
import { evaluateFilter } from '@ipropy/shared';
import { registry } from '../metadata/registry.js';
import { runTask, type TaskContext } from './tasks.js';

export interface WorkflowRow {
  id: string;
  module_name: string;
  name: string;
  trigger: string;
  watch_fields: string[];
  conditions: FilterGroup;
  execution_mode: 'always' | 'once' | 'once_until_false';
  is_active: boolean;
  schedule: Record<string, unknown> | null;
}

export interface TaskRow {
  id: string;
  workflow_id: string;
  type: string;
  name: string;
  sequence: number;
  delay_minutes: number;
  delay_field: string | null;
  delay_direction: 'before' | 'after' | null;
  config: Record<string, unknown>;
}

/** Cache of active workflows per (module, trigger). */
let workflowCache: Map<string, WorkflowRow[]> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 30_000;

export function invalidateWorkflows(): void {
  workflowCache = null;
}

async function getWorkflows(moduleName: string, triggers: string[]): Promise<WorkflowRow[]> {
  if (!workflowCache || Date.now() - cacheLoadedAt > CACHE_TTL) {
    const res = await db.query<WorkflowRow>(
      `SELECT w.id, m.name AS module_name, w.name, w.trigger, w.watch_fields, w.conditions,
              w.execution_mode, w.is_active, w.schedule
       FROM ipy_workflow w JOIN ipy_module m ON m.id = w.module_id
       WHERE w.is_active ORDER BY w.sequence`,
    );
    workflowCache = new Map();
    for (const wf of res.rows) {
      const key = `${wf.module_name}:${wf.trigger}`;
      const list = workflowCache.get(key) ?? [];
      list.push(wf);
      workflowCache.set(key, list);
    }
    cacheLoadedAt = Date.now();
  }
  return triggers.flatMap((t) => workflowCache!.get(`${moduleName}:${t}`) ?? []);
}

async function getTasks(workflowId: string, conn: Tx = db): Promise<TaskRow[]> {
  const res = await conn.query<TaskRow>(
    `SELECT id, workflow_id, type, name, sequence, delay_minutes, delay_field, delay_direction, config
     FROM ipy_workflow_task WHERE workflow_id = $1 AND is_active ORDER BY sequence`,
    [workflowId],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** for on_field_change: which fields actually changed */
  changedFields?: string[];
  previous?: Record<string, unknown>;
  user: AuthUser | null;
  source: string;
}

export async function runWorkflowsFor(
  moduleName: string,
  triggers: string[],
  recordId: string,
  record: Record<string, unknown>,
  opts: RunOptions,
): Promise<void> {
  const workflows = await getWorkflows(moduleName, triggers);
  if (!workflows.length) return;

  // The organisation's day, not the server's. Without this a container running
  // UTC — which is every container unless somebody sets TZ — evaluates `today`,
  // `this_week` and `this_month` against a day that ends five and a half hours
  // early, while the SQL side has always used `AT TIME ZONE`. Two engines, one
  // grammar, different answers for records touched between midnight and 5:30am
  // in Mumbai.
  const timezone = await organisationTimezone();

  for (const wf of workflows) {
    const started = Date.now();
    try {
      // on_field_change only fires when one of the watched fields moved.
      if (wf.trigger === 'on_field_change') {
        const watched = wf.watch_fields ?? [];
        const changed = opts.changedFields ?? [];
        if (watched.length && !watched.some((f) => changed.includes(f))) continue;
      }

      const matched = evaluateFilter(wf.conditions, record, {
        userId: opts.user?.id,
        previous: opts.previous,
        timezone,
      });

      const shouldRun = await checkExecutionMode(wf, recordId, matched);
      if (!matched || !shouldRun) {
        await recordState(wf.id, recordId, matched, false);
        continue;
      }

      const tasks = await getTasks(wf.id);
      let ran = 0;
      const failures: string[] = [];

      for (const task of tasks) {
        // Each task stands on its own. A workflow is a list of independent
        // things to do to a record, not a transaction: failing to *offer* a
        // WhatsApp message is no reason to skip scoring it, tagging it and
        // setting the follow-up date. Before this, one throw abandoned every
        // later task — and `webhook` rethrows by design, while `trigger_call`
        // throws on every run of an install with no telephony provider.
        try {
          const delayMs = computeDelay(task, record);
          if (delayMs > 0) {
            await enqueue(wf.id, task.id, recordId, moduleName, new Date(Date.now() + delayMs), {
              userId: opts.user?.id ?? null,
              source: opts.source,
            });
          } else {
            const ctx: TaskContext = {
              workflowId: wf.id,
              taskId: task.id,
              module: moduleName,
              recordId,
              record,
              previous: opts.previous,
              user: opts.user,
              source: `workflow:${wf.name}`,
            };
            await runTask(task.type, task.config, ctx);
          }
          ran++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, workflow: wf.name, task: task.name, type: task.type, recordId },
            'workflow task failed; continuing with the rest');
          failures.push(`${task.name || task.type}: ${message}`);
        }
      }

      // Recorded even when tasks failed, and this is the important half.
      // `has_run` is what stops a `once` workflow firing again; leaving it
      // false because task 3 of 5 threw means the next touch of this record
      // re-runs tasks 1 and 2 — which have already sent their message.
      await recordState(wf.id, recordId, true, true);
      await db.query(
        `UPDATE ipy_workflow SET last_run_at = now(), run_count = run_count + 1 WHERE id = $1`,
        [wf.id],
      );
      // 'partial' rather than 'success': the tasks that ran, ran, and the log
      // says how many — but a run with a failure in it must never read as clean.
      await log(
        wf.id, recordId,
        failures.length ? 'partial' : 'success',
        true, ran, Date.now() - started,
        failures.length ? failures.join(' | ') : null,
      );
    } catch (err) {
      logger.error({ err, workflow: wf.name, recordId }, 'workflow execution failed');
      await log(wf.id, recordId, 'error', true, 0, Date.now() - started,
        err instanceof Error ? err.message : String(err));
    }
  }
}

/** `once` and `once_until_false` need per-record state to avoid re-firing. */
async function checkExecutionMode(wf: WorkflowRow, recordId: string, matched: boolean): Promise<boolean> {
  if (wf.execution_mode === 'always') return true;

  const state = await db.queryOne<{ has_run: boolean; last_matched: boolean }>(
    `SELECT has_run, last_matched FROM ipy_workflow_state WHERE workflow_id = $1 AND record_id = $2`,
    [wf.id, recordId],
  );

  if (wf.execution_mode === 'once') return !state?.has_run;

  // once_until_false: re-arms only after the conditions stop matching.
  if (!state) return matched;
  if (state.last_matched) return false;
  return matched;
}

async function recordState(workflowId: string, recordId: string, matched: boolean, ran: boolean): Promise<void> {
  await db.query(
    `INSERT INTO ipy_workflow_state (workflow_id, record_id, has_run, last_matched, last_run_at)
     VALUES ($1,$2,$3,$4, CASE WHEN $3 THEN now() ELSE NULL END)
     ON CONFLICT (workflow_id, record_id) DO UPDATE SET
       has_run = ipy_workflow_state.has_run OR EXCLUDED.has_run,
       last_matched = EXCLUDED.last_matched,
       last_run_at = COALESCE(EXCLUDED.last_run_at, ipy_workflow_state.last_run_at)`,
    [workflowId, recordId, ran, matched],
  ).catch((err) => logger.warn({ err }, 'failed to persist workflow state'));
}

async function log(
  workflowId: string, recordId: string, status: string, matched: boolean,
  tasksRun: number, durationMs: number, error: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO ipy_workflow_log (workflow_id, record_id, status, matched, tasks_run, duration_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [workflowId, recordId, status, matched, tasksRun, durationMs, error],
  ).catch(() => undefined);
}

/**
 * Absolute delay in ms. Supports both "wait N minutes" and "N minutes before
 * {scheduled_at}" — the latter is what makes reminder workflows possible.
 */
function computeDelay(task: TaskRow, record: Record<string, unknown>): number {
  if (task.delay_field) {
    const anchorRaw = record[task.delay_field];
    if (anchorRaw) {
      const anchor = new Date(String(anchorRaw));
      if (!Number.isNaN(anchor.getTime())) {
        const offsetMs = (task.delay_minutes || 0) * 60_000;
        const target = task.delay_direction === 'before'
          ? anchor.getTime() - offsetMs
          : anchor.getTime() + offsetMs;
        // Anchors already in the past fire immediately rather than never.
        return Math.max(0, target - Date.now());
      }
    }
    return 0;
  }
  return (task.delay_minutes || 0) * 60_000;
}

async function enqueue(
  workflowId: string, taskId: string, recordId: string, moduleName: string,
  runAt: Date, payload: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO ipy_task_queue (workflow_id, task_id, record_id, module_name, run_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [workflowId, taskId, recordId, moduleName, runAt, JSON.stringify(payload)],
  );
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

export function registerWorkflowHandlers(): void {
  bus.on('record.created', async (p: RecordEventPayload) => {
    await runWorkflowsFor(p.module, ['on_create', 'on_create_or_modify'], p.recordId, p.record, {
      user: p.user, source: p.source,
    });
  });

  bus.on('record.updated', async (p: RecordEventPayload) => {
    await runWorkflowsFor(
      p.module,
      ['on_modify', 'on_create_or_modify', 'on_field_change'],
      p.recordId,
      p.record,
      { changedFields: p.changedFields, previous: p.previous, user: p.user, source: p.source },
    );
  });

  bus.on('record.deleted', async (p: RecordEventPayload) => {
    await runWorkflowsFor(p.module, ['on_delete'], p.recordId, p.record, {
      user: p.user, source: p.source,
    });
  });

  bus.on('message.received', async (p) => {
    if (!p.recordId) return;
    const conv = await db.queryOne<{ record_module: string | null }>(
      `SELECT record_module FROM ipy_conversation WHERE id = $1`, [p.conversationId],
    );
    if (!conv?.record_module) return;
    const record = await loadRecordValues(conv.record_module, p.recordId);
    if (!record) return;
    await runWorkflowsFor(conv.record_module, ['on_inbound_message'], p.recordId, record, {
      user: null, source: 'inbound_message',
    });
  });

  bus.on('call.ended', async (p) => {
    if (!p.recordId) return;
    const call = await db.queryOne<{ record_module: string | null }>(
      `SELECT record_module FROM ipy_call WHERE id = $1`, [p.callId],
    );
    if (!call?.record_module) return;
    const record = await loadRecordValues(call.record_module, p.recordId);
    if (!record) return;
    await runWorkflowsFor(call.record_module, ['on_call_end'], p.recordId, record, {
      user: null, source: 'call_end',
    });
  });

  logger.info('workflow handlers registered');
}

/** Load a record's values without a user context — used by system triggers. */
export async function loadRecordValues(
  moduleName: string,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const module = await registry.getModule(moduleName);
  if (!module) return null;
  const row = await db.queryOne<Record<string, unknown>>(
    `SELECT r.*, e.* FROM ipy_record r
     JOIN ${module.tableName} e ON e.record_id = r.id
     WHERE r.id = $1 AND r.is_deleted = false`,
    [recordId],
  );
  if (!row) return null;

  const custom = (row.custom_fields ?? {}) as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const f of module.fields) {
    values[f.name] = f.storage === 'column' ? row[f.columnName] : custom[f.columnName];
  }
  values.owner_id = row.owner_id;
  values.created_by = row.created_by;
  values.created_at = row.created_at;
  values.updated_at = row.updated_at;
  values.last_activity_at = row.last_activity_at;
  values.record_number = row.record_number;
  values.__label = row.label;
  values.__id = recordId;
  return values;
}
