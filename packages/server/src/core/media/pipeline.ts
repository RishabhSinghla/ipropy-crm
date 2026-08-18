/**
 * Entry point the scheduler's media queue (core/workflow/scheduler.ts,
 * drainMediaQueue) calls per job. Owns nothing about claiming/retries —
 * just: load the attachment, dispatch by mime type, persist whatever
 * derivatives came back. Throwing here is a real failure the queue should
 * retry; returning normally with no variants recorded is a deliberate
 * no-op (wrong mime type, decode unsupported, etc.), not an error.
 */
import { db } from '../../db/pool.js';
import { formatIndianPrice } from '@ipropy/shared';
import { getDriver } from '../storage/index.js';
import { logger } from '../../utils/logger.js';
import { processImage } from './images.js';
import { needsTranscode, transcodeToJpeg } from './transcode.js';
import { processVideo } from './video.js';

interface AttachmentRow {
  id: string;
  mime_type: string;
  storage_key: string;
  record_id: string | null;
}

async function isPropertyAttachment(attachmentId: string): Promise<boolean> {
  const owner = await db.queryOne<{ module_name: string | null }>(
    `SELECT r.module_name
       FROM ipy_attachment a
       LEFT JOIN ipy_record r ON r.id = a.record_id
      WHERE a.id = $1`,
    [attachmentId],
  );
  return owner?.module_name === 'properties';
}

export async function processAttachment(attachmentId: string): Promise<void> {
  const attachment = await db.queryOne<AttachmentRow>(
    `SELECT id, mime_type, storage_key, record_id FROM ipy_attachment WHERE id = $1`,
    [attachmentId],
  );
  if (!attachment) return; // deleted before the job ran — nothing to do

  const isImage = attachment.mime_type.startsWith('image/');
  const isVideo = attachment.mime_type.startsWith('video/');
  if (!isImage && !isVideo) return; // documents etc. — never had derivatives to make

  const driver = await getDriver();

  let variants: Record<string, string> | null;
  if (isImage) {
    const original = await driver.read(attachment.storage_key);
    if (!original) {
      logger.warn({ attachmentId }, 'media job: original missing from storage, skipping');
      return;
    }
    // Most iPhones shoot HEIC. The original is retained byte-for-byte; ffmpeg
    // supplies only a temporary decoded frame because Sharp's common libvips
    // build cannot decode HEVC pixels even when it recognises the container.
    const pixelSource = needsTranscode(attachment.mime_type)
      ? await transcodeToJpeg(original, attachment.id)
      : original;
    variants = pixelSource
      ? await processImage(
        driver,
        attachment.id,
        attachment.storage_key,
        pixelSource,
        await isPropertyAttachment(attachment.id) ? 'property' : 'standard',
      )
      : null;
  } else {
    // Video never gets buffered into memory (a phone clip can be well over a
    // GB) — ffmpeg operates on a real file path via readToTempFile instead.
    const input = await driver.readToTempFile(attachment.storage_key);
    if (!input) {
      logger.warn({ attachmentId }, 'media job: original missing from storage, skipping');
      return;
    }
    try {
      variants = await processVideo(driver, attachment.id, attachment.storage_key, input.path);
    } finally {
      await input.cleanup();
    }
  }

  if (variants) {
    await db.query(`UPDATE ipy_attachment SET variants = $2::jsonb WHERE id = $1`, [attachment.id, JSON.stringify(variants)]);
  }
}

