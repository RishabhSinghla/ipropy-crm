/**
 * A restart orphans any import that was in flight: the worker lived in the
 * old process, so the job row would say `running` for ever. The boot sweep
 * closes those out — cancelling ones are honoured as cancelled, running ones
 * fail with a note that a re-run is safe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/pool.js';
import { recoverOrphanedImports } from '../../src/core/import/recover.js';

const made: string[] = [];

beforeAll(async () => {
  const rows: Array<[string, string]> = [
    ['running', 'never finished'],
    ['cancelling', 'cancel clicked, then the process died'],
  ];
  for (const [status, name] of rows) {
    const job = await db.queryOne<{ id: string }>(
      `INSERT INTO ipy_import_job (module_id, user_id, file_name, status, total_rows)
       VALUES ((SELECT id FROM ipy_module WHERE name = 'leads'),
               (SELECT id FROM ipy_user WHERE is_admin = true LIMIT 1),
               $2, $1, 10)
       RETURNING id`,
      [status, name],
    );
    if (job?.id) made.push(job.id);
  }
});

afterAll(async () => {
  if (made.length) {
    await db.query(`DELETE FROM ipy_import_job WHERE id = ANY($1::uuid[])`, [made]);
  }
});

describe('import recovery at boot', () => {
  it('marks an orphaned running import failed, with a note to re-run', async () => {
    await recoverOrphanedImports(db);

    const job = await db.queryOne<{ status: string; errors: { error: string }[]; completed_at: string | null }>(
      `SELECT status, errors, completed_at FROM ipy_import_job WHERE id = $1`,
      [made[0]],
    );
    expect(job?.status).toBe('failed');
    expect(job?.completed_at).toBeTruthy();
    expect(job?.errors?.[0]?.error).toMatch(/restart/i);
  });

  it('honours a cancel that was already asked for', async () => {
    await recoverOrphanedImports(db);

    const job = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_import_job WHERE id = $1`,
      [made[1]],
    );
    expect(job?.status).toBe('cancelled');
  });

  it('is safe to run twice — nothing is still in flight', async () => {
    await recoverOrphanedImports(db);
    await recoverOrphanedImports(db);

    const job = await db.queryOne<{ status: string }>(
      `SELECT status FROM ipy_import_job WHERE id = $1`,
      [made[0]],
    );
    expect(job?.status).toBe('failed');
  });
});
