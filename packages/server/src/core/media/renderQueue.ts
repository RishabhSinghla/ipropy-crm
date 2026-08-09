/**
 * The render queue.
 *
 * Reels and brochures take tens of seconds — far longer than an HTTP request
 * should stay open, and long enough that a phone on a patchy connection will
 * give up halfway and leave the user thinking it failed. So the request queues
 * a job and returns; the scheduler drains it; the UI polls.
 *
 * Jobs are claimed with FOR UPDATE SKIP LOCKED so two server instances never
 * render the same reel twice, matching how the workflow and media queues work.
 */
import { db } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { notify } from '../notifications/index.js';
import { renderReel, isFfmpegAvailable, type ReelSpec } from './reel.js';
import { renderBrochure, type BrochureSpec } from './brochure.js';

/** One at a time: ffmpeg saturates the CPU, and two concurrent reels are slower than two sequential ones. */
const BATCH = 1;
const MAX_ATTEMPTS = 3;

export async function drainRenders(): Promise<number> {
  // A process can die after claiming a job. It is safe to retry because every
  // renderer writes to a deterministic job-specific key.
  await db.query(
    `UPDATE ipy_render_job
     SET status = 'queued', started_at = NULL,
         error = COALESCE(error || E'\n', '') || 'Recovered after an interrupted render'
     WHERE status = 'running' AND started_at < now() - interval '30 minutes'`,
  );

  const claimed = await db.query<{ id: string; kind: string; spec: Record<string, unknown>; requested_by: string | null; attempts: number }>(
    `UPDATE ipy_render_job SET status = 'running', started_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM ipy_render_job
       WHERE status = 'queued' AND attempts < $2
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, kind, spec, requested_by, attempts`,
    [BATCH, MAX_ATTEMPTS],
  );

  for (const job of claimed.rows) {
    await runJob(job);
  }
  return claimed.rows.length;
}

async function runJob(job: {
  id: string; kind: string; spec: Record<string, unknown>; requested_by: string | null; attempts: number;
}): Promise<void> {
  try {
    if (job.kind === 'reel') {
      if (!(await isFfmpegAvailable())) {
        await markUnsupported(
          job.id,
          'Video rendering needs ffmpeg on the server. Everything else in the studio works without it — this one job cannot run here.',
        );
        return;
      }
      const result = await renderReel(job.spec as unknown as ReelSpec, job.id);
      if (!result) {
        await markUnsupported(job.id, 'Video rendering is unavailable on this server.');
        return;
      }
      await complete(job, result.key, result.mime, `Reel ready — ${result.durationSeconds}s`);
      return;
    }

    if (job.kind === 'brochure') {
      const result = await renderBrochure(job.spec as unknown as BrochureSpec, job.id);
      await complete(job, result.key, result.mime, `Brochure ready — ${result.pages} pages`);
      return;
    }

    await markUnsupported(job.id, `Unknown render type "${job.kind}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobId: job.id, kind: job.kind }, 'render job failed');

    // Below the attempt ceiling the job goes back to `queued` and the next tick
    // retries it — most render failures are a transient fetch of one photo.
    const exhausted = job.attempts >= MAX_ATTEMPTS;
    await db.query(
      `UPDATE ipy_render_job
       SET status = $2, error = $3, started_at = CASE WHEN $2 = 'queued' THEN NULL ELSE started_at END,
           finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
       WHERE id = $1`,
      [job.id, exhausted ? 'failed' : 'queued', message.slice(0, 1000)],
    );

    if (exhausted && job.requested_by) {
      await notify({
        userId: job.requested_by,
        kind: 'studio',
        title: 'A render could not be completed',
        body: message.slice(0, 200),
        link: '/studio',
      });
    }
  }
}

async function complete(
  job: { id: string; requested_by: string | null },
  key: string,
  mime: string,
  message: string,
): Promise<void> {
  await db.query(
    `UPDATE ipy_render_job
     SET status = 'completed', progress = 100, output_key = $2, output_mime = $3,
         error = NULL, finished_at = now()
     WHERE id = $1`,
    [job.id, key, mime],
  );

  if (job.requested_by) {
    await notify({
      userId: job.requested_by,
      kind: 'studio',
      title: message,
      body: 'Open the studio to download or share it.',
      link: '/studio',
    });
  }
  logger.info({ jobId: job.id, key }, 'render complete');
}

/**
 * `unsupported` rather than `failed`.
 *
 * A missing ffmpeg is an operations fact, not a bad request — and the two need
 * to look different in the UI, because one is fixed by installing something and
 * the other by changing what you asked for.
 */
async function markUnsupported(jobId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE ipy_render_job SET status = 'unsupported', error = $2, finished_at = now() WHERE id = $1`,
    [jobId, reason],
  );
}

export async function queueRender(input: {
  kind: 'reel' | 'brochure';
  spec: Record<string, unknown>;
  recordId?: string | null;
  designId?: string | null;
  requestedBy: string;
}): Promise<{ id: string }> {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO ipy_render_job (kind, spec, record_id, design_id, requested_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.kind, JSON.stringify(input.spec), input.recordId ?? null, input.designId ?? null, input.requestedBy],
  );
  return { id: row!.id };
}
