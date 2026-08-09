/**
 * Scheduler.
 *
 * One in-process tick handles three jobs:
 *   1. drain the deferred task queue (delayed workflow tasks)
 *   2. run scheduled workflows whose next_run_at has come due
 *   3. housekeeping — SLA breaches, activity reminders, stage timers
 *
 * Queue rows are claimed with FOR UPDATE SKIP LOCKED, so running more than one
 * server instance is safe without an external queue.
 */
import { db, transaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { loadRecordValues, runWorkflowsFor } from './engine.js';
import { runTask, type TaskContext } from './tasks.js';
import { loadUser } from '../../middleware/auth.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

export function startScheduler(): void {
  if (!config.scheduler.enabled) {
    logger.info('scheduler disabled');
    return;
  }
  const intervalMs = config.scheduler.tickSeconds * 1000;
  timer = setInterval(() => { void tick(); }, intervalMs);
  // Unref so the process can exit cleanly in tests/CLI usage.
  timer.unref?.();
  logger.info({ everySeconds: config.scheduler.tickSeconds }, 'scheduler started');
  // Run once shortly after boot so a restart doesn't stall pending work.
  setTimeout(() => { void tick(); }, 5000).unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (running) return; // never overlap ticks
  running = true;
  try {
    await Promise.allSettled([
      drainQueue(),
      drainMediaQueue(),
      drainRenderQueue(),
      runScheduledWorkflows(),
      runSequences(),
      startDueBroadcasts(),
      housekeeping(),
      maybeRunSeoAudit(),
    ]);
  } catch (err) {
    logger.error({ err }, 'scheduler tick failed');
  } finally {
    running = false;
  }
}

/**
 * Advance drip sequences whose next step has come due.
 *
 * Dynamically imported like the other optional subsystems, so a broken
 * sequence module can never stop the queue from draining.
 */
async function runSequences(): Promise<void> {
  try {
    const { runDueEnrolments } = await import('../../integrations/whatsapp/sequences.js');
    const result = await runDueEnrolments();
    if (result.ran || result.exited) {
      logger.debug({ ...result }, 'sequences advanced');
    }
  } catch (err) {
    logger.error({ err }, 'sequence run failed');
  }
}

/** Kick off broadcasts whose scheduled time has arrived. */
async function startDueBroadcasts(): Promise<void> {
  try {
    const { runDueBroadcasts } = await import('../../integrations/whatsapp/broadcast.js');
    await runDueBroadcasts();
  } catch (err) {
    logger.error({ err }, 'scheduled broadcast dispatch failed');
  }
}

/** Render reels and brochures queued by the studio. */
async function drainRenderQueue(): Promise<void> {
  try {
    const { drainRenders } = await import('../media/renderQueue.js');
    await drainRenders();
  } catch (err) {
    logger.error({ err }, 'render queue failed');
  }
}

/**
 * Fetches and scores the live website once a day.
 *
 * Guarded on the last run rather than a cron expression, so a restart or a
 * missed window still produces one audit per day instead of none — the point
 * is a daily datapoint, not a precise hour.
 */
async function maybeRunSeoAudit(): Promise<void> {
  try {
    const enabled = await db.queryOne<{ value: boolean }>(
      `SELECT (value #>> '{}')::boolean AS value FROM ipy_setting WHERE key = 'seo.audit_enabled'`,
    );
    if (enabled?.value === false) return;
    const { runSeoAudit, shouldRunSeoAudit } = await import('../seo/audit.js');
    if (!(await shouldRunSeoAudit())) return;
    await runSeoAudit();
  } catch (err) {
    logger.error({ err }, 'SEO audit failed');
  }
}

// ---------------------------------------------------------------------------
// 1. Deferred task queue
// ---------------------------------------------------------------------------

interface QueueRow {
  id: number;
  workflow_id: string | null;
  task_id: string | null;
  record_id: string | null;
  module_name: string | null;
  payload: { userId?: string | null; source?: string };
  attempts: number;
  max_attempts: number;
}

async function drainQueue(batchSize = 50): Promise<void> {
  const claimed = await transaction(async (tx) => {
    const res = await tx.query<QueueRow>(
      `WITH due AS (
         SELECT id FROM ipy_task_queue
         WHERE status = 'pending' AND run_at <= now()
         ORDER BY run_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ipy_task_queue q
       SET status = 'running', locked_at = now(), locked_by = $2, attempts = q.attempts + 1
       FROM due WHERE q.id = due.id
       RETURNING q.id, q.workflow_id, q.task_id, q.record_id, q.module_name, q.payload, q.attempts, q.max_attempts`,
      [batchSize, WORKER_ID],
    );
    return res.rows;
  });

  if (!claimed.length) return;
  logger.debug({ count: claimed.length }, 'processing deferred workflow tasks');

  for (const job of claimed) {
    try {
      if (!job.task_id || !job.record_id || !job.module_name) {
        await complete(job.id, 'done');
        continue;
      }

      const task = await db.queryOne<{ type: string; config: Record<string, unknown> }>(
        `SELECT type, config FROM ipy_workflow_task WHERE id = $1 AND is_active`,
        [job.task_id],
      );
      if (!task) { await complete(job.id, 'cancelled'); continue; }

      const record = await loadRecordValues(job.module_name, job.record_id);
      if (!record) {
        // The record was deleted while the task waited — that's not a failure.
        await complete(job.id, 'cancelled');
        continue;
      }

      const user = job.payload?.userId ? await loadUser(job.payload.userId) : null;
      const ctx: TaskContext = {
        workflowId: job.workflow_id ?? '',
        taskId: job.task_id,
        module: job.module_name,
        recordId: job.record_id,
        record,
        user,
        source: job.payload?.source ?? 'scheduler',
      };

      await runTask(task.type, task.config, ctx);
      await complete(job.id, 'done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, jobId: job.id }, 'deferred task failed');
      if (job.attempts >= job.max_attempts) {
        await db.query(
          `UPDATE ipy_task_queue SET status = 'failed', last_error = $2, completed_at = now() WHERE id = $1`,
          [job.id, message],
        );
      } else {
        // Exponential backoff: 5m, 25m, 125m.
        const backoffMinutes = 5 ** job.attempts;
        await db.query(
          `UPDATE ipy_task_queue SET status = 'pending', last_error = $2, locked_at = NULL, locked_by = NULL,
             run_at = now() + ($3 || ' minutes')::interval
           WHERE id = $1`,
          [job.id, message, backoffMinutes],
        );
      }
    }
  }
}

async function complete(id: number, status: string): Promise<void> {
  await db.query(
    `UPDATE ipy_task_queue SET status = $2, completed_at = now(), locked_at = NULL, locked_by = NULL WHERE id = $1`,
    [id, status],
  );
}

// ---------------------------------------------------------------------------
// 1b. Media processing queue (derivative images/video for uploaded attachments)
//
// Same claim/retry/backoff shape as the deferred task queue above, on its own
// table (ipy_media_job) since these jobs aren't tied to a workflow/task.
// Attachment-only, generic-purpose. See core/media/pipeline.ts for what a job
// actually does — this function only owns claiming and retry bookkeeping.
// ---------------------------------------------------------------------------

interface MediaJobRow {
  id: number;
  attachment_id: string;
  attempts: number;
  max_attempts: number;
}

async function drainMediaQueue(batchSize = 20): Promise<void> {
  const claimed = await transaction(async (tx) => {
    const res = await tx.query<MediaJobRow>(
      `WITH due AS (
         SELECT id FROM ipy_media_job
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ipy_media_job j
       SET status = 'running', locked_at = now(), locked_by = $2, attempts = j.attempts + 1
       FROM due WHERE j.id = due.id
       RETURNING j.id, j.attachment_id, j.attempts, j.max_attempts`,
      [batchSize, WORKER_ID],
    );
    return res.rows;
  });

  if (!claimed.length) return;
  logger.debug({ count: claimed.length }, 'processing media jobs');

  for (const job of claimed) {
    try {
      const { processAttachment } = await import('../media/pipeline.js');
      await processAttachment(job.attachment_id);
      await db.query(
        `UPDATE ipy_media_job SET status = 'done', completed_at = now(), locked_at = NULL, locked_by = NULL WHERE id = $1`,
        [job.id],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, jobId: job.id, attachmentId: job.attachment_id }, 'media job failed');
      if (job.attempts >= job.max_attempts) {
        await db.query(
          `UPDATE ipy_media_job SET status = 'failed', last_error = $2, completed_at = now() WHERE id = $1`,
          [job.id, message],
        );
      } else {
        await db.query(
          `UPDATE ipy_media_job SET status = 'pending', last_error = $2, locked_at = NULL, locked_by = NULL WHERE id = $1`,
          [job.id, message],
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Scheduled workflows
// ---------------------------------------------------------------------------

interface ScheduledRow {
  id: string;
  module_name: string;
  name: string;
  schedule: { frequency: string; time?: string; daysOfWeek?: number[]; dayOfMonth?: number } | null;
  conditions: never;
  next_run_at: string | null;
}

async function runScheduledWorkflows(): Promise<void> {
  const due = await db.query<ScheduledRow>(
    `SELECT w.id, m.name AS module_name, w.name, w.schedule, w.conditions, w.next_run_at
     FROM ipy_workflow w JOIN ipy_module m ON m.id = w.module_id
     WHERE w.is_active AND w.trigger = 'scheduled'
       AND (w.next_run_at IS NULL OR w.next_run_at <= now())`,
  );

  for (const wf of due.rows) {
    // Claim it immediately so a slow run doesn't get double-started next tick.
    const next = computeNextRun(wf.schedule);
    await db.query(`UPDATE ipy_workflow SET next_run_at = $2 WHERE id = $1`, [wf.id, next]);

    // A first-ever run just schedules; it doesn't fire retroactively.
    if (!wf.next_run_at) continue;

    try {
      const module = await import('../metadata/registry.js').then((m) => m.registry.getModule(wf.module_name));
      if (!module) continue;

      // Only walk records that could match — capped so a bad rule can't melt the DB.
      const candidates = await db.query<{ id: string }>(
        `SELECT r.id FROM ipy_record r
         WHERE r.module_id = $1 AND r.is_deleted = false
         ORDER BY r.updated_at DESC LIMIT 5000`,
        [module.id],
      );

      let matched = 0;
      for (const row of candidates.rows) {
        const record = await loadRecordValues(wf.module_name, row.id);
        if (!record) continue;
        const before = matched;
        await runWorkflowsFor(wf.module_name, ['scheduled'], row.id, record, {
          user: null, source: 'scheduler',
        });
        matched = before + 1;
      }
      logger.info({ workflow: wf.name, scanned: candidates.rows.length }, 'scheduled workflow completed');
    } catch (err) {
      logger.error({ err, workflow: wf.name }, 'scheduled workflow failed');
    }
  }
}

function computeNextRun(schedule: ScheduledRow['schedule']): Date {
  const now = new Date();
  if (!schedule) return new Date(now.getTime() + 3_600_000);

  const [hh, mm] = (schedule.time ?? '09:00').split(':').map(Number);

  switch (schedule.frequency) {
    case 'hourly':
      return new Date(now.getTime() + 3_600_000);

    case 'daily': {
      const next = new Date(now);
      next.setHours(hh, mm, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next;
    }

    case 'weekly': {
      const days = schedule.daysOfWeek?.length ? schedule.daysOfWeek : [1];
      const next = new Date(now);
      next.setHours(hh, mm, 0, 0);
      for (let i = 0; i < 8; i++) {
        const candidate = new Date(next);
        candidate.setDate(next.getDate() + i);
        if (days.includes(candidate.getDay()) && candidate > now) return candidate;
      }
      return new Date(now.getTime() + 7 * 86_400_000);
    }

    case 'monthly': {
      const day = schedule.dayOfMonth ?? 1;
      const next = new Date(now.getFullYear(), now.getMonth(), day, hh, mm, 0, 0);
      if (next <= now) next.setMonth(next.getMonth() + 1);
      return next;
    }

    default:
      return new Date(now.getTime() + 3_600_000);
  }
}

// ---------------------------------------------------------------------------
// 3. Housekeeping
// ---------------------------------------------------------------------------

async function housekeeping(): Promise<void> {
  await Promise.allSettled([
    updateStageTimers(),
    checkSlaBreaches(),
    sendActivityReminders(),
    expireWhatsAppWindows(),
    pruneOldQueueRows(),
    pollInboundEmail(),
  ]);
}

let lastImapPollAt = 0;

/**
 * IMAP inbound sync runs on the scheduler but throttled to its own cadence —
 * the 60s tick is far too frequent for a mailbox poll.
 */
async function pollInboundEmail(): Promise<void> {
  const intervalMs = Math.max(1, config.email.imap.pollMinutes) * 60_000;
  if (Date.now() - lastImapPollAt < intervalMs) return;
  lastImapPollAt = Date.now();
  const { syncInboundEmails } = await import('../../integrations/email/inbound.js');
  const result = await syncInboundEmails();
  if (result.imported > 0 || result.errors.length) {
    logger.info({ ...result }, 'inbound email sync');
  }
}

/** Keep days_in_stage honest without touching the record service. */
async function updateStageTimers(): Promise<void> {
  await db.query(`
    UPDATE ipy_e_deals SET days_in_stage = GREATEST(0, EXTRACT(DAY FROM now() - stage_changed_at)::int)
    WHERE stage_changed_at IS NOT NULL AND is_won = false AND is_lost = false
  `);
}

async function checkSlaBreaches(): Promise<void> {
  const breached = await db.query<{ record_id: string; policy_id: string; escalate_to: string | null }>(
    `UPDATE ipy_sla_tracker t
     SET first_response_breached = true
     FROM ipy_sla_policy p
     WHERE t.policy_id = p.id
       AND t.first_response_at IS NULL
       AND t.first_response_due < now()
       AND t.first_response_breached = false
     RETURNING t.record_id, t.policy_id, p.escalate_to_user_id AS escalate_to`,
  );

  for (const row of breached.rows) {
    if (!row.escalate_to) continue;
    const record = await db.queryOne<{ label: string; module_name: string }>(
      `SELECT label, module_name FROM ipy_record WHERE id = $1`, [row.record_id],
    );
    await db.query(
      `INSERT INTO ipy_notification (user_id, kind, title, body, link, record_id)
       VALUES ($1,'sla_breach','SLA breached',$2,$3,$4)`,
      [
        row.escalate_to,
        `${record?.label ?? 'A record'} has missed its first-response SLA.`,
        `/${record?.module_name}/${row.record_id}`,
        row.record_id,
      ],
    );
  }
}

/** Fire activity reminders N minutes before the start time. */
async function sendActivityReminders(): Promise<void> {
  const due = await db.query<{ record_id: string; subject: string; owner_id: string | null; start_at: string }>(
    `SELECT a.record_id, a.subject, r.owner_id, a.start_at
     FROM ipy_e_activities a JOIN ipy_record r ON r.id = a.record_id
     WHERE a.reminder_minutes IS NOT NULL
       AND a.reminder_sent = false
       AND a.status <> 'Completed'
       AND a.start_at IS NOT NULL
       AND a.start_at - (a.reminder_minutes || ' minutes')::interval <= now()
       AND a.start_at > now()
       AND r.is_deleted = false
     LIMIT 200`,
  );

  for (const a of due.rows) {
    if (a.owner_id) {
      await db.query(
        `INSERT INTO ipy_notification (user_id, kind, title, body, link, record_id)
         VALUES ($1,'reminder','Upcoming: ' || $2, $3, $4, $5)`,
        [
          a.owner_id, a.subject,
          `Starts at ${new Date(a.start_at).toLocaleString('en-IN')}`,
          `/activities/${a.record_id}`, a.record_id,
        ],
      );
    }
    await db.query(`UPDATE ipy_e_activities SET reminder_sent = true WHERE record_id = $1`, [a.record_id]);
  }
}

/**
 * WhatsApp only allows free-form replies inside a 24h window. Clearing expired
 * windows makes the composer switch to template-only, matching Meta's rules.
 */
async function expireWhatsAppWindows(): Promise<void> {
  await db.query(
    `UPDATE ipy_conversation SET window_expires_at = NULL
     WHERE channel = 'whatsapp' AND window_expires_at IS NOT NULL AND window_expires_at < now()`,
  );
}

async function pruneOldQueueRows(): Promise<void> {
  await db.query(
    `DELETE FROM ipy_task_queue WHERE status IN ('done','cancelled') AND completed_at < now() - interval '14 days'`,
  );
  await db.query(
    `DELETE FROM ipy_media_job WHERE status = 'done' AND completed_at < now() - interval '14 days'`,
  );
  await db.query(`DELETE FROM ipy_workflow_log WHERE created_at < now() - interval '60 days'`);
  await db.query(`DELETE FROM ipy_session WHERE expires_at < now() - interval '7 days'`);
}

/** Exposed for the admin "run now" button. */
export async function runSchedulerNow(): Promise<void> {
  await tick();
}
