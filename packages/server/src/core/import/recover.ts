/**
 * Orphaned imports, closed out honestly.
 *
 * An import runs inside this process — fire-and-forget after the upload
 * responds. When the container restarts (every deploy restarts it), the
 * worker vanishes and the job row stays `running` for ever: the screen shows
 * a live-looking job nobody is working on, and a cancel click flips it to
 * `cancelling`, where it sits even deader.
 *
 * This runs once at boot. Single instance, in-process worker — so any job
 * still marked `running` at boot is by definition orphaned, and any marked
 * `cancelling` had its cancel honoured by nobody. The first is failed with a
 * note to run the file again (duplicates are skipped, so a re-run is safe);
 * the second is marked cancelled, which is what its user asked for.
 */
import type { Tx } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

const INTERRUPTED = [{
  row: 0,
  error: 'Interrupted by a server restart. Run the file again — duplicates are skipped, so nothing is created twice.',
}];

export async function recoverOrphanedImports(
  conn: { query: Tx['query'] },
): Promise<void> {
  const cancelled = await conn.query<{ id: string }>(
    `UPDATE ipy_import_job SET status = 'cancelled', completed_at = now()
     WHERE status = 'cancelling'
     RETURNING id`,
  );

  const failed = await conn.query<{ id: string }>(
    `UPDATE ipy_import_job
        SET status = 'failed', completed_at = now(), errors = errors || $1::jsonb
      WHERE status = 'running'
      RETURNING id`,
    [JSON.stringify(INTERRUPTED)],
  );

  if ((cancelled.rowCount ?? 0) + (failed.rowCount ?? 0) > 0) {
    logger.info(
      `released orphaned import job(s) after restart: `
      + `${cancelled.rowCount ?? 0} cancelled, ${failed.rowCount ?? 0} failed`,
    );
  }
}
