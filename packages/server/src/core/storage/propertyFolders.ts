/** Retryable creation of the human-facing folder tree for each property. */
import { db, transaction } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { getFolderDriver, getStorageSettings } from './index.js';
import {
  PROPERTY_MEDIA_FOLDER_TREE, recordStorageRoot,
} from './keys.js';

const MAX_ATTEMPTS = 5;
const BATCH = 5;

interface ClaimedRow {
  record_id: string;
  folder_key: string | null;
  attempts: number;
}

export interface PropertyStorageStatus {
  recordId: string;
  folderKey: string | null;
  status: 'pending' | 'running' | 'ready' | 'failed';
  provisionedDriver: string | null;
  externalUrl: string | null;
  lastError: string | null;
}

export async function getPropertyStorageStatus(recordId: string): Promise<PropertyStorageStatus | null> {
  const row = await db.queryOne<{
    record_id: string; folder_key: string | null; status: PropertyStorageStatus['status'];
    provisioned_driver: string | null; external_url: string | null; last_error: string | null;
  }>(
    `SELECT record_id, folder_key, status, provisioned_driver, external_url, last_error
       FROM ipy_property_storage WHERE record_id = $1`,
    [recordId],
  );
  return row ? {
    recordId: row.record_id,
    folderKey: row.folder_key,
    status: row.status,
    provisionedDriver: row.provisioned_driver,
    externalUrl: row.external_url,
    lastError: row.last_error,
  } : null;
}

async function folderFor(row: ClaimedRow): Promise<string | null> {
  if (row.folder_key) return row.folder_key;
  const record = await db.queryOne<{
    module_name: string; label: string; record_number: string | null; is_deleted: boolean;
  }>(
    `SELECT module_name, label, record_number, is_deleted FROM ipy_record WHERE id = $1`,
    [row.record_id],
  );
  if (!record || record.is_deleted || record.module_name !== 'properties') return null;
  const folder = recordStorageRoot(record.module_name, record.record_number, record.label, row.record_id);
  await db.query(
    `UPDATE ipy_property_storage SET folder_key = $2, updated_at = now() WHERE record_id = $1`,
    [row.record_id, folder],
  );
  return folder;
}

export interface FolderProvisionSummary { ready: number; failed: number }

async function provisionClaimed(
  row: ClaimedRow,
  storage: ReturnType<typeof getStorageSettings>,
  driver: Awaited<ReturnType<typeof getFolderDriver>>,
): Promise<boolean> {
  try {
    const folder = await folderFor(row);
    if (!folder) {
      await db.query(`DELETE FROM ipy_property_storage WHERE record_id = $1`, [row.record_id]);
      return false;
    }
    const root = await driver.ensureFolder?.(folder);
    for (const child of PROPERTY_MEDIA_FOLDER_TREE) {
      await driver.ensureFolder?.(`${folder}/${child}`);
    }
    // Its own try/catch: somebody standing in OneDrive wants the folder more
    // than they want the note in it, and a text file that failed to write must
    // not mark the whole folder as failed and stop uploads.
    try {
      const { writePropertyDetails } = await import('./propertyDetails.js');
      await writePropertyDetails(driver, row.record_id, folder);
    } catch (err) {
      logger.warn({ err, recordId: row.record_id }, 'could not write the property details file');
    }
    await db.query(
      `UPDATE ipy_property_storage
          SET status = 'ready', provisioned_driver = $2, external_url = COALESCE($3, external_url), attempts = 0,
              last_error = NULL, locked_at = NULL, updated_at = now()
        WHERE record_id = $1`,
      [row.record_id, storage.driver, root?.webUrl ?? null],
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE ipy_property_storage
          SET status = 'failed', last_error = $2, locked_at = NULL, updated_at = now()
        WHERE record_id = $1`,
      [row.record_id, message.slice(0, 1000)],
    );
    logger.error({ err, recordId: row.record_id, driver: storage.driver }, 'property folder provisioning failed');
    return false;
  }
}

/** Provision one just-created property immediately; failures stay retryable. */
export async function provisionPropertyFolder(recordId: string): Promise<PropertyStorageStatus | null> {
  const storage = getStorageSettings();
  const claimed = await transaction(async (tx) => {
    const current = await tx.queryOne<ClaimedRow & { status: PropertyStorageStatus['status']; provisioned_driver: string | null }>(
      `SELECT record_id, folder_key, attempts, status, provisioned_driver
         FROM ipy_property_storage WHERE record_id = $1 FOR UPDATE`,
      [recordId],
    );
    if (!current) return null;
    if (current.status === 'ready' && current.provisioned_driver === storage.driver) return null;
    if (current.status === 'running' || current.attempts >= MAX_ATTEMPTS) return null;
    return tx.queryOne<ClaimedRow>(
      `UPDATE ipy_property_storage
          SET status = 'running', locked_at = now(), attempts = attempts + 1,
              last_error = NULL, updated_at = now()
        WHERE record_id = $1
      RETURNING record_id, folder_key, attempts`,
      [recordId],
    );
  });
  if (claimed) await provisionClaimed(claimed, storage, await getFolderDriver());
  return getPropertyStorageStatus(recordId);
}

/**
 * Create a few complete trees per scheduler tick.
 *
 * `provisioned_driver` is part of the due condition: switching from local/S3
 * to OneDrive automatically replays every property without editing any row.
 */
export async function provisionPendingPropertyFolders(limit = BATCH): Promise<FolderProvisionSummary> {
  const storage = getStorageSettings();
  const claimed = await transaction(async (tx) => {
    await tx.query(
      `UPDATE ipy_property_storage
          SET status = 'pending', locked_at = NULL, updated_at = now()
        WHERE status = 'running' AND locked_at < now() - interval '20 minutes'`,
    );
    const result = await tx.query<ClaimedRow>(
      `WITH due AS (
         SELECT record_id
           FROM ipy_property_storage
          WHERE attempts < $2
            AND (
              status = 'pending'
              OR (status = 'ready' AND provisioned_driver IS DISTINCT FROM $1)
              OR (status = 'failed' AND updated_at < now() - interval '5 minutes')
            )
            AND status <> 'running'
          ORDER BY created_at DESC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       UPDATE ipy_property_storage p
          SET status = 'running', locked_at = now(),
              attempts = p.attempts + 1,
              last_error = NULL, updated_at = now()
         FROM due
        WHERE p.record_id = due.record_id
       RETURNING p.record_id, p.folder_key, p.attempts`,
      [storage.driver, MAX_ATTEMPTS, limit],
    );
    return result.rows;
  });
  if (!claimed.length) return { ready: 0, failed: 0 };

  let ready = 0;
  let failed = 0;
  let driver: Awaited<ReturnType<typeof getFolderDriver>> | null = null;

  for (const row of claimed) {
    try {
      driver ??= await getFolderDriver();
      if (await provisionClaimed(row, storage, driver)) ready += 1;
      else failed += 1;
    } catch (err) {
      logger.error({ err, recordId: row.record_id }, 'property folder worker failed before provisioning');
      failed += 1;
    }
  }

  if (ready) logger.info({ ready, driver: storage.driver }, 'property folder trees provisioned');
  return { ready, failed };
}
