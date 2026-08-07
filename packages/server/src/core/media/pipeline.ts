/**
 * Entry point the scheduler's media queue (core/workflow/scheduler.ts,
 * drainMediaQueue) calls per job. Owns nothing about claiming/retries —
 * just: load the attachment, dispatch by mime type, persist whatever
 * derivatives came back. Throwing here is a real failure the queue should
 * retry; returning normally with no variants recorded is a deliberate
 * no-op (wrong mime type, decode unsupported, etc.), not an error.
 */
import { db } from '../../db/pool.js';
import { getDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import { processImage } from './images.js';
import { processVideo } from './video.js';

interface AttachmentRow {
  id: string;
  mime_type: string;
  storage_key: string;
}

export async function processAttachment(attachmentId: string): Promise<void> {
  const attachment = await db.queryOne<AttachmentRow>(
    `SELECT id, mime_type, storage_key FROM ipy_attachment WHERE id = $1`,
    [attachmentId],
  );
  if (!attachment) return; // deleted before the job ran — nothing to do

  const isImage = attachment.mime_type.startsWith('image/');
  const isVideo = attachment.mime_type.startsWith('video/');
  if (!isImage && !isVideo) return; // documents etc. — never had derivatives to make

  const driver = await getDriver();
  const original = await driver.read(attachment.storage_key);
  if (!original) {
    logger.warn({ attachmentId }, 'media job: original missing from storage, skipping');
    return;
  }

  const variants = isImage
    ? await processImage(driver, attachment.id, attachment.storage_key, original)
    : await processVideo(driver, attachment.id, attachment.storage_key, original);

  if (variants) {
    await db.query(`UPDATE ipy_attachment SET variants = $2::jsonb WHERE id = $1`, [attachment.id, JSON.stringify(variants)]);
  }
}
