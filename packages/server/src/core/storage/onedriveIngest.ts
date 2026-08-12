/** Import originals placed directly into a property's OneDrive folder. */
import { db, transaction } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { getDriver, getStorageSettings, type StorageObject } from './index.js';
import { PROPERTY_MEDIA_FOLDERS } from './keys.js';

const PROPERTY_BATCH = 5;
const SETTLE_MS = 60_000;

interface PropertyFolder {
  record_id: string;
  folder_key: string;
  created_by: string | null;
}

function settled(item: StorageObject, now = Date.now()): boolean {
  if (!item.lastModifiedAt) return true;
  const changedAt = new Date(item.lastModifiedAt).getTime();
  return !Number.isFinite(changedAt) || changedAt <= now - SETTLE_MS;
}

async function importItem(folder: PropertyFolder, item: StorageObject): Promise<boolean> {
  return transaction(async (tx) => {
    const existing = await tx.queryOne<{ id: string; storage_key: string; source_external_id: string | null }>(
      `SELECT id, storage_key, source_external_id
         FROM ipy_attachment
        WHERE source_external_id = $1 OR (record_id = $2 AND storage_key = $3)
        ORDER BY source_external_id = $1 DESC
        LIMIT 1
        FOR UPDATE`,
      [item.externalId, folder.record_id, item.key],
    );
    if (existing) {
      // A Graph scan can see a CRM upload after the bytes land but before this
      // field was known. Link it to the stable item id rather than duplicating it.
      await tx.query(
        `UPDATE ipy_attachment
            SET source_external_id = COALESCE(source_external_id, $2),
                storage_key = $3, file_name = $4, size = $5, mime_type = $6
          WHERE id = $1`,
        [existing.id, item.externalId, item.key, item.name, item.size, item.mimeType],
      );
      return false;
    }

    const attachment = await tx.queryOne<{ id: string }>(
      `INSERT INTO ipy_attachment
         (record_id, file_name, mime_type, size, storage_key, category, uploaded_by, source_external_id)
       VALUES ($1,$2,$3,$4,$5,'property_original',$6,$7)
       ON CONFLICT (source_external_id) DO NOTHING
       RETURNING id`,
      [folder.record_id, item.name, item.mimeType, item.size, item.key, folder.created_by, item.externalId],
    );
    if (!attachment) return false;
    if (item.mimeType.startsWith('image/') || item.mimeType.startsWith('video/')) {
      await tx.query(`INSERT INTO ipy_media_job (attachment_id) VALUES ($1)`, [attachment.id]);
    }
    return true;
  });
}

export interface OneDriveIngestSummary {
  properties: number;
  discovered: number;
  imported: number;
  failed: number;
}

/**
 * Poll the least-recently checked property folders.
 *
 * A one-minute settle window prevents a browser upload from racing its own DB
 * insert and also avoids trying to process a large phone video while OneDrive
 * is still finalising it.
 */
export async function ingestOneDriveOriginals(limit = PROPERTY_BATCH): Promise<OneDriveIngestSummary> {
  const summary: OneDriveIngestSummary = { properties: 0, discovered: 0, imported: 0, failed: 0 };
  if (getStorageSettings().driver !== 'onedrive') return summary;
  const driver = await getDriver();
  if (!driver.listFolder) return summary;

  const { rows } = await db.query<PropertyFolder>(
    `SELECT ps.record_id, ps.folder_key, r.created_by
       FROM ipy_property_storage ps
       JOIN ipy_record r ON r.id = ps.record_id
      WHERE ps.status = 'ready'
        AND ps.provisioned_driver = 'onedrive'
        AND ps.folder_key IS NOT NULL
        AND r.is_deleted = false
      ORDER BY ps.last_scanned_at ASC NULLS FIRST, ps.updated_at DESC
      LIMIT $1`,
    [limit],
  );

  for (const folder of rows) {
    summary.properties += 1;
    try {
      const items = await driver.listFolder(`${folder.folder_key}/${PROPERTY_MEDIA_FOLDERS.originals}`);
      const ready = items.filter((item) => settled(item));
      summary.discovered += ready.length;
      for (const item of ready) {
        if (await importItem(folder, item)) summary.imported += 1;
      }
      await db.query(
        `UPDATE ipy_property_storage
            SET last_scanned_at = now(), last_scan_error = NULL, updated_at = now()
          WHERE record_id = $1`,
        [folder.record_id],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.query(
        `UPDATE ipy_property_storage
            SET last_scanned_at = now(), last_scan_error = $2, updated_at = now()
          WHERE record_id = $1`,
        [folder.record_id, message.slice(0, 1000)],
      );
      logger.error({ err, recordId: folder.record_id }, 'OneDrive originals scan failed');
      summary.failed += 1;
    }
  }

  if (summary.imported) logger.info(summary, 'imported new OneDrive property originals');
  return summary;
}
